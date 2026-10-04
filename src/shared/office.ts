import type { OfficeZone, Preferences, Session, Artifact } from './types';
import { branchInfo } from './branch';

export const sessionName = (s: Session) =>
  (s.resident?.name || s.alias || s.title || '이름 없는 세션').replace(/\s+/g, ' ').trim();
export const seatKey = (s: Session) => (s.actor ? `actor:${s.actor.id}` : s.id);
export const projectKey = (s: Session) =>
  (s.workspace?.evidence !== 'unknown' && s.workspace?.key) || s.cwd || `unknown:${s.id}`;
// A shared bench needs a branch/commit and worktree identity. Project zones do not.
export const benchKey = (s: Session) => {
  const branch = branchInfo(s);
  return branch.key
    ? `${projectKey(s)}::${s.workspace?.worktree ?? s.cwd ?? ''}::${branch.key}`
    : `${projectKey(s)}::unknown:${s.id}`;
};
export function parentSession(s: Session, sessions: Session[]): Session | undefined {
  if (s.relation?.parentSessionKey) {
    const exact = sessions.filter(
      (p) =>
        p.id !== s.id && p.provider === s.provider && p.sessionKey === s.relation?.parentSessionKey,
    );
    if (exact.length === 1) return exact[0];
  }
  const id = s.relation?.parentNativeId ?? s.parentId;
  if (!id) return;
  return sessions.find(
    (p) =>
      p.id !== s.id &&
      p.provider === s.provider &&
      (p.nativeId === id || p.id === id) &&
      (s.provider !== 'openclaw' || p.agentName === s.agentName),
  );
}
export function attachSessions(sessions: Session[]): Session[] {
  return sessions.map((s) => {
    if (s.resident || s.actor) return { ...s, attachedTo: undefined };
    let current = s;
    const visited = new Set([s.id]);
    let parent: Session | undefined;
    while (['subagent', 'child'].includes(current.relation?.kind ?? '')) {
      const next = parentSession(current, sessions);
      if (!next || visited.has(next.id)) {
        parent = undefined;
        break;
      }
      visited.add(next.id);
      parent = next;
      current = next;
    }
    const attached = parent && parent.zone === 'office' && s.zone === 'office';
    return {
      ...s,
      attachedTo: attached ? parent!.id : undefined,
      officeSeat: attached ? parent!.officeSeat : s.officeSeat,
    };
  });
}
export function officeZone(
  s: Session,
  prefs: Pick<Preferences, 'standbyHours' | 'archiveDays'>,
  now = Date.now(),
): OfficeZone {
  if (s.archived) return 'archive';
  if (s.pinned) return 'office';
  const age = now - Math.max(s.updatedAt, s.returnedAt || 0);
  if (age >= (prefs.archiveDays ?? 7) * 86400_000) return 'archive';
  if (age >= (prefs.standbyHours ?? 4) * 3600_000) return 'waiting';
  return 'office';
}

// Stable order tokens, not physical coordinates or six-seat floors. The scene packs
// project groups independently, so old sparse tokens never create empty furniture.
export function allocateSeats(
  sessions: Session[],
  previous: Record<string, number>,
): Record<string, number> {
  const primary = attachSessions(sessions).filter((s) => !s.attachedTo);
  const result: Record<string, number> = {};
  const used = new Set<number>();
  for (const s of primary) {
    const order = previous[seatKey(s)] ?? previous[s.id];
    if (Number.isInteger(order) && order >= 0 && order < 6000 && !used.has(order)) {
      result[seatKey(s)] = order;
      used.add(order);
    }
  }
  const pending = primary
    .filter((s) => result[seatKey(s)] === undefined)
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id),
    );
  for (const project of [...new Set(pending.map(projectKey))]) {
    for (const s of pending.filter((s) => projectKey(s) === project)) {
      let order = 0;
      while (used.has(order)) order++;
      result[seatKey(s)] = order;
      used.add(order);
    }
  }
  return result;
}
export function parseArtifact(url: string): Artifact | null {
  const match =
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)(?:[?#][^\s]*)?$/.exec(url);
  if (!match) return null;
  return {
    url: `https://github.com/${match[1]}/${match[2]}/${match[3]}`,
    repo: match[1],
    kind: match[2] as Artifact['kind'],
    number: Number(match[3]),
  };
}
