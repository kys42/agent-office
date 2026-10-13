/** What a calling teammate asks (questions, a plan, a permission prompt) and answering it here. */
export const prompts = {
  /** One line for a speech bubble. */
  headline: {
    plan: 'Plan approval',
    permission: (tool: string, what: string) => `Allow ${tool}: ${what}`,
    permissionBare: (tool: string) => `Allow ${tool}?`,
    more: (n: number) => ` (+${n} more)`,
  },
  card: {
    region: 'What it asks',
    question: 'Question',
    questions: (n: number) => `${n} questions`,
    multi: 'Pick any',
    plan: 'Plan to approve',
    planFile: (file: string) => `Plan file · ${file}`,
    showPlan: 'Show plan',
    hidePlan: 'Hide plan',
    permission: (tool: string) => `Permission · ${tool}`,
    noSummary: 'No details recorded',
    other: 'Something else',
    otherLabel: (n: number) => `Your own answer to question ${n}`,
    otherPlaceholder: 'Type your own answer',
    submit: 'Send answers',
    sending: 'Sending…',
    sent: 'Sent · waiting for the record to confirm',
    /** The 'don't ask again' kind of choice: it keeps applying after this prompt. */
    always: 'Keeps applying',
    checking: 'Reading the terminal…',
  },
  /** Why the card cannot answer here (it still offers the terminal). */
  unavailable: {
    web: 'Answer in the terminal. Answering from here works in the desktop app only.',
    'no-terminal': 'No Orca or tmux terminal found for it. Answer in the original app.',
    unsupported: (agent: string) => `${agent} prompts can't be answered from here yet.`,
    'not-waiting': 'It is not waiting on this prompt right now.',
    closed: 'No prompt is open on its terminal right now.',
    mismatch: 'The prompt on screen differs from this request. Check the terminal.',
    unreadable: 'Could not read its terminal screen.',
    'no-request': 'Nothing open to answer.',
  },
  /** Desktop: results and refusals of an answer. */
  result: {
    answered: (host: string) => `Answered in ${host}`,
    answeredUnconfirmed: (host: string) =>
      `Sent to ${host}, but the record has not shown the answer yet. Check the terminal.`,
    off: 'Turn on answering in Settings first.',
    changed: 'The prompt on screen differs from this request, so nothing was sent.',
    stateChanged:
      'The prompt changed while answering and it stopped. Check the terminal before trying again.',
    notOwner: "Claude isn't in front of its terminal (paused?). Check the terminal.",
    notWaiting: "It isn't waiting on this prompt anymore.",
    notVerified:
      "The choice didn't register as expected, so it wasn't submitted. Check the terminal.",
    pressedSome: 'Some keys were already pressed there: check the terminal.',
    partial: 'It is already partly answered in the terminal. Finish it there.',
    busy: 'Already answering this one. Wait for the result.',
    stillOpen: 'Sent, but the prompt is still open. Check the terminal.',
    badChoice: "That choice isn't on the prompt.",
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
        "Your choice is entered in the Claude Code terminal (Orca or tmux) by pressing the prompt's own keys, just as if you pressed them there. Before every answer the app checks that the prompt on screen is exactly this request. Approving a plan lets Claude start working on it.",
    },
    permissions: {
      message: 'Answer permission prompts from Agent Office?',
      detail:
        "Your choice is entered in the Claude Code terminal (Orca or tmux) by pressing the prompt's own keys. Allowing lets that command or edit run right away, and a 'don't ask again' choice keeps allowing it. Nothing is ever allowed without you pressing a button. Before every answer the app checks that the prompt on screen is exactly this request.",
    },
  },
  settings: {
    questions: 'Answer questions & plans',
    questionsHint:
      'Answer Claude Code questions and plan approvals from the work card by pressing the prompt keys in its Orca or tmux terminal. Off by default; the first answer (or turning it on here) asks once.',
    permissions: 'Answer permission prompts',
    permissionsHint:
      'Allow or deny Claude Code permission prompts from the work card the same way. Never automatic: only the button you press is sent. Off by default; asks once.',
  },
};
