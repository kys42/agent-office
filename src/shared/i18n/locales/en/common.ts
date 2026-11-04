export const common = {
  justNow: 'just now',
  minutesAgo: (m: number) => `${m}m ago`,
  hoursAgo: (h: number) => `${h}h ago`,
  daysAgo: (d: number) => `${d}d ago`,
  pathUnknown: 'Not found yet',
  crash: {
    title: 'Reopen the office?',
    body: 'Something went wrong while drawing the screen. Your original sessions are safe.',
    reload: 'Reopen',
  },
  language: {
    auto: 'System language',
  },
  /** A popup window's own on-top toggle (mini terminal, bookmark reader). */
  onTop: {
    name: 'Keep on top',
    states: { off: 'Normal window', on: 'On top' },
    hints: { off: 'Other windows can cover it', on: 'Always above other windows' },
    label: (now: string, next: string) => `Keep on top: ${now} → ${next}`,
  },
};
