/** The floating dock window: the desk pet, the desk row / floor desks, and the dock card. */
export const dock = {
  /** Short toast after pinning from the dock. */
  arrange: {
    move: (name: string) => `Move zone · ${name}`,
    hint: 'Drag left or right · ← → (Shift: larger step) · Home/End: edges · Esc: cancel',
    reset: 'Reset zone positions',
    saveFailed: 'Could not remember positions. You can still use this layout in this window.',
  },
  pinned: 'Pinned',
  status: {
    check: 'Check connection',
    connecting: 'Connecting',
    error: (error: string) => `Please check the connection · ${error}`,
    opening: 'Opening up the office…',
  },
  pet: {
    aria: (label: string, count: number | null) =>
      `Desk pet · ${label}${count ? ` (${count})` : ''} · click to open the work card`,
    title: (total: number) =>
      `Our Office · ${total} ${total === 1 ? 'teammate' : 'teammates'}\nClick to open this teammate's work card, or drag to move it · View switches to the desks`,
    detailHint: 'Click to enlarge · click the pet for the work card',
    /** Stands in for the name in "Quick reply to …" when it is unknown. */
    someone: 'your teammate',
    openCard: 'Open work card',
    openCardTitle: "Open as popup · the speaking teammate's work card",
    openCardOf: (name: string) => `Open ${name}'s work card`,
    listOf: (group: string, n: number) => `${group} ${n} · show who`,
    previous: 'Previous teammate',
    previousTitle: 'Show the previous teammate · ←',
    next: 'Next teammate',
    nextTitle: 'Show the next teammate · →',
    place: (at: number, total: number) => `${at}/${total}`,
    hide: 'Hide desk pet',
  },
  /** The 보기 (view) menu of the pill and the pet: the dock's looks and where else to go. */
  view: {
    button: 'View',
    label: 'Change view',
    tip: 'Change view · pet, row, floor, tiny',
    menu: 'Dock view',
    pet: 'Desk pet',
    petHint: 'Just one pet on your desktop',
    row: 'Desk row',
    rowHint: "Teammates' desks in one line",
    floor: 'Floor',
    floorHint: 'Desks on the floor, by project',
    tiny: 'Tiny',
    tinyHint: 'Shrink the row or floor',
    roster: 'Teammate list',
    main: 'Open the big office',
    settings: 'Settings',
    /** The look the big office's button goes back to. */
    looks: {
      pet: 'Desk pet',
      row: 'Desk row',
      floor: 'Floor',
      tinyRow: 'Tiny row',
      tinyFloor: 'Tiny floor',
    },
  },
  /** The ＋ popover: start a new session in a project, or bring a teammate back from away. */
  plus: {
    label: 'Call a teammate',
    tip: 'Call a teammate · start new, or bring back from the lounge or archive',
    dialog: 'Call a teammate',
    tabs: { summon: 'Start new', bring: 'Bring back' },
    summonHint: 'Pick a project to open the session sheet.',
    summonNone: 'No project to start a session in yet.',
    summonUnavailable: "Starting sessions isn't available here.",
    summonPrivate: "Can't start sessions while screen content is hidden.",
    summonIn: (name: string) => `Start a new session in ${name}`,
    people: (n: number) => `${n} ${n === 1 ? 'teammate' : 'teammates'}`,
    away: 'away',
    rooms: 'Where from',
    room: { waiting: 'Lounge', archive: 'Archive' },
    roomCount: (room: string, n: number) => `${room} ${n}`,
    search: 'Search teammates',
    emptyRoom: { waiting: 'The lounge is empty.', archive: 'The archive is empty.' },
    noMatch: 'No teammate matches.',
    bring: 'Bring',
    bringOf: (name: string) => `Bring back to the office · ${name}`,
    bringTip: 'Bring back to the office',
  },
  /** 잠깐 숨기기: the desks and the pet step aside for a moment (not privacy's hiding of names). */
  peek: {
    hide: 'Hide for a moment',
    show: 'Show again',
    hideTip:
      'Hide for a moment · desks and pet step aside, the pill stays\n(Hide screen content is the privacy switch)',
    showTip: 'Show again · bring the desks and pet back',
  },
  /** Short hover/focus labels for the dock's icon buttons (drawn by the app). */
  tips: {
    hide: 'Hide · bring it back from the tray',
    grip: 'Drag to move',
    settings: 'Settings · display, notifications, connections',
  },
  card: {
    missing: "Couldn't find this teammate",
    opening: 'Opening the work card…',
  },
};
