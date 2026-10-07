import type { Messages } from '../en';

export const desktop: Messages['desktop'] = {
  tray: {
    tooltip: 'Agent Office · 우리 사무실',
    open: '사무실 열기',
    pet: '데스크 펫',
    row: '책상 줄 펼치기',
    floor: '바닥 책상 펼치기',
    quit: '종료',
  },
  menu: {
    openLink: '링크 열기',
    copyLink: '링크 주소 복사',
    cut: '잘라내기',
    copy: '복사',
    paste: '붙여넣기',
    selectAll: '모두 선택',
  },
  untrustedWindow: '허용되지 않은 창입니다.',
  unsupportedLink: '지원하지 않는 결과 링크입니다.',
  webLinksOnly: '웹 링크(http·https)만 열 수 있어요.',
  badRequest: '잘못된 요청',
  badFile: '잘못된 파일 요청',
  codexOpened: 'Codex에서 세션 열기를 요청했어요',
  openclawSession: (id) => `OpenClaw 세션: ${id}`,
  terminal: {
    jumpFailed: (host) => `${host} 터미널로 이동하지 못했어요.`,
    confirm: {
      enable: '켜기',
      cancel: '취소',
      message: '터미널로 보내기를 켤까요?',
      detail:
        'Orca·tmux에서 쉬고 있는 Claude Code 세션에는 업무 카드에서 쓴 글을 그 터미널에 직접 입력하고, 실행 중인 Codex CLI 세션에는 Codex 대기열로 전달해요. 내가 친 것과 같아서 권한 확인 없이 띄운 세션이면 그대로 실행돼요.',
    },
    enableFirst: '설정에서 ‘터미널로 보내기’를 켜 주세요.',
    codexMissing: 'Codex CLI를 찾지 못해 보내지 않았어요.',
    codexUnconfirmed:
      'Codex에 전달됐는지 확인하지 못했어요. 다시 보내기 전에 Codex 화면을 확인해 주세요.',
    noTarget: '지금 보낼 수 있는 Orca·tmux 터미널이나 Codex 세션을 찾지 못했어요.',
    unconfirmed: (host) =>
      `${host}에 보냈는지 확인하지 못했어요. 다시 보내기 전에 터미널을 확인해 주세요.`,
    orcaNoSwitch: 'Orca가 그 터미널로 이동하지 못했어요.',
    orcaFocused: 'Orca의 해당 터미널로 이동했어요',
    tmuxFocused: (label) => `tmux ${label} 패널을 선택했어요`,
    empty: '보낼 내용을 입력해 주세요.',
    tooLong: (max) => `${max}자 이하로 보내 주세요.`,
    notOwner: 'Claude가 지금 터미널 앞에 있지 않아요(일시정지 등). 터미널을 확인해 주세요.',
    busy: '작업 중이에요. 끝나면 다시 보내 주세요.',
    orcaRefused: (reason) => `Orca가 입력을 받지 않았어요${reason}.`,
    orcaStarted: 'Orca 터미널에 보냈고 작업이 시작됐어요',
    orcaSent: 'Orca 터미널에 보냈어요',
    stateChanged:
      '입력창에 넣었지만 그사이 상태가 바뀌어 제출하지 않았어요. 터미널을 확인해 주세요.',
    tmuxSent: (label) => `tmux ${label}에 보냈어요`,
    codexNoReply: 'Codex 응답을 확인하지 못했어요. 다시 보내기 전에 Codex 화면을 확인해 주세요.',
    codexQueued: 'Codex 세션에 전달했어요',
  },
};
