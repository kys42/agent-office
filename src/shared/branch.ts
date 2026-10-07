import type { Session } from './types';
import { m } from './i18n';

/** Keep session history separate from what is currently checked out on disk. */
export function branchInfo(s: Session) {
  const t = m().shared.branch;
  if (
    s.workspace?.locationSource &&
    s.workspace.worktree &&
    s.workspace.evidence === 'git-common-dir' &&
    s.workspace.locationSource.path !== s.cwd
  ) {
    const current = s.workspace.git;
    if (current?.branch)
      return {
        label: t.working(current.branch),
        detail: t.workingDetail,
        key: `current:${current.branch}`,
        kind: 'current',
      };
    if (current?.state === 'detached')
      return {
        label: t.workingHead(current.commit?.slice(0, 7) || t.detached),
        detail: t.workingDetachedDetail,
        key: current.commit ? `current-commit:${current.commit}` : null,
        kind: 'detached',
      };
    return {
      label: t.workingUnknown,
      detail: t.workingUnknownDetail,
      key: null,
      kind: 'unknown',
    };
  }
  if (s.branch)
    return {
      label: s.branch,
      detail: t.recordDetail,
      key: `record:${s.branch}`,
      kind: 'record',
    };
  const git = s.workspace?.git;
  if (s.gitCommit)
    return {
      label: `${git?.state === 'detached' && git.commit === s.gitCommit ? 'HEAD' : t.commit} · ${s.gitCommit.slice(0, 7)}`,
      detail: t.commitDetail,
      key: `commit:${s.gitCommit}`,
      kind: 'commit',
    };
  if (git?.branch)
    return {
      label: t.current(git.branch),
      detail: t.currentDetail,
      key: `current:${git.branch}`,
      kind: 'current',
    };
  if (git?.state === 'detached')
    return {
      label: `HEAD · ${git.commit?.slice(0, 7) || t.detached}`,
      detail: t.detachedDetail,
      key: git.commit ? `current-commit:${git.commit}` : null,
      kind: 'detached',
    };
  return {
    label: s.workspace?.evidence === 'record-path' ? t.folder : t.none,
    detail: s.workspace?.evidence === 'record-path' ? t.folderDetail : t.noneDetail,
    key: null,
    kind: 'unknown',
  };
}
