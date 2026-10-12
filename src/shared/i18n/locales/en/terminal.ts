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
    busy: 'Working · what you send is queued and picked up as it goes',
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
  /** The agent's composer already holds text: shown before anything is typed. `agent`: e.g. Claude. */
  draftFound: (agent: string) => `This is already in the ${agent} prompt`,
  /** On screens without styles, the agent's own suggestion looks the same as a draft. */
  draftMaybeSuggestion:
    'It may be a suggestion the prompt shows; the screen alone can’t tell. Clearing puts it on your clipboard, replacing what’s there.',
  /** Typing showed up while clearing: what was cleared so far is already on the clipboard. */
  draftPartlySaved: 'What was cleared so far is on your clipboard.',
  /** The text confirmed earlier was no longer what the prompt held. */
  draftChanged: 'The prompt changed in the meantime. Check it again.',
  /** In hidden-screen mode the text itself is not shown. */
  draftHidden: 'Hidden while the screen content is hidden',
  /** Not all of the composer's text is on screen: it is never cleared from here. */
  draftNotWhole:
    "Not all of it is visible, so it can't be cleared from here. Clear it in the terminal, then send again.",
  openTerminal: 'Open the terminal',
  clearAndSend: 'Clear & send',
  cancelClear: 'Cancel',
  clearedToClipboard: 'The cleared text is on your clipboard',
};
