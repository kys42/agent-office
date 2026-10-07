export const desktop = {
  tray: {
    tooltip: 'Agent Office · Our Office',
    open: 'Open the office',
    pet: 'Desk pet',
    row: 'Unfold desk row',
    floor: 'Unfold floor desks',
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
        "What you write on the work card is typed straight into the terminal of an idle Claude Code session in Orca or tmux, and handed to the Codex queue for a running Codex CLI session. It's the same as typing it yourself, so a session started without permission prompts runs it as is.",
    },
    enableFirst: 'Turn on ‘Send to terminal’ in Settings.',
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
    busy: "It's working right now. Send again once it's done.",
    /** `reason` is Orca's own refusal, already wrapped as ` (reason)`, or empty. */
    orcaRefused: (reason: string) => `Orca didn't accept the input${reason}.`,
    orcaStarted: 'Sent to the Orca terminal, and work has started',
    orcaSent: 'Sent to the Orca terminal',
    stateChanged:
      "Typed it into the prompt, but the state changed in the meantime, so it wasn't submitted. Check the terminal.",
    tmuxSent: (label: string) => `Sent to tmux ${label}`,
    codexNoReply: "Couldn't confirm Codex's response. Check the Codex screen before sending again.",
    codexQueued: 'Passed to the Codex session',
  },
};
