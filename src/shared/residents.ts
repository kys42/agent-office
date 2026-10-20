import type { Session } from './types';
import { attachSessions, parentSession } from './office';
import { isWorking } from './presentation';
import { taskStart } from './lifecycle';
import { m } from './i18n';

export const isHelper = (s: Session) => ['subagent', 'child'].includes(s.relation?.kind ?? '');
export const isBackground = (s: Session) =>
  ['scheduled', 'internal'].includes(s.origin?.kind ?? '');
export const needsAttention = (s: Session) =>
  !s.remote?.stale && !s.archived && ['call', 'error'].includes(s.status);

/**
 * How long a helper may stay silent mid-task before it counts as gone. Beyond the record-based
 * ends below, a helper can stop without a closing record: its process killed or crashed (the last
 * tool call stays), or a reply cut short (max_tokens, an API error: the last reply stays). The
 * standing-by window (30 minutes) is long enough for a slow test run, short enough that such a
 * leftover does not hold a desk for long.
 */
export const HELPER_UNFINISHED_MS = 30 * 60_000;
/** The person's choice (the `helperRetainMinutes` preference, see view-prefs), in ms. */
export interface ResidentOptions {
  unfinishedMs?: number;
}
/**
 * Still inside its own task, judged by the last observed record alone (observedStatus, the raw
 * status before the time ladder turns quiet work into ready/idle): a tool call or tool result
 * ('work') or a reply on the way ('think'), with no final answer ('done'), stop by the person
 * (aborted turn: 'idle') or question/error after it. A long tool writes nothing for minutes, so
 * this outlasts isWorking's quiet window, up to HELPER_UNFINISHED_MS.
 *
 * Not used: "the parent is resting, so a quiet helper must be done". A background helper keeps
 * running while its parent answers and rests, so that would retire the very helper this keeps.
 */
export function helperUnfinished(
  s: Session,
  now = Date.now(),
  unfinishedMs: number = HELPER_UNFINISHED_MS,
) {
  if (s.remote?.stale || s.archived) return false;
  return (
    ['work', 'think'].includes(s.observedStatus ?? s.status) && now - s.updatedAt <= unfinishedMs
  );
}

/**
 * Retain a helper's result for its parent's current task, independent of silence duration.
 * `host` is the top visible session of its chain; officeResidents attaches the helper there even
 * when a finished helper between them has retired.
 */
export function helperPresence(
  s: Session,
  sessions: Session[],
  now = Date.now(),
  { unfinishedMs }: ResidentOptions = {},
) {
  if (s.pinned || isWorking(s, now) || needsAttention(s)) return { visible: true };
  if (s.archived) return { visible: false };
  const anchor = taskStart(s) ?? s.startedAt;
  const visited = new Set([s.id]);
  let current = s,
    host: Session | undefined;
  while (isHelper(current)) {
    const parent = parentSession(current, sessions);
    if (!parent || visited.has(parent.id)) break;
    visited.add(parent.id);
    if (parent.archived || parent.zone === 'archive') return { visible: false };
    // A resumed helper gets a newer own task anchor. Late results alone cannot revive it; only
    // an unfinished helper keeps its desk through an ancestor's newer request.
    if ((taskStart(parent) ?? 0) > anchor && !helperUnfinished(s, now, unfinishedMs))
      return { visible: false };
    host = parent;
    current = parent;
  }
  // Unknown relationships are not grounds for disappearing a recently observed helper. The zone
  // is the host's: a parent sent to waiting takes even an unfinished helper off the floor, as
  // before (a helper desk lives only beside an office desk).
  return { visible: (host?.zone ?? s.zone) === 'office' || (!host?.zone && !s.zone), host };
}
export const sessionScopeLabel = (s: Session) => {
  const t = m().shared.residents;
  return s.origin?.kind === 'scheduled'
    ? t.scheduled
    : s.origin?.kind === 'internal'
      ? t.internal
      : isHelper(s)
        ? t.helper
        : t.conversation;
};

/** Canonical sessions remain intact in the store/MCP. Only office occupancy is projected. */
export function officeResidents(
  sessions: Session[],
  now = Date.now(),
  options: ResidentOptions = {},
) {
  const actors = new Map<string, Session[]>();
  const residents: Session[] = [],
    hidden: Session[] = [];
  // Helper → its host, resolved over all sessions: the chain may run through a retired helper.
  const hosts = new Map<string, string>();
  for (const s of sessions) {
    if (s.actor) {
      actors.set(s.actor.id, [...(actors.get(s.actor.id) ?? []), s]);
    } else {
      const presence = isHelper(s)
        ? helperPresence(s, sessions, now, options)
        : { visible: true, host: undefined };
      if (!s.pinned && (isBackground(s) ? !needsAttention(s) : !presence.visible)) hidden.push(s);
      else {
        residents.push(presence.host ? { ...s, zone: presence.host.zone } : s);
        // Only a chain that reached its main session; a partly collected one attaches as before.
        if (presence.host && !isHelper(presence.host)) hosts.set(s.id, presence.host.id);
      }
    }
  }
  for (const group of actors.values()) {
    const ordered = [...group].sort((a, b) => {
      const rank = (s: Session) =>
        needsAttention(s)
          ? 0
          : isWorking(s, now)
            ? 1
            : s.pinned
              ? 2
              : !s.archived && !isBackground(s) && !isHelper(s)
                ? 3
                : !s.archived
                  ? 4
                  : 5;
      return rank(a) - rank(b) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
    });
    const current = ordered[0];
    const seats = group.flatMap((s) => (s.officeSeat === undefined ? [] : [s.officeSeat]));
    // Pinning belongs to the colleague, not to whichever run speaks for it right now.
    const pinned = group.some((s) => s.pinned);
    residents.push({
      ...current,
      pinned,
      attachedTo: undefined,
      // As for a single session (officeZone): pinned stays in the office whatever the age,
      // only a manual archive takes it out.
      zone:
        pinned && !current.archived
          ? 'office'
          : !isWorking(current, now) &&
              !needsAttention(current) &&
              !pinned &&
              !current.returnedAt &&
              isBackground(current) &&
              current.zone === 'office'
            ? 'waiting'
            : current.zone,
      officeSeat: seats.length ? Math.min(...seats) : undefined,
      resident: {
        key: `actor:${current.actor!.id}`,
        name: current.actor!.name,
        sessionIds: ordered.map((s) => s.id),
        activeCount: group.filter((s) => isWorking(s, now)).length,
        backgroundCount: group.filter(isBackground).length,
      },
    });
  }
  return { sessions: attachSessions(residents, hosts), hidden };
}
