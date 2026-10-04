import type { Session } from './types';
import { attachSessions } from './office';
import { isWorking } from './presentation';

export const isHelper = (s: Session) => ['subagent', 'child'].includes(s.relation?.kind ?? '');
export const isBackground = (s: Session) =>
  ['scheduled', 'internal'].includes(s.origin?.kind ?? '');
export const needsAttention = (s: Session) => !s.archived && ['call', 'error'].includes(s.status);
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
    } else if (
      !s.pinned &&
      (isBackground(s)
        ? !needsAttention(s)
        : isHelper(s) && !isWorking(s, now) && !needsAttention(s))
    ) {
      hidden.push(s);
    } else residents.push(s);
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
    residents.push({
      ...current,
      attachedTo: undefined,
      zone:
        !isWorking(current, now) &&
        !needsAttention(current) &&
        !current.pinned &&
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
