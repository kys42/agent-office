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
      `Our Office · ${total} ${total === 1 ? 'teammate' : 'teammates'}\nClick to open this teammate's work card, or drag to move it · the side button unfolds the desks`,
    unread: (n: number) => `${n} unread ${n === 1 ? 'update' : 'updates'} · `,
    detailHint: 'Click to enlarge · click the pet for the work card',
    /** Stands in for the name in "Quick reply to …" when it is unknown. */
    someone: 'your teammate',
    openCard: 'Open work card',
    openCardTitle: "Open as popup · the speaking teammate's work card",
    openCardOf: (name: string) => `Open ${name}'s work card`,
    expand: 'Expand office',
    expandTitle: 'Open the big office',
    refresh: 'Refresh',
    refreshTitle: 'Refresh · check the records again now',
    unfold: 'Unfold the desks',
    unfoldTitle: 'Unfold the desks · in the look you used last (office row or floor desks)',
    previous: 'Previous teammate',
    previousTitle: 'Show the previous teammate · ←',
    next: 'Next teammate',
    nextTitle: 'Show the next teammate · →',
    place: (at: number, total: number) => `${at}/${total}`,
    hide: 'Hide desk pet',
    hideTitle: 'Hide · bring it back from the tray icon',
  },
  card: {
    missing: "Couldn't find this teammate",
    opening: 'Opening the work card…',
  },
};
