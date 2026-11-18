/** Jumping to a teammate's live terminal, sending to it, and quick replies from bubbles. */
export const terminal = {
  /** Brings the live terminal to the front, e.g. "Jump to Orca". */
  jumpTo: (host: string) => `Jump to ${host}`,
  jumpToTerminal: (name: string) => `Jump to ${name}'s terminal`,
  jumpHint: (target: string) => `Brings this teammate's ${target} terminal to the front.`,
  /** Target line when messages wait in the Codex CLI queue. */
  queueLine: (host: string) => `${host} · session queue`,
  placeholder: {
    desktop: 'Send to this conversation in Codex Desktop',
    queues: "Goes straight to the Codex session · if it's busy, it runs after the current turn",
    busy: 'Working · what you send is queued and picked up as it goes',
    notWaiting: 'Not waiting for input right now',
    /** Only its Orca tab was found: jump there, nothing is typed. */
    tabOnly: 'Its Orca tab is still open, but the agent is not running there · nothing can be sent',
    direct: (host: string) => `Typed straight into the ${host} terminal`,
    /** No terminal found as last seen. */
    unknown: 'Its terminal is looked up again on send',
  },
  runningDesktop: 'Connected to Codex Desktop',
  runningCodex: 'Running in Codex CLI',
  runningIn: (host: string) => `Running in a ${host} terminal`,
  /** No terminal found so far. */
  runningSomewhere: 'Running in a terminal',
  offHint: (running: string) =>
    `${running}. Turn on ‘Send to terminal’ in Settings to follow up right here.`,
  messageLabel: (host: string) => `Message for ${host}`,
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
    'It may be a suggestion the prompt shows. Clearing puts it on your clipboard, replacing what’s there.',
  /** Typing showed up while clearing: what was cleared so far is already on the clipboard. */
  draftPartlySaved: 'What was cleared so far is on your clipboard.',
  /** The text confirmed earlier was no longer what the prompt held. */
  draftChanged: 'The prompt changed in the meantime. Check it again.',
  /** In hidden-screen mode the text itself is not shown. */
  draftHidden: 'Hidden while the screen content is hidden',
  /** Not all of the composer's text is on screen: it is never cleared from here. */
  draftNotWhole:
    'This connection cannot clear the input. Clear it in the terminal, then send again.',
  openTerminal: 'Open the terminal',
  /** A host not known yet (no terminal found so far). */
  terminal: 'terminal',
  /** No terminal found as last seen: the send looks again. */
  lookingAgain: 'Looking for its terminal · checked again on send',
  partialDraftWarning:
    'Only part of the input is visible. Clearing may also remove hidden text or attachments. The clipboard may contain only the parts we could read.',
  clearPartialAndSend: 'Clear hidden content and send',
  partialClearedToClipboard:
    'Readable input is on the clipboard. Hidden content may not be recoverable.',
  clearAndSend: 'Clear & send mine',
  /** Sends the composer's text (a suggestion or a draft) instead of the reply being written. */
  sendDraft: 'Send this as is',
  sendDraftTitle: 'Sends the text in the prompt instead. What you wrote stays in the box.',
  cancelClear: 'Cancel',
  /** Text sitting in the terminal's input box (typed there, not sent), shown on the work card. */
  preview: {
    title: 'Half-written in the terminal input',
    /** `agent`: e.g. Claude. */
    where: (agent: string) => `${agent} input box`,
    expand: 'Show all',
    collapse: 'Show less',
    send: 'Send as is',
    sendTitle:
      'Presses Enter in the terminal, only if its input box still holds exactly this text. Nothing is typed.',
    import: 'Edit in card',
    importTitle:
      'Copies it into the box below. Sending from the card then replaces it in the terminal.',
    imported:
      'Copied into the box below. Sending clears this from the terminal input (it goes to your clipboard) and sends yours instead.',
    /** The box wrapped rows where the text's own breaks can't be told apart: no [Edit in card]. */
    notImportable:
      "The terminal wrapped this over rows, so where its own lines break can't be told. Edit it in the terminal, or send it as is.",
    partial:
      "Not all of it is visible here, so it can't be sent from the card. Check the terminal.",
    maybeSuggestion:
      "It may be Claude's suggestion rather than something typed. A suggestion isn't sent with Enter: press Tab in the terminal to take it.",
    /** One line that may be Claude's suggestion, sent through the accept key first. */
    maybeSuggestionSend:
      "It may be Claude's suggestion. If it is, it's taken in first; if you typed it, it's sent as is.",
    sendMaybeSuggestionTitle:
      "Presses → in the terminal (it takes Claude's suggestion in, typed text stays as is), then Enter only if the input box holds exactly this text.",
    /** Not all of it shows, and it may be Claude's suggestion (Orca can't tell). */
    partialMaybeSuggestion:
      "It may be Claude's suggestion, which Tab takes in the terminal. Whether all of it shows can't be told here, so it can't be sent from the card.",
    /** Claude Code's own prompt suggestion, told apart from typing: nobody typed it. */
    suggestion: {
      /** `agent`: e.g. Claude. */
      title: (agent: string) => `${agent} suggestion`,
      hint: (agent: string) =>
        `${agent} suggests this as your next message. In the terminal, Tab takes it.`,
      send: 'Send suggestion',
      sendTitle:
        'Takes the suggestion in (→, like Tab) while the input box holds only it, then presses Enter only if the box then holds exactly this text.',
      partial:
        "Not all of the suggestion is visible, so it can't be sent from the card. Press Tab in the terminal to take it.",
    },
  },
  clearedToClipboard: 'The cleared text is on your clipboard',
  /** Images in the composer: paste (⌘V), drop, or the attach button. */
  images: {
    attach: 'Attach images',
    attachHint: 'Attach images · you can also paste (⌘V) or drop them here',
    remove: (n: number) => `Remove image ${n}`,
    /** Privacy mode: the thumbnail itself is hidden. */
    hidden: (n: number) => `Image ${n} (hidden)`,
    uploading: 'Attaching…',
    /** The Codex CLI queue takes text only: the images go as file paths. */
    asPaths: 'Codex CLI gets the images as file paths',
    dropHere: 'Drop images to attach',
    /** Why images can't be attached here. */
    blocked: {
      desktop: 'Images can be sent from the desktop app only.',
      remote: "Images can't be sent to a teammate in another office.",
      target: "This conversation can't take images from here.",
    },
    notImage: 'Only PNG, JPEG, GIF or WebP images can be attached.',
    tooLarge: (mb: number) => `Images must be ${mb} MB or smaller.`,
    tooMany: (max: number) => `Attach up to ${max} images at a time.`,
  },
};
