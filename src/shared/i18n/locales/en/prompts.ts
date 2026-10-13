/** What a calling teammate asks (questions, a plan, a permission prompt) and answering it here. */
export const prompts = {
  /** One line for a speech bubble. */
  headline: {
    plan: 'Plan approval',
    permission: (tool: string) => `Allow ${tool}?`,
    more: (n: number) => ` (+${n} more)`,
  },
  card: {
    region: 'What it asks',
    multi: 'Pick any',
    plan: 'Plan to approve',
    planFile: (file: string) => `Plan file · ${file}`,
    showPlan: 'Show plan',
    hidePlan: 'Hide plan',
    permission: (tool: string) => `Permission · ${tool}`,
    /** The command, file or address of a permission prompt is read from its screen. */
    onScreen: 'As shown on its terminal',
    other: 'Something else',
    otherLabel: (n: number) => `Your own answer to question ${n}`,
    otherPlaceholder: 'Type your own answer',
    submit: 'Send answers',
    sending: 'Sending…',
    sent: 'Sent · waiting for the record to confirm',
    /** Choices that keep applying (always allow, auto mode…) or take words stay in the terminal. */
    more: 'Choices that keep applying (always allow, auto mode, accept edits) or that take words are made in the terminal.',
    checking: 'Reading the terminal…',
  },
  /** Why the card cannot answer here (it still offers the terminal). */
  unavailable: {
    web: 'Answer in the terminal. Answering from here works in the desktop app only.',
    'no-terminal': 'No Orca or tmux terminal found for it. Answer in the original app.',
    unsupported: (agent: string) => `${agent} prompts can't be answered from here.`,
    'not-waiting': 'It is not waiting on this prompt right now.',
    closed: 'No prompt is open on its terminal right now.',
    mismatch: "The prompt on screen isn't clearly this request. Answer in the terminal.",
    unreadable: 'Could not read its terminal screen.',
    'no-request': 'Nothing open to answer.',
    unverifiable: "This request can't be checked against the screen. Answer in the terminal.",
    off: 'Answering is off in Settings. Turn it on there, or answer in the terminal.',
  },
  /** Desktop: results and refusals of an answer. */
  result: {
    answered: (host: string) => `Answered in ${host}`,
    answeredUnconfirmed: (host: string) =>
      `Sent to ${host}, but the record has not shown the answer yet. Check the terminal.`,
    unconfirmedScreen: (host: string) =>
      `Sent to ${host}, but its screen could not be read afterwards. Check the terminal.`,
    off: 'Answering is off in Settings, so nothing was sent.',
    changed: "The prompt on screen isn't clearly this request, so nothing was sent.",
    stateChanged:
      'The prompt changed while answering and it stopped. Check the terminal before trying again.',
    notOwner: "Claude isn't in front of its terminal (paused?). Check the terminal.",
    notWaiting: "It isn't waiting on this prompt anymore.",
    notVerified:
      "The choice didn't register as expected, so it wasn't submitted. Check the terminal.",
    pressedSome: 'Some keys were already pressed there: check the terminal.',
    partial: 'It is already partly answered in the terminal. Finish it there.',
    ambiguous:
      "Some questions or options can't be told apart on screen (or the pane is too small). Answer in the terminal.",
    unverifiable: "This request can't be checked against the screen, so nothing was sent.",
    busy: 'Already answering this one. Wait for the result.',
    stillOpen: 'Sent, but the prompt is still open. Check the terminal.',
    badChoice: "That choice isn't a one-time choice on the prompt.",
    otherTooLong: (max: string) => `Keep your own answer to ${max} characters.`,
    otherEmpty: 'Type your own answer first.',
    unsupported: (agent: string) => `${agent} prompts can't be answered from here.`,
    noTarget: 'No Orca or tmux terminal found to answer in.',
    unreadable: (host: string) => `Could not read the ${host} screen, so nothing was sent.`,
    unconfirmed: (host: string) =>
      `Could not confirm what reached ${host}. Check the terminal before trying again.`,
  },
  /** Native confirmations before answering for the first time (and when turned on). */
  confirm: {
    enable: 'Turn on',
    cancel: 'Cancel',
    questions: {
      message: 'Answer questions and plan approvals from Agent Office?',
      detail:
        "Your choice is entered in the Claude Code terminal (Orca or tmux) by pressing the prompt's own keys, just as if you pressed them there, and only when the prompt on screen is exactly this request. A plan is approved only with every edit still asked (never auto mode); Claude starts working on it right away.",
    },
    permissions: {
      message: 'Answer permission prompts from Agent Office?',
      detail:
        "Your choice is entered in the Claude Code terminal (Orca or tmux) by pressing the prompt's own keys, only when the prompt on screen shows exactly this call. Only a one-time Yes or No is offered: choices that keep allowing stay in the terminal. Allowing lets that command or edit run right away. Nothing is ever allowed without you pressing a button.",
    },
  },
  settings: {
    questions: 'Answer questions & plans',
    questionsHint:
      'Answer Claude Code questions and plan approvals from the work card by pressing the prompt keys in its Orca or tmux terminal. Off until you agree: the first answer (or turning it on here) asks once.',
    permissions: 'Answer permission prompts',
    permissionsHint:
      'Allow once or deny Claude Code permission prompts from the work card the same way. Never automatic: only the button you press is sent, and choices that keep allowing stay in the terminal. Off until you agree.',
  },
};
