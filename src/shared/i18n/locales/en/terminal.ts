/** Jumping to a teammate's live terminal, sending to it, and quick replies from bubbles. */
export const terminal = {
  /** Brings the live terminal to the front, e.g. "Jump to Orca". */
  jumpTo: (host: string) => `Jump to ${host}`,
  jumpToTerminal: (name: string) => `Jump to ${name}'s terminal`,
  jumpHint: (target: string) => `Brings this teammate's ${target} terminal to the front.`,
  /** Target line when messages wait in the Codex CLI queue. */
  queueLine: (host: string) => `${host} · session queue`,
  placeholder: {
    queues: "Goes straight to the Codex session · if it's busy, it runs after the current turn",
    busy: "Working · you can send once it's done",
    notWaiting: 'Not waiting for input right now',
    direct: (host: string) => `Typed straight into the ${host} terminal`,
  },
  runningCodex: 'Running in Codex CLI',
  runningIn: (host: string) => `Running in a ${host} terminal`,
  offHint: (running: string) =>
    `${running}. Turn on ‘Send to terminal’ in Settings to follow up right here.`,
  messageLabel: (host: string) => `Message for the ${host} terminal`,
  sendShortcut: '⌘↵ to send',
  busy: 'working',
  send: 'Send',
  replyTo: (name: string) => `Quick reply to ${name}`,
  replyTitle: (target: string) => `Quick reply · ${target}`,
  replyLabel: 'Your reply',
  replyKeys: '↵ to send · ⇧↵ new line',
  closeReply: 'Close reply',
};
