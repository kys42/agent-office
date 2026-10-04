import type { Session } from './types';

/** Keep session history separate from what is currently checked out on disk. */
export function branchInfo(s: Session) {
  if (
    s.workspace?.locationSource &&
    s.workspace.worktree &&
    s.workspace.evidence === 'git-common-dir' &&
    s.workspace.locationSource.path !== s.cwd
  ) {
    const current = s.workspace.git;
    if (current?.branch)
      return {
        label: `${current.branch} · 작업`,
        detail: '최근 도구 실행 위치에서 확인한 현재 브랜치 · 시작 기록과 별도예요.',
        key: `current:${current.branch}`,
        kind: 'current',
      };
    if (current?.state === 'detached')
      return {
        label: `HEAD · ${current.commit?.slice(0, 7) || '분리됨'} · 작업`,
        detail: '최근 실행 worktree는 특정 커밋을 바라봐요. 시작 브랜치와 별도예요.',
        key: current.commit ? `current-commit:${current.commit}` : null,
        kind: 'detached',
      };
    return {
      label: '작업 브랜치 미확인',
      detail: '최근 실행 위치의 Git 브랜치를 확인할 수 없어요.',
      key: null,
      kind: 'unknown',
    };
  }
  if (s.branch)
    return {
      label: s.branch,
      detail: '세션 기록에 남은 브랜치',
      key: `record:${s.branch}`,
      kind: 'record',
    };
  const git = s.workspace?.git;
  if (s.gitCommit)
    return {
      label: `${git?.state === 'detached' && git.commit === s.gitCommit ? 'HEAD' : '커밋'} · ${s.gitCommit.slice(0, 7)}`,
      detail:
        '세션에 브랜치 이름 대신 커밋이 기록돼 있어요. 현재 브랜치로 과거 기록을 덮어쓰지 않아요.',
      key: `commit:${s.gitCommit}`,
      kind: 'commit',
    };
  if (git?.branch)
    return {
      label: `${git.branch} · 현재`,
      detail: '세션에 브랜치 기록이 없어 현재 작업 폴더의 브랜치를 표시해요.',
      key: `current:${git.branch}`,
      kind: 'current',
    };
  if (git?.state === 'detached')
    return {
      label: `HEAD · ${git.commit?.slice(0, 7) || '분리됨'}`,
      detail: '현재 작업 폴더는 브랜치 이름 없이 특정 커밋을 바라보는 detached HEAD 상태예요.',
      key: git.commit ? `current-commit:${git.commit}` : null,
      kind: 'detached',
    };
  return {
    label: s.workspace?.evidence === 'record-path' ? '작업 폴더' : '브랜치 기록 없음',
    detail:
      s.workspace?.evidence === 'record-path'
        ? '이 작업 위치에서 Git 저장소를 확인하지 못했어요.'
        : '원본과 현재 작업 폴더에서 브랜치를 확인할 수 없어요.',
    key: null,
    kind: 'unknown',
  };
}
