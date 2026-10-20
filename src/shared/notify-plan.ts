import type { NotifyPreferences, OfficeNotice, Preferences, Snapshot } from './types';
import { PROVIDERS } from './types';
import { isAttentionNotice, isFinalNotice } from './notices';
import { isRemoteId } from './federation';
import { messageExcerpt } from './activity';
import { buildOfficeModel } from './office-model';
import { sessionName } from './office';
import { m } from './i18n';

/**
 * OS notifications (#229): what to show when a colleague's final reply, a call or an error
 * arrives. Pure, so the main process only shows what this decides.
 *
 * By default only calls (and errors) notify, silently: a call means someone is stuck waiting on
 * the person, while finals arrive all day and would quickly become noise.
 */
export const DEFAULT_NOTIFY: NotifyPreferences = { finals: false, calls: true, sound: false };
export const notifyPreferences = (p?: Pick<Preferences, 'notifications'> | null) => ({
  ...DEFAULT_NOTIFY,
  ...p?.notifications,
});

export type NotifyKind = 'final' | 'call' | 'error';
/** One notification to show. `sessionId` is what a click opens (none: just the office). */
export interface NotifyItem {
  key: string;
  kind: NotifyKind | 'summary';
  title: string;
  body: string;
  sessionId?: string;
  silent: boolean;
  /** How many notices it stands for, and how many of them are finals. */
  count: number;
  finals: number;
  /** The notice it is about, so a held one can be checked again before it shows. */
  noticeId?: string;
  /** A summary's notifications, so a held summary can be checked again member by member. */
  members?: NotifyItem[];
}
/** Who a notice is from: its colleague's name, and every id that colleague's card shows. */
export interface Colleague {
  name: string;
  provider: string;
  ids: string[];
}
/** Where the person is looking: a notice about a colleague in front of them is not news. */
export interface NotifyFocus {
  /** The big office window is focused; `selected` is the colleague card open in it. */
  mainFocused: boolean;
  selected: string | null;
  /** Colleagues whose dock card window is on screen. */
  cards: string[];
}
/** A notice older than this when first seen is history (a long-unread one paged back in). */
export const NOTIFY_FRESH_MS = 2 * 60_000;
const kindOf = (n: OfficeNotice): NotifyKind | null =>
  isAttentionNotice(n)
    ? n.kind === 'error'
      ? 'error'
      : 'call'
    : isFinalNotice(n)
      ? 'final'
      : null;
/**
 * What makes a notice "the same news". A final reply is one piece of news however its text
 * grows: its version comes from its content, so a reply first collected half-written and then
 * completed would otherwise notify twice. A call or an error keeps id@version: the same notice
 * raised again with new content (a fresh question, the same permission asked again after being
 * handled) means someone is waiting on the person again, which is worth another alert.
 * Notices that are neither (yet) keep id@version too, so one that turns into a final is new.
 */
const key = (n: OfficeNotice) => (kindOf(n) === 'final' ? `final:${n.id}` : `${n.id}@${n.version}`);

/** What a notice is checked against: the office and settings now, and where the person looks. */
export interface NotifyContext {
  notices: OfficeNotice[];
  prefs: Preferences;
  colleague: (sessionId: string) => Colleague | undefined;
  focus: NotifyFocus;
  now: number;
}
export interface NotifyPlanInput extends NotifyContext {
  /** Notice keys already seen; null while only priming (the first snapshot, startup). */
  seen: ReadonlySet<string> | null;
}
/** The notification for one notice as things stand, or none if it is not (or no longer) news. */
function notifyItem(n: OfficeNotice, ctx: NotifyContext): NotifyItem | null {
  const { prefs, colleague, focus, now } = ctx;
  const want = notifyPreferences(prefs);
  const kind = kindOf(n);
  if (!kind || (kind === 'final' ? !want.finals : !want.calls)) return null;
  // Old news, already read, viewed or put away, a helper's or a scheduled run's final, or
  // another office's (read-only here) news never notifies.
  if (n.bootstrap || n.seenAt || n.viewedAt || n.dismissedAt || n.resolvedAt) return null;
  if (now - n.receivedAt > NOTIFY_FRESH_MS) return null;
  if (kind === 'final' && n.background) return null;
  if (isRemoteId(n.id) || isRemoteId(n.sessionId)) return null;
  const who = colleague(n.sessionId);
  if (!who) return null;
  const ids = new Set(who.ids);
  if (
    (focus.mainFocused && focus.selected && ids.has(focus.selected)) ||
    focus.cards.some((id) => ids.has(id))
  )
    return null;
  const t = m().desktop.notify;
  const excerpt = kind === 'final' && !prefs.privacy ? messageExcerpt(n.text, 100) : '';
  return {
    key: key(n),
    kind,
    title: prefs.privacy ? who.provider : who.name,
    body: excerpt || (kind === 'final' ? t.final : kind === 'error' ? t.error : t.call),
    sessionId: n.sessionId,
    silent: !want.sound,
    count: 1,
    finals: kind === 'final' ? 1 : 0,
    noticeId: n.id,
  };
}
/**
 * The notices new since the last snapshot that should notify, and the keys seen now. Only the
 * keys still carried are kept, so the set stays as small as the snapshot's notices.
 */
