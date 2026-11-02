/** The launch core (#318): destinations, their reasons and the confirmation of any launch. */
export const launch = {
  destination: {
    orca: 'Orca',
    tmux: 'tmux',
    terminalApp: 'Terminal',
    copy: 'Copy command',
  },
  kind: { new: 'New session', resume: 'Continue', fork: 'Fork into a new session' },
  title: {
    new: 'Summon a new agent',
    resume: 'Continue a conversation',
    fork: 'Fork a conversation',
  },
  confirm: {
    new: (place: string) => `Start a new agent for this project in ${place}?`,
    resume: (place: string) => `Continue this conversation in ${place}?`,
    fork: (place: string) => `Fork this conversation into a new session in ${place}?`,
  },
  intro: {
    new: 'Starts a new conversation in this project folder.',
    resume: 'Continues this saved conversation. It does not create a new one.',
    fork: 'Leaves the original conversation as it is and starts a new one branched from the same context, in the original folder.',
  },
  start: (place: string) => `Start in ${place}`,
  forkOf: 'Forked from',
  agentUnsupported: "This agent can't be started in a terminal from the office.",
  forkUnsupported: "OpenClaw can't fork a conversation.",
  noConversation: 'There is no saved conversation to continue.',
  orcaMissing: "Orca isn't installed.",
  orcaStopped: "Orca isn't running. Open Orca and check again.",
  orcaSlow: "Orca didn't answer in time. Check again in a moment.",
  orcaUnknownWorkspace:
    "Orca didn't say whether this folder is one of its workspaces. Check again in a moment.",
  terminalAppUnsupported: 'Opening Terminal is available on macOS only.',
  terminalAppLaunched: 'Opened in a new Terminal window.',
  terminalAppFailed: "Couldn't open Terminal. Copy the command and run it in a terminal.",
  terminalAppDenied:
    "Agent Office isn't allowed to control Terminal. Allow it in System Settings → Privacy & Security → Automation, or copy the command.",
  terminalAppUncertain:
    "Terminal didn't answer in time, so the start couldn't be confirmed. It may already be running in a Terminal window: check there before starting it again.",
  tmuxUncertain:
    "tmux didn't answer in time, so the start couldn't be confirmed. It may already be running: check its status before starting it again.",
  tmuxLaunched: 'Started in tmux. Open it in a terminal to work there.',
  tmuxRunning: 'Its tmux session is already running. Open it in a terminal.',
  tmuxOpened: 'Opened its tmux session in Terminal.',
  starting: (place: string) =>
    `It was just started in ${place} and may still be starting. Check there before starting it again.`,
  copied: 'Command copied. Run it in a terminal.',
  copyUnsupported: 'Copying a launch command is available on macOS and Linux only.',
};
