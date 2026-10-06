import type { OfficeNotice, OfficeZone, Session, Snapshot } from './types';
import { officeResidents } from './residents';
import { officeZone, sessionName } from './office';
import { presentSession } from './presentation';
import { TRIAGE_ORDER, triageGroup, unreadInbox, type TriageGroup } from './triage';
import { isInboxNotice, unreadNoticeCount } from './notices';
import { activityLabel, sessionActivity } from './activity';
import { isVeiled } from './veil';

/**
 * One derived read model shared by every presentation (big office, desk pet, desk row).
 * Views only decide how to draw it; projection, zones, seats, triage and news live here.
 */
export const ZONES: OfficeZone[] = ['office', 'waiting', 'archive'];

export interface ResidentView {
  session: Session;
  zone: OfficeZone;
  pose: ReturnType<typeof presentSession>;
  group: TriageGroup;
  /** Unread important news from this colleague's own runs (roster/inbox badge). */
  unread: OfficeNotice[];
  /** Unread important news left by helper desks attached to this colleague. */
  helperUnread: OfficeNotice[];
  /** Helper desks attached to this colleague (empty for helpers themselves). */
  helpers: ResidentView[];
  /** Hidden by the person until the next conversation (helpers follow their host). */
  veiled: boolean;
}

export interface OfficeModel {
  now: number;
  notices: OfficeNotice[];
  /** How long a notice bubble stays on a desk (preference, default 3h). */
  bubbleHours: number;
  residents: Session[];
  hidden: Session[];
  /** Residents per zone, in projection order. */
  zones: Record<OfficeZone, Session[]>;
  /** Office residents (including attached helpers) in seat order. */
  bySeat: Session[];
  /** Primary office colleagues in seat order (all of them, for lists and counts). */
  seats: ResidentView[];
  /** What the scenes draw: office residents in seat order minus hidden ones. */
  scene: Session[];
  /** Primary colleagues the person hid, in seat order (to bring them back). */
  veiled: ResidentView[];
  /** Shown office colleagues per triage group, helpers included (same as the roster). */
  counts: Record<TriageGroup, number>;
  /** Important unread news across the whole office (header/inbox number). */
  unread: number;
  /** The colleague that most needs the person right now. */
  lead: ResidentView | undefined;
  view: (id: string) => ResidentView | undefined;
  ownerOf: (id: string) => Session | undefined;
}

const seatOrder = (a: Session, b: Session) => (a.officeSeat ?? 0) - (b.officeSeat ?? 0);

