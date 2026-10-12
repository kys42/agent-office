import type { Messages } from '../en';

export const terminal: Messages['terminal'] = {
  // Orca·tmux 모두 모음으로 끝나 '로'가 맞아요.
  jumpTo: (host) => `${host}로 이동`,
  jumpToTerminal: (name) => `${name} 터미널로 이동`,
  jumpHint: (target) => `이 동료가 실행 중인 ${target} 터미널을 앞으로 가져와요.`,
  queueLine: (host) => `${host} · 세션 대기열`,
  placeholder: {
    queues: 'Codex 세션에 바로 전달돼요 · 작업 중이면 끝난 뒤 처리돼요',
    busy: '작업 중이에요 · 보내면 대기열에 들어가 이어서 반영돼요',
    notWaiting: '지금은 입력을 기다리지 않아요',
    direct: (host) => `${host} 터미널에 바로 입력돼요`,
  },
  runningCodex: 'Codex CLI에서 실행 중이에요',
  runningIn: (host) => `${host} 터미널에서 실행 중이에요`,
  offHint: (running) =>
    `${running}. 설정에서 ‘터미널로 보내기’를 켜면 여기서 바로 이어서 말할 수 있어요.`,
  messageLabel: (host) => `${host} 터미널로 보낼 내용`,
  sendShortcut: '⌘↵ 보내기',
  busy: '작업 중',
  send: '보내기',
  replyTo: (name) => `${name}에게 바로 답장`,
  replyTitle: (target) => `바로 답장 · ${target}`,
  replyLabel: '답장 내용',
  replyKeys: '↵ 보내기 · ⇧↵ 줄바꿈',
  closeReply: '답장 닫기',
  draftFound: (agent) => `${agent} 입력창에 이 글이 있어요`,
  draftMaybeSuggestion:
    '입력창에 뜬 추천 글일 수도 있어요. 화면 글자만으로는 구분할 수 없어요. 지우면 이 글이 클립보드에 들어가 원래 클립보드 내용을 대신해요.',
  draftPartlySaved: '지금까지 지운 글은 클립보드에 있어요.',
  draftChanged: '그사이 입력창 글이 바뀌었어요. 다시 확인해 주세요.',
  draftHidden: '화면 내용 숨기기 중이라 가렸어요',
  clearAndSend: '지우고 보내기',
  cancelClear: '취소',
  clearedToClipboard: '지운 글은 클립보드에 있어요',
};
