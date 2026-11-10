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
  /** Short hover/focus labels for the dock's icon buttons (drawn by the app). */
  tips: {
    hide: 'Hide · bring it back from the tray',
    grip: 'Drag to move',
  },
  card: {
    missing: "Couldn't find this teammate",
    opening: 'Opening the work card…',
  },
};
