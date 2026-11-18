/** The mini terminal: a small shell in a colleague's or a project's folder, kept by tmux. */
export const shell = {
  open: 'Mini terminal',
  openIn: (folder: string) => `Open a mini terminal in ${folder}`,
  openHidden: 'Open a mini terminal in this folder',
  title: 'Mini terminal',
  pickFolder: 'Folder',
  others: 'Open shells',
  attachedElsewhere: (n: number) => `Also open in ${n} other ${n === 1 ? 'place' : 'places'}`,
  connecting: 'Connecting…',
  started: 'Started a new shell. Closing the window keeps it running.',
  ended: 'This shell has ended.',
  reopen: 'Start again',
  close: 'Close (keeps running)',
  kill: 'End',
  killTitle: 'End this shell?',
  killConfirm: 'End the mini terminal in this folder?',
  killDetail:
    'Anything still running in it stops, and its history is gone. Closing the window instead keeps it running.',
  killButton: 'End shell',
  cancel: 'Cancel',
  folder: 'Folder',
  name: 'tmux session',
  hint: 'Kept by tmux: close the window or the app and come back to the same shell.',
  // Errors from the desktop app.
  unsupported: 'The mini terminal needs tmux on macOS or Linux.',
  folderMissing: 'That folder no longer exists.',
  failed: 'Could not start the shell with tmux. Check that tmux works.',
  gone: 'That shell is no longer running.',
  hidden: 'The mini terminal cannot open while the screen content is hidden.',
  noPty: 'Could not attach a terminal to the shell.',
  /** The built-in terminal's window (#401): one session of the app's own terminal host. */
  term: {
    hint: 'Kept by the app: it keeps running when this window or the app closes.',
    ended: 'The agent has ended.',
    away: 'Paused while hidden. It shows again when the window does.',
    killTitle: 'End the agent in the built-in terminal?',
    killConfirm: (names: string) =>
      names
        ? `End the agent of the conversation ‘${names}’?`
        : 'End the agent in this built-in terminal?',
    killDetail:
      'The agent in this terminal stops, and whatever it runs there with it. The conversation is kept and can be continued later. Closing the window alone keeps it running.',
    killButton: 'End the agent',
    agent: 'Agent',
    command: 'Running',
    hidden: "The built-in terminal can't open while screen content is hidden.",
  },
};
