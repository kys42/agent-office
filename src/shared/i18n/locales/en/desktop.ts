export const desktop = {
  tray: {
    tooltip: 'Agent Office · Our Office',
    open: 'Open the office',
    pet: 'Desk pet',
    row: 'Unfold desk row',
    floor: 'Unfold floor desks',
    settings: 'Settings…',
    quit: 'Quit',
  },
  /** Right-click menu in every window. */
  menu: {
    openLink: 'Open Link',
    copyLink: 'Copy Link Address',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
  },
  untrustedWindow: 'This window is not allowed.',
  unsupportedLink: 'Unsupported result link.',
  webLinksOnly: 'Only web links (http or https) can be opened.',
  fileMissing: "Couldn't find this file",
  badRequest: 'Invalid request',
  badFile: 'Invalid file request',
  codexOpened: 'Asked Codex to open the session',
  openclawSession: (id: string) => `OpenClaw session: ${id}`,
  /** Jumping to and typing into live terminals (Orca, tmux) and the Codex queue. */
  terminal: {
    jumpFailed: (host: string) => `Couldn't switch to the ${host} terminal.`,
    confirm: {
      enable: 'Turn on',
      cancel: 'Cancel',
      message: 'Turn on Send to terminal?',
      detail:
        "What you write on the work card is typed straight into the terminal of an idle Claude Code session in Orca or tmux, handed to the Codex queue for a running Codex CLI session, or sent to an open conversation in Codex Desktop. It's the same as typing it yourself, so a session started without permission prompts runs it as is.",
    },
    enableFirst: 'Turn on ‘Send to terminal’ in Settings.',
    codexDesktopSent: 'Sent to the conversation in Codex Desktop',
    codexDesktopUnavailable:
      'No compatible Codex Desktop owner is available. Open this conversation in Codex Desktop and try again. Nothing was sent.',
    codexDesktopUnconfirmed:
      'Could not confirm delivery to Codex Desktop. Check the conversation before sending again; the app may have received it or rejected it while busy.',
    codexMissing: "Couldn't find the Codex CLI, so nothing was sent.",
    codexUnconfirmed:
      "Couldn't confirm it reached Codex. Check the Codex screen before sending again.",
    noTarget: "Couldn't find an Orca or tmux terminal, or a Codex session, to send to right now.",
    unconfirmed: (host: string) =>
      `Couldn't confirm it was sent to ${host}. Check the terminal before sending again.`,
    orcaNoSwitch: "Orca couldn't switch to that terminal.",
    orcaFocused: 'Switched to the terminal in Orca',
    tmuxFocused: (label: string) => `Selected tmux pane ${label}`,
    empty: 'Type something to send.',
    tooLong: (max: string) => `Keep it to ${max} characters or fewer.`,
    notOwner: "Claude isn't at the terminal right now (paused, for example). Check the terminal.",
    /** A permission prompt, plan approval, menu or `!` shell mode on screen would take the text. */
    notReady:
      "It isn't taking input right now (a permission prompt, plan approval, menu or shell mode may be open). Check the terminal.",
    draft: 'There is already text in the prompt. Check the terminal before sending.',
    /** Copying the composer's text to the clipboard failed, so it was left alone. */
    backupFailed:
      "Couldn't copy the text in the prompt to the clipboard, so nothing was cleared or sent.",
    /** `agent` is the agent's name, e.g. Claude. The earlier text is already on the clipboard. */
    clearFailed: (agent: string) =>
      `Couldn't empty the ${agent} prompt, so nothing was sent. Check the terminal.`,
    /** The text never moved: the keys may not have arrived, or it is the agent's own suggestion. */
    clearFailedSuggestion: (agent: string) =>
      `Couldn't empty the ${agent} prompt, so nothing was sent. If it's ${agent}'s suggestion, it can't be cleared from here: type over it in the terminal.`,
    /** After clearing, the prompt did not show exactly the typed text: no Enter, the text stays. */
    notVerified:
      "Typed it into the emptied prompt, but couldn't confirm it holds only your text, so it wasn't submitted. Check the terminal.",
    /** Not all of the composer's text is on screen (a box too short for it): nothing is cleared. */
    notWhole:
      "Not all of the text in the prompt is visible, so it can't be cleared from here. Clear it in the terminal, then send again.",
    /** The draft was copied and cleared; copying what showed up after it failed. */
    backupFailedLater:
      'The draft was cleared and is on your clipboard, but copying the text that showed up after it failed, so nothing more was cleared or sent. Check the terminal.',
    /** Claude paused, left, or stopped taking input while the prompt was being cleared. */
    clearStopped:
      "Claude's state changed while the prompt was being cleared, so clearing stopped and nothing was sent. Check the terminal.",
    /** Added to any failure once the composer's text was copied (it may be partly cleared). */
    partialClipboardKept:
      'Readable content is on the clipboard. Hidden content may not be recoverable.',
    clipboardKept: 'The text that was in the prompt is on your clipboard.',
    /** A send reached an agent whose input box can't be read (OpenClaw, anything new). */
    unsupportedAgent: (agent: string) => `Sending to ${agent} from here isn't supported.`,
    shellPrefix: "Text starting with ‘!’ would run as a shell command, so it isn't sent.",
    unreadable: (host: string) => `Couldn't read the ${host} screen, so nothing was sent.`,
    /** `reason` is Orca's own refusal, already wrapped as ` (reason)`, or empty. */
    orcaRefused: (reason: string) => `Orca didn't accept the input${reason}.`,
    orcaSent: 'Sent to the Orca terminal',
    stateChanged:
      "Typed it into the prompt, but the state changed in the meantime, so it wasn't submitted. Check the terminal before sending again.",
    notSubmitted: (host: string) =>
      `Typed it into ${host}, but couldn't press Enter. Check the terminal before sending again.`,
    sentThenPrompt: (host: string) =>
      `Sent to ${host}, and a permission prompt opened right after. Check the terminal.`,
    tmuxSent: (label: string) => `Sent to tmux ${label}`,
    /** Sent mid-turn: Claude queues it and picks it up as it goes. */
    queued: (target: string) =>
      `Sent to ${target} · it's working, so it's queued for the current turn`,
    codexNoReply: "Couldn't confirm Codex's response. Check the Codex screen before sending again.",
    codexQueued: 'Passed to the Codex session',
  },
};
