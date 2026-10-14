import type { Session, WorkspaceIdentity } from './types';

/**
 * A transient Git read can leave a path-only record beside verified peers in the exact same
 * worktree. Recover its repository identity from those peers, never from a display name or a
 * folder prefix. Do not borrow their branch, commit or recorded working-location evidence.
 */
export function workspaceProof(sessions: Session[]) {
  const known = new Map<string, WorkspaceIdentity | null>();
  for (const s of sessions) {
    const w = s.workspace;
    if (w?.evidence !== 'git-common-dir' || !w.worktree || !w.root) continue;
    const previous = known.get(w.worktree);
    known.set(w.worktree, previous === null || (previous && previous.key !== w.key) ? null : w);
  }
  return known;
}
export function recoverWorkspace(s: Session, peer: WorkspaceIdentity | null | undefined): Session {
  const w = s.workspace;
  if (
    w?.evidence !== 'record-path' ||
    !w.root ||
    w.root !== w.worktree ||
    !peer ||
    peer.evidence !== 'git-common-dir' ||
    peer.worktree !== w.root
  )
    return s;
  return {
    ...s,
    project: peer.name,
    workspace: {
      ...w,
      key: peer.key,
      name: peer.name,
      root: peer.root,
      evidence: 'git-common-dir',
    },
  };
}
export function recoverWorkspaces(sessions: Session[]): Session[] {
  const known = workspaceProof(sessions);
  return sessions.map((s) => recoverWorkspace(s, known.get(s.workspace?.root ?? '')));
}
