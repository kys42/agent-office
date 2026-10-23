import type { Messages } from '../en';

export const desktop: Messages['desktop'] = {
  tray: {
    tooltip: 'Agent Office · 우리 사무실',
    open: '사무실 열기',
    pet: '데스크 펫',
    row: '책상 줄 펼치기',
    floor: '바닥 책상 펼치기',
    settings: '설정…',
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
  notify: {
    final: '최종 응답을 보냈어요',
    call: '확인이 필요해요',
    error: '오류가 났어요',
    summaryTitle: 'Agent Office',
    summary: (n, finals) =>
      finals === n
        ? `새 최종 응답 ${n}개`
        : finals
          ? `새 소식 ${n}개 · 최종 응답 ${finals}개`
          : `확인이 필요한 소식 ${n}개`,
  },
  untrustedWindow: '허용되지 않은 창입니다.',
  unsupportedLink: '지원하지 않는 결과 링크입니다.',
  webLinksOnly: '웹 링크(http·https)만 열 수 있어요.',
  fileMissing: '이 파일을 찾을 수 없어요',
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
        'Orca·tmux에서 쉬고 있는 Claude Code 세션에는 업무 카드에서 쓴 글을 그 터미널에 직접 입력하고, 실행 중인 Codex CLI 세션에는 대기열로, Codex Desktop에서 열린 대화에는 앱 연결로 전달해요. 내가 친 것과 같아서 권한 확인 없이 띄운 세션이면 그대로 실행돼요.',
    },
    enableFirst: '설정에서 ‘터미널로 보내기’를 켜 주세요.',
    codexDesktopSent: 'Codex Desktop 대화에 전달했어요',
    codexDesktopUnavailable:
      '연결 가능한 Codex Desktop 대화를 찾지 못했어요. Desktop에서 이 대화를 열어 주세요. 메시지는 보내지 않았어요.',
    codexDesktopUnconfirmed:
      'Codex Desktop의 수신을 확인하지 못했어요. 이미 전달됐거나 작업 중이라 거절됐을 수 있으니, 다시 보내기 전에 대화를 확인해 주세요.',
    codexMissing: 'Codex CLI를 찾지 못해 보내지 않았어요.',
    codexUnconfirmed:
      'Codex에 전달됐는지 확인하지 못했어요. 다시 보내기 전에 Codex 화면을 확인해 주세요.',
    noTarget: '지금 보낼 수 있는 Orca·tmux 터미널이나 Codex 세션을 찾지 못했어요.',
    unconfirmed: (host) =>
      `${host}에 보냈는지 확인하지 못했어요. 다시 보내기 전에 터미널을 확인해 주세요.`,
    orcaNoSwitch: 'Orca가 그 터미널로 이동하지 못했어요.',
    orcaFocused: 'Orca의 해당 터미널로 이동했어요',
    tmuxFocused: (label, app) => `${app}에서 tmux ${label} 패널로 이동했어요`,
    tmuxAttached: (label) => `터미널을 열어 tmux ${label}에 연결했어요`,
    tmuxNotRaised: (label) =>
      `tmux를 ${label} 패널로 바꿨지만 그 터미널 창을 앞으로 가져오지 못했어요.`,
    tmuxAttachHint: (label, command) =>
      `tmux ${label}에 연결된 터미널이 없어요. 터미널에서 연결해 주세요: ${command}`,
    tmuxOpenFailed: (label) => `tmux ${label} 패널은 선택했지만 연결할 터미널을 열지 못했어요.`,
    empty: '보낼 내용을 입력해 주세요.',
    tooLong: (max) => `${max}자 이하로 보내 주세요.`,
    notOwner: 'Claude가 지금 터미널 앞에 있지 않아요(일시정지 등). 터미널을 확인해 주세요.',
    notReady:
      '지금은 입력을 받을 수 없어요(권한 확인·플랜 승인·메뉴·셸 입력 모드 등). 터미널을 확인해 주세요.',
    draft: '입력창에 이미 글이 있어요. 터미널을 확인한 뒤 보내 주세요.',
    backupFailed: '입력창의 글을 클립보드에 복사하지 못해 지우지도 보내지도 않았어요.',
    clearFailed: (agent) =>
      `${agent} 입력창을 비우지 못해 보내지 않았어요. 터미널을 확인해 주세요.`,
    clearFailedSuggestion: (agent) =>
      `${agent} 입력창을 비우지 못해 보내지 않았어요. ${agent}의 추천 글이면 여기서는 지울 수 없어요. 터미널에서 그 위에 입력해 주세요.`,
    notVerified:
      '비운 입력창에 넣었지만 넣은 글만 있는지 확인하지 못해 제출하지 않았어요. 터미널을 확인해 주세요.',
    notWhole:
      '입력창 글이 다 보이지 않아 여기서 지울 수 없어요. 터미널에서 비운 뒤 다시 보내 주세요.',
    backupFailedLater:
      '초안은 지워서 클립보드에 있지만, 그 뒤에 나타난 글을 복사하지 못해 더 지우거나 보내지 않았어요. 터미널을 확인해 주세요.',
    clearStopped:
      '입력창을 비우는 사이 Claude 상태가 바뀌어 멈췄고 보내지 않았어요. 터미널을 확인해 주세요.',
    partialClipboardKept:
      '읽을 수 있었던 내용은 클립보드에 있어요. 가려진 내용은 복원되지 않을 수 있어요.',
    clipboardKept: '입력창에 있던 글은 클립보드에 있어요.',
    unsupportedAgent: (agent) => `${agent}에는 여기서 보낼 수 없어요.`,
    shellPrefix: '‘!’로 시작하는 글은 셸 명령으로 실행돼서 보내지 않아요.',
    unreadable: (host) => `${host} 화면을 읽지 못해서 보내지 않았어요.`,
    orcaRefused: (reason) => `Orca가 입력을 받지 않았어요${reason}.`,
    orcaSent: 'Orca 터미널에 보냈어요',
    stateChanged:
      '입력창에 넣었지만 그사이 상태가 바뀌어 제출하지 않았어요. 다시 보내기 전에 터미널을 확인해 주세요.',
    notSubmitted: (host) =>
      `${host}에 글은 넣었지만 Enter를 보내지 못했어요. 다시 보내기 전에 터미널을 확인해 주세요.`,
    sentThenPrompt: (host) => `${host}에 보냈는데 바로 승인 창이 떴어요. 터미널을 확인해 주세요.`,
    tmuxSent: (label) => `tmux ${label}에 보냈어요`,
    queued: (target) => `${target}에 보냈어요 · 작업 중이라 대기열에 들어가 이어서 반영돼요`,
    codexNoReply: 'Codex 응답을 확인하지 못했어요. 다시 보내기 전에 Codex 화면을 확인해 주세요.',
    codexQueued: 'Codex 세션에 전달했어요',
  },
};
