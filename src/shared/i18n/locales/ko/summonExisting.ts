import type { Messages } from '../en';

export const summonExisting: Messages['summonExisting'] = {
  title: '기존 동료 불러오기',
  description:
    '대기 라운지나 보관함에 있는 이 프로젝트 동료를 사무실로 데려오고, 그 대화를 터미널에서 이어가요.',
  count: (n) => `${n}명`,
  more: (n) => `오래된 동료 ${n}명은 목록에서 생략했어요.`,
  zone: { waiting: '대기', archive: '보관' },
  active: (ago) => `${ago} 활동`,
  blocked: {
    remote: '원격 사무실 동료는 여기서 이어갈 수 없어요',
    provider: 'Claude·Codex 대화만 이어갈 수 있어요',
    conversation: '이어갈 대화 기록이 없어요',
    folder: '원래 프로젝트 폴더를 알 수 없어요',
  },
  chosen: '불러올 동료',
  tmuxStart: 'tmux로 불러오기',
  orcaStart: 'Orca 새 탭으로 불러오기',
  hint: '터미널이 열리면 사무실로 데려와요(보관된 동료는 보관 해제). 실행 전에 확인 창이 떠요.',
};
