import type { Session } from './types';
import { attachSessions, parentSession } from './office';
import { isWorking } from './presentation';
import { taskStart } from './lifecycle';

export const isHelper = (s: Session) => ['subagent', 'child'].includes(s.relation?.kind ?? '');
export const isBackground = (s: Session) =>
  ['scheduled', 'internal'].includes(s.origin?.kind ?? '');
export const needsAttention = (s: Session) => !s.archived && ['call', 'error'].includes(s.status);

/** Retain a helper's result for its parent's current task, independent of silence duration. */
export function helperPresence(s: Session, sessions: Session[], now = Date.now()) {
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
    // A resumed helper gets a newer own task anchor. Late results alone cannot revive it.
    if ((taskStart(parent) ?? 0) > anchor || parent.archived || parent.zone === 'archive')
      return { visible: false };
    host = parent;
    current = parent;
  }
  // Unknown relationships are not grounds for disappearing a recently observed helper.
  return { visible: (host?.zone ?? s.zone) === 'office' || (!host?.zone && !s.zone), host };
}
export const sessionScopeLabel = (s: Session) =>
  s.origin?.kind === 'scheduled'
    ? '자동 실행'
    : s.origin?.kind === 'internal'
      ? '내부 보조'
      : isHelper(s)
        ? '보조 작업'
        : '대화';

/** Canonical sessions remain intact in the store/MCP. Only office occupancy is projected. */
export function officeResidents(sessions: Session[], now = Date.now()) {
  const actors = new Map<string, Session[]>();
  const residents: Session[] = [],
    hidden: Session[] = [];
  for (const s of sessions) {
    if (s.actor) {
      actors.set(s.actor.id, [...(actors.get(s.actor.id) ?? []), s]);
    } else {
      const presence = isHelper(s)
        ? helperPresence(s, sessions, now)
        : { visible: true, host: undefined };
      if (!s.pinned && (isBackground(s) ? !needsAttention(s) : !presence.visible)) hidden.push(s);
      else residents.push(presence.host ? { ...s, zone: presence.host.zone } : s);
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
      zone:
        pinned && !current.archived && current.zone === 'waiting'
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
  return { sessions: attachSessions(residents), hidden };
}