export function buildOfficeModel(snapshot: Snapshot | null, now = Date.now()): OfficeModel {
  const sessions = snapshot?.sessions ?? [];
  const prefs = snapshot?.preferences ?? {};
  const notices = snapshot?.notices ?? [];
  const { sessions: residents, hidden } = officeResidents(sessions, now);
  const zoneOf = (s: Session) => s.zone || officeZone(s, prefs, now);
  const zones = Object.fromEntries(
    ZONES.map((z) => [z, residents.filter((s) => zoneOf(s) === z)]),
  ) as Record<OfficeZone, Session[]>;
  const bySeat = [...zones.office].sort(seatOrder);
  // One pass over the news: important unread notices per session, newest first.
  const unreadBy = new Map<string, OfficeNotice[]>();
  for (const n of [...notices].sort((a, b) => b.at - a.at))
    if (!n.seenAt && isInboxNotice(n))
      unreadBy.set(n.sessionId, [...(unreadBy.get(n.sessionId) ?? []), n]);
  const unreadOf = (ids: string[]) =>
    ids.flatMap((id) => unreadBy.get(id) ?? []).sort((a, b) => b.at - a.at);
  const canonical = new Map(sessions.map((s) => [s.id, s]));
  const views = residents.map((s): ResidentView => {
    const ids = s.resident?.sessionIds ?? [s.id];
    const unread = unreadOf(ids);
    const group = triageGroup(s, notices, now, unread);
    return {
      session: s,
      zone: zoneOf(s),
      pose: presentSession(s, now),
      group,
      unread,
      helperUnread: [],
      helpers: [],
      // Anyone who needs the person is never hidden.
      veiled:
        group !== 'attention' &&
        isVeiled(
          ids.map((id) => canonical.get(id) ?? s),
          notices,
        ),
    };
  });
  const byId = new Map(views.map((v) => [v.session.id, v]));
  for (const v of views) {
    const host = v.session.attachedTo && byId.get(v.session.attachedTo);
    if (!host) continue;
    host.helpers.push(v);
    host.helperUnread.push(...v.unread);
  }
  for (const host of views) {
    if (host.helpers.some((h) => h.group === 'attention')) host.veiled = false;
    for (const h of host.helpers) h.veiled = host.veiled;
  }
  const byMember = new Map<string, ResidentView>();
  for (const v of views)
    for (const id of v.session.resident?.sessionIds ?? [v.session.id])
      if (!byMember.has(id)) byMember.set(id, v);
  const seats = bySeat.filter((s) => !s.attachedTo).map((s) => byId.get(s.id)!);
  // Helpers count on their own (like the roster) and follow their host's seat for the lead.
  const desks = seats.filter((v) => !v.veiled).flatMap((v) => [v, ...v.helpers]);
  const counts = Object.fromEntries(
    TRIAGE_ORDER.map((g) => [g, desks.filter((v) => v.group === g).length]),
  ) as Record<TriageGroup, number>;
  const rank = (v: ResidentView) => TRIAGE_ORDER.indexOf(v.group);
  const lead = desks.reduce<ResidentView | undefined>(
    (best, v) => (!best || rank(v) < rank(best) ? v : best),
    undefined,
  );
  const view = (id: string) => byId.get(id) ?? byMember.get(id);
  return {
    now,
    notices,
    bubbleHours: snapshot?.preferences.bubbleHours ?? 3,
    residents,
    hidden,
    zones,
    bySeat,
    seats,
    scene: bySeat.filter((s) => !byId.get(s.id)?.veiled),
    veiled: seats.filter((v) => v.veiled),
    counts,
    unread: unreadNoticeCount(notices),
    lead,
    view,
    ownerOf: (id) => view(id)?.session,
  };
}

/** The single place where names/projects are masked for screen sharing. */
export function residentLabel(s: Session, privacy: boolean) {
  return {
    name: privacy ? s.provider : sessionName(s),
    project: privacy ? '프로젝트' : s.project,
    detail: privacy ? undefined : `${activityLabel(s)} · ${sessionActivity(s).text}`,
  };
}

export const hasNews = (v: ResidentView) => v.unread.length + v.helperUnread.length > 0;

export const PET_LABELS: Record<TriageGroup, string> = {
  attention: '기다려요',
  results: '새 소식',
  working: '일하는 중',
  resting: '쉬는 중',
};

/** How long a just-arrived result or question takes over the collapsed pet. */
export const PET_FRESH_MS = 2 * 60_000;

/**
 * What the tiny pet says: the most urgent group and how many colleagues are in it. When an
 * important notice (final reply, question, error) has just arrived, its colleague becomes the
 * pet for a moment so it can speak.
 */
export function petSummary(model: OfficeModel) {
  const group = TRIAGE_ORDER.find((g) => g !== 'resting' && model.counts[g]) ?? 'resting';
  const count =
    group === 'resting' ? model.seats.length - model.veiled.length : model.counts[group];
  const fresh = (n: OfficeNotice) =>
    !n.bootstrap && !n.dismissedAt && model.now - n.receivedAt < PET_FRESH_MS;
  let speaker: { view: ResidentView; notice: OfficeNotice } | undefined;
  for (const seat of model.seats)
    if (!seat.veiled)
      for (const v of [seat, ...seat.helpers]) {
        const notice = v.unread.find(fresh);
        if (notice && (!speaker || notice.receivedAt > speaker.notice.receivedAt))
          speaker = { view: v, notice };
      }
  return {
    group,
    count,
    lead: speaker?.view ?? model.lead,
    speaker,
    label: PET_LABELS[group],
    calling: model.counts.attention > 0,
  };
}
