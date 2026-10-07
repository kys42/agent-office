import type { Messages } from '../en';

export const terminal: Messages['terminal'] = {
  // Orca·tmux 모두 모음으로 끝나 '로'가 맞아요.
  jumpTo: (host) => `${host}로 이동`,
  jumpToTerminal: (name) => `${name} 터미널로 이동`,
  jumpHint: (target) => `이 동료가 실행 중인 ${target} 터미널을 앞으로 가져와요.`,
  queueLine: (host) => `${host} · 세션 대기열`,
  placeholder: {
    queues: 'Codex 세션에 바로 전달돼요 · 작업 중이면 끝난 뒤 처리돼요',
    busy: '작업 중이에요 · 끝나면 보낼 수 있어요',
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
};
