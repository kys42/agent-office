/** The floating dock window: the desk pet, the desk row / floor desks, and the dock card. */
export const dock = {
  /** Short toast after pinning from the dock. */
  pinned: 'Pinned',
  status: {
    check: 'Check connection',
    connecting: 'Connecting',
    error: (error: string) => `Please check the connection · ${error}`,
    opening: 'Opening up the office…',
  },
  pet: {
    aria: (label: string, count: number | null) =>
      `Desk pet · ${label}${count ? ` (${count})` : ''} · click to unfold`,
    title: (total: number) =>
      `Our Office · ${total} ${total === 1 ? 'teammate' : 'teammates'}\nClick to unfold your last look (desk row or floor desks), or drag to move it`,
    unread: (n: number) => `${n} unread ${n === 1 ? 'update' : 'updates'} · `,
    detailHint: 'Click to enlarge · open the work card from the tools beside it',
    /** Stands in for the name in "Quick reply to …" when it is unknown. */
    someone: 'your teammate',
    openCard: 'Open work card',
    openCardTitle: "Open as popup · the speaking teammate's work card",
    expand: 'Expand office',
    expandTitle: 'Open the big office',
    refresh: 'Refresh',
    refreshTitle: 'Refresh · check the records again now',
    floor: 'Unfold floor desks',
    floorTitle: 'Floor desks · just desks along the bottom of your screen, zones marked by flags',
    hide: 'Hide desk pet',
    hideTitle: 'Hide · bring it back from the tray icon',
  },
  card: {
    missing: "Couldn't find this teammate",
    opening: 'Opening the work card…',
  },
};
