const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const shared = {
  mood: {
    call: 'Calling you',
    error: 'Needs a look',
    work: 'Working',
    think: 'Thinking',
    done: 'Responded',
    ready: 'Standing by',
    idle: 'Resting',
    sleep: 'Off duty',
    leave: 'Archived',
  },
  provider: {
    claude: 'Project session records',
    codex: 'Session logs · title DB',
    openclaw: 'Agent DB · JSONL',
  },
  activity: {
    fallback: {
      call: 'Check the original app for a question or input request',
      done: 'Finished this reply',
      ready: 'Waiting for the next request',
      idle: 'Waiting for new activity',
      sleep: 'No new activity for a while',
      leave: 'An archived work record',
      error: 'Check the work status in the original app',
    },
    noProgress: "There's a work record, but no progress note yet",
    label: {
      request: 'Request received',
      status: 'Record status',
      reply: 'Latest reply',
      lastProgress: 'Last progress update',
      progress: 'Progress update',
      message: 'Latest message',
    },
    tool: {
      terminal: 'Terminal',
      edit: 'File edit',
      read: 'File read',
      search: 'File search',
      web: 'Web lookup',
      input: 'Input request',
      check: 'Checking results',
    },
  },
  branch: {
    working: (branch: string) => `${branch} · working`,
    workingHead: (commit: string) => `HEAD · ${commit} · working`,
    workingDetail:
      'Current branch at the latest tool location · separate from the starting record.',
    workingDetachedDetail:
      'The latest worktree points at a specific commit, separate from the starting branch.',
    workingUnknown: 'Working branch unknown',
    workingUnknownDetail: "Couldn't read the Git branch at the latest location.",
    detached: 'detached',
    recordDetail: 'Branch recorded in the session',
    commit: 'commit',
    commitDetail:
      'The session recorded a commit instead of a branch name. Past records are never overwritten with the current branch.',
    current: (branch: string) => `${branch} · current`,
    currentDetail:
      "No branch in the session record, so this shows the work folder's current branch.",
    detachedDetail:
      'The work folder is in a detached HEAD state, pointing at a specific commit without a branch name.',
    folder: 'Work folder',
    folderDetail: "Couldn't find a Git repository at this work location.",
    none: 'No branch recorded',
    noneDetail: "Couldn't find a branch in the source or the current work folder.",
  },
  conversation: {
    request: 'My request',
    progress: 'Progress',
    reply: 'Final reply',
    message: 'Other reply',
    work: 'Tool log',
  },
  notice: {
    label: {
      request: 'New request',
      progress: 'Progress',
      reply: 'Final reply',
      message: 'Other reply',
      attention: 'Needs your reply',
      error: 'Needs a look',
    },
    unclassifiedReply: 'Reply · unclassified',
    read: 'Read',
    viewed: 'Opened',
    fresh: 'New',
    attention: 'Check the original app for a question or input request.',
  },
  lifecycle: {
    days: (n: number) => plural(n, 'day', 'days'),
    hours: (n: number) => plural(n, 'hour', 'hours'),
    readyFor: (minutes: number) => `Standing by ${minutes} min`,
    offDutyAfter: (duration: string) => `Off duty after ${duration}`,
    archiveAfter: (days: number) => `Archive after ${plural(days, 'day', 'days')}`,
    noAutoArchive: 'No auto-archive',
  },
  triage: {
    group: {
      attention: 'Waiting on you',
      results: 'Results to review',
      working: 'Working',
      standby: 'Standing by',
      resting: 'Resting',
    },
    justStarted: 'Just started',
    minutesIn: (m: number) => `${m}m in`,
    hoursIn: (h: number, m: number) => `${h}h ${m}m in`,
  },
  presentation: {
    posture: {
      stored: 'In the archive',
      calling: 'Waiting for your reply',
      attention: 'Needs a look',
      dozing: 'Dozing off for a bit',
      strolling: 'Stretching by the desk',
      resting: 'Resting at the desk',
      standby: 'Waiting at the desk for the next request',
      typing: 'Work log is rolling in',
      thinking: 'Preparing a reply',
      result: 'A reply has arrived',
    },
    phase: {
      working: 'Working',
      thinking: 'Preparing reply',
      'needs-input': 'Needs input',
      responded: 'Responded',
      interrupted: 'Interrupted',
      error: 'Error observed',
      quiet: 'No recent run info',
      unknown: 'Unknown',
    },
    /** Decorative focus while one task keeps going: under 5 min, 5, 15 and 30 minutes in. */
    focus: ['Working', 'Focused', 'In the zone', 'On fire'],
  },
  /** Bubble headings per kind of speech. */
  tone: {
    mine: 'My request',
    thought: 'Thinking',
    progress: 'In progress',
    reply: 'Final reply',
    attention: 'Needs your reply',
    error: 'Needs a look',
    message: 'Reply',
  },
  /** What the collapsed desk pet says about the most urgent group. */
  pet: {
    attention: 'Waiting',
    results: 'New updates',
    working: 'Working',
    standby: 'Standing by',
    resting: 'Resting',
  },
  residents: {
    scheduled: 'Scheduled run',
    internal: 'Internal helper',
    helper: 'Helper task',
    conversation: 'Conversation',
  },
  runtime: {
    archived: 'Archived by you',
    offDuty: (hours: number) =>
      `No new records for ${plural(hours, 'hour', 'hours')}+ · not confirmed whether it stopped running`,
    ready: (minutes: number) => `Finished and standing by · waiting ${minutes} min for new records`,
    quiet: 'No new records lately · running state not confirmed',
  },
  zones: {
    worktree: 'Same worktree',
    path: 'Under this folder',
    branch: 'Branch',
    session: 'This session only',
  },
  office: {
    unnamed: 'Untitled session',
    /** Stands in for the project name while screen content is hidden. */
    project: 'Project',
  },
  /** Placeholders for secrets removed from records, notes and handoffs. */
  redaction: {
    privateKey: '[private key hidden]',
    token: '[token hidden]',
    hidden: '[hidden]',
  },
  api: {
    checkConnection: 'Check the connection',
    revealDesktopOnly: 'Opening the source location is available in the desktop app.',
  },
};