export function planNotifications(input: NotifyPlanInput): {
  seen: Set<string>;
  items: NotifyItem[];
} {
  const seen = new Set(input.notices.map(key));
  if (!input.seen) return { seen, items: [] };
  const items: NotifyItem[] = [];
  for (const n of [...input.notices].sort((a, b) => a.at - b.at)) {
    if (input.seen.has(key(n))) continue;
    const item = notifyItem(n, input);
    if (item) items.push(item);
  }
  return { seen, items };
}
/**
 * Held notifications checked again right before they show, against the office and settings
 * now: notifications turned off, the notice read, viewed, put away or handled meanwhile, or its
 * colleague now in front of the person drops it; hidden screen content turned on redacts it
 * (title and body are rebuilt from the current settings). A notice no longer carried is dropped
 * too: the snapshot carries every open call and unread final, so a missing one was handled.
 */
export function revalidateNotifications(items: NotifyItem[], ctx: NotifyContext): NotifyItem[] {
  const byId = new Map(ctx.notices.map((n) => [n.id, n]));
  return items
    .flatMap((i) => i.members ?? [i])
    .flatMap((i) => {
      const n = i.noticeId ? byId.get(i.noticeId) : undefined;
      const next = n && notifyItem(n, ctx);
      return next ? [next] : [];
    });
}

/** Startup: news already waiting is history, not something that just arrived. */
export const NOTIFY_GRACE_MS = 30_000;
/**
 * Whether notifications may start after the app opens. Until then every snapshot only primes
 * the seen set, so the backlog the first collection pass brings in (its notices look fresh: the
 * collector stamps `receivedAt` when it reads them) never bursts out. The signal is the
 * snapshot's own `lastSync`: the first full pass that finished after the app started. A
 * collector that never finishes one still starts notifying `NOTIFY_GRACE_MS` after the first
 * snapshot.
 */
export const notifyReady = (
  snapshot: Pick<Snapshot, 'syncing' | 'lastSync'>,
  startedAt: number,
  firstAt: number,
  now: number,
) =>
  (!snapshot.syncing && snapshot.lastSync !== null && snapshot.lastSync >= startedAt) ||
  now - firstAt >= NOTIFY_GRACE_MS;

/** Recently shown notifications, and the ones held back until the burst window ends. */
export interface NotifyThrottle {
  shown: number[];
  held: NotifyItem[];
}
export const NOTIFY_BURST = { limit: 3, windowMs: 5000 };
const summary = (all: NotifyItem[]): NotifyItem => {
  const items = all.flatMap((i) => i.members ?? [i]);
  const sessions = new Set(items.map((i) => i.sessionId));
  const count = items.reduce((n, i) => n + i.count, 0);
  const finals = items.reduce((n, i) => n + i.finals, 0);
  return {
    key: `summary:${items.map((i) => i.key).join(',')}`,
    kind: 'summary',
    title: m().desktop.notify.summaryTitle,
    body: m().desktop.notify.summary(count, finals),
    sessionId: sessions.size === 1 ? items[0].sessionId : undefined,
    silent: items.every((i) => i.silent),
    count,
    finals,
    members: items,
  };
};
/**
 * At most `limit` notifications in any `windowMs`: a batch bigger than that becomes one summary
 * at once; anything over the limit within the window is held and later shown as one summary
 * (`flushNotifications` at `flushAt`).
 */
export function throttleNotifications(
  state: NotifyThrottle,
  items: NotifyItem[],
  now: number,
  { limit, windowMs } = NOTIFY_BURST,
): { state: NotifyThrottle; show: NotifyItem[]; flushAt?: number } {
  const shown = state.shown.filter((at) => now - at < windowMs);
  const held = [...state.held];
  const show: NotifyItem[] = [];
  const batch = items.length > limit ? [summary(items)] : items;
  for (const item of batch) {
    if (!held.length && shown.length < limit) {
      shown.push(now);
      show.push(item);
    } else held.push(item);
  }
  return {
    state: { shown, held },
    show,
    flushAt: held.length ? Math.max(now, (shown[0] ?? now) + windowMs) : undefined,
  };
}
/**
 * The burst window ended: whatever was held, as one notification. `revalidate` checks the held
 * ones against the office now (`revalidateNotifications`); what is left of a summary is
 * summarized again.
 */
export function flushNotifications(
  state: NotifyThrottle,
  now: number,
  revalidate: (items: NotifyItem[]) => NotifyItem[] = (items) =>
    items.flatMap((i) => i.members ?? [i]),
): { state: NotifyThrottle; show: NotifyItem[] } {
  if (!state.held.length) return { state, show: [] };
  const held = revalidate(state.held);
  const cleared = { ...state, held: [] };
  if (!held.length) return { state: cleared, show: [] };
  const one = held.length === 1 ? held[0] : summary(held);
  return { state: { shown: [...state.shown, now], held: [] }, show: [one] };
}

/** Each colleague by any of its sessions, read from the same office model the windows draw. */
export function colleagueResolver(snapshot: Snapshot, now = Date.now()) {
  let model: ReturnType<typeof buildOfficeModel> | undefined;
  return (sessionId: string): Colleague | undefined => {
    model ??= buildOfficeModel(snapshot, now);
    const view = model.view(sessionId);
    const s = view?.session ?? snapshot.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const ids = [sessionId, s.id, ...(s.resident?.sessionIds ?? [])];
    // A helper also shows on its host's card.
    if (s.attachedTo)
      ids.push(s.attachedTo, ...(model.view(s.attachedTo)?.session.resident?.sessionIds ?? []));
    return { name: sessionName(s), provider: PROVIDERS[s.provider]?.short ?? s.provider, ids };
  };
}
