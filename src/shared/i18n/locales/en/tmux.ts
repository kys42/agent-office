export const tmux = {
  remoteTitle: 'Summon in this remote office',
  remoteConfirm: 'Start a new agent on this remote computer?',
  remoteStart: 'Start remotely',
  remoteHost: 'Terminal on the remote computer',
  remoteHint:
    'Runs at the selected remote project’s worktree root. Orca requires that folder to be a registered workspace. It appears after its first conversation is collected. Complete CLI login or trust prompts on that computer.',
  remoteUnavailable:
    'Cannot launch here. Check the remote exporter version, launch permission, shared project and installed CLI/terminal.',
  remoteUncertain:
    'The launch result is uncertain. Check the remote terminal before starting another session.',
  remoteStarted: 'The remote session has started. Waiting for its first conversation.',
  remoteExisting: 'This named tmux session is already running.',
  remoteMissing: 'Unavailable on this computer',
  summonTitle: 'Summon a new agent',
  summonIntro:
    'Name a new agent for this project. tmux keeps its terminal session running so you can reconnect and work directly whenever needed.',
  summonDescription: 'Set up a new colleague for this project.',
  resumeDescription:
    'Continue this conversation in a separate terminal. Reconnect whenever you need.',
  agentSettings: 'New colleague settings',
  agentType: 'Agent',
  sessionDetails: 'Terminal session details',
  guide: 'Managing a session with tmux',
  summonDiscovery: 'The agent appears in the office after its first conversation is detected.',
  agentName: 'Agent name',
  invalidName: 'Use 1–40 letters, numbers, spaces, hyphens or underscores.',
  nameHint:
    'Used in the office and tmux. The office name appears after the first conversation is detected.',
  initialMessage: 'First message (optional)',
  messagePlaceholder: 'For example: Explore this project and suggest the next tasks',
  messageHint: 'Up to 4,000 characters · Sent once when a new session starts.',
  invalidMessage: 'Use at most 4,000 characters without control characters for the first message.',
  summonRunning: 'tmux is running',
  existingTitle: 'Already connected in this project',
  existingConfirm: 'There are connected agents in this project. Start another tmux session anyway?',
  existingOpen: 'Open existing session',
  summonCheck: 'Check connections and name',
  summonDefault: 'New agent',
  summonConfirm: 'Start a new agent in this project?',
  summonStart: 'Summon in tmux',
  summonReady: 'Ready for a new conversation',
  summonHint:
    'The agent appears in the office after its first conversation is detected. If it is missing, open the terminal, complete any login or project trust prompts, and send the first message. Close it or press Ctrl+B, then D to detach. Reconnect here while the agent is running. After it exits, summoning starts a new conversation; use the conversation card to resume its history.',
  title: 'Resume in tmux',
  intro:
    'Continue this saved conversation in a separate terminal session. This does not create a new conversation.',
  name: 'tmux session',
  folder: 'Project folder',
  command: 'Reconnect command',
  ready: 'Ready to resume',
  running: 'A tmux session is available',
  hint: 'Close the terminal or press Ctrl+B, then D to detach. The agent keeps running while this computer is awake. After a restart or the agent exits, resume it here again.',
  skipPermissions:
    'Runs without permission prompts (Claude: --dangerously-skip-permissions, Codex: --dangerously-bypass-approvals-and-sandbox). Turn it off in Settings → Terminal and answers.',
  caution:
    'If this conversation is already running elsewhere, finish that run first to avoid working on it in two places.',
  start: 'Start in tmux',
  open: 'Open in Terminal',
  copy: 'Copy reconnect command',
  refresh: 'Check again',
  loading: 'Checking…',
  cancel: 'Cancel',
  confirm: 'Resume this conversation in a separate tmux session?',
  failed: 'Could not start tmux. Check that tmux and the agent CLI are installed and try again.',
  missing: 'Install tmux and this agent’s CLI, then try again.',
  folderMissing: 'The original project folder is unavailable. Restore it before resuming.',
  unsupported: 'tmux resume supports local Claude and Codex sessions on macOS and Linux.',
  conflict: 'This tmux name belongs to another session. It was not changed.',
  ended: 'This tmux session has ended. Resume it again to reconnect.',
  openFailed: 'Could not open Terminal. Copy the reconnect command and run it in your terminal.',
  /** Resuming in a new Orca terminal tab instead of tmux. */
  orcaTitle: 'Resume in Orca',
  orcaStart: 'Open in a new Orca tab',
  orcaConfirm: 'Resume this conversation in a new Orca terminal tab?',
  orcaIntro:
    'Opens a new terminal tab in Orca for this project folder and runs the command below in it. It does not start a new conversation.',
  orcaCommand: 'Command',
  orcaHint: 'Orca is running: this conversation can also open in a new Orca tab.',
  orcaLaunched: 'Opened a new Orca tab for this conversation',
  orcaUnsupported: 'Orca resume supports local Claude and Codex sessions on macOS.',
  orcaUnavailable: 'Orca is not running or not reachable. Open Orca and try again.',
  orcaRefused: (reason: string) =>
    `Orca did not open the tab${reason ? `: ${reason}` : '.'} The folder may not be an Orca workspace; you can start it in tmux instead.`,
  /** The duplicate-launch check before resuming (tmux or a new Orca tab). */
  place: { orca: 'Orca', tmux: 'tmux', other: 'another terminal' },
  runningNotice: (place: string) =>
    `This conversation is already running in ${place}. Go to it instead of starting it again.`,
  openNotice: (place: string) => `This conversation is already open in ${place}.`,
  openHint:
    'Its agent could not be confirmed running there. Starting it again may run the same conversation twice.',
  unknownNotice:
    'Could not confirm that this conversation is not open somewhere else. Check before starting it again.',
  jumpToTerminal: 'Go to terminal',
  jumpToTab: 'Go to that tab',
  forceStart: 'Start in tmux anyway',
  forceOrca: 'Open in a new Orca tab anyway',
  runningRefused: (place: string) =>
    `This conversation is already running in ${place}, so it was not started again. Use Go to terminal.`,
  changedRefused:
    'This conversation opened somewhere else while you were confirming, so it was not started. Check its status again.',
  openConfirm: (place: string) =>
    `Warning: this conversation is already open in ${place}. Starting it again can run the same conversation twice, and the two can overwrite each other’s work.`,
  unknownConfirm:
    'Could not confirm that this conversation is not open somewhere else. If it is, the same conversation will run twice.',
  tabGone: 'That Orca tab could not be found again. Check the status again.',
  ownSessionNote:
    'This is the tmux session Agent Office started for this conversation. After /new or /clear in it, it may now show another conversation.',
};
