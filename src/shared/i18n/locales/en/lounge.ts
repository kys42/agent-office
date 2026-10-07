export const lounge = {
  label: 'Teammate lounge',
  neon: 'Take it easy',
  intro:
    "Teammates head back to the office when there's new activity — or you can make room for them yourself.",
  project: 'Project',
  offDuty: (n: number) => `${n} off duty`,
  open: (name?: string) => (name ? `Open ${name}'s work card` : "Open teammate's work card"),
  hiddenTeammate: 'Hidden teammate',
  hiddenProject: 'Project hidden',
  active: (ago: string) => `Active ${ago}`,
  runs: (n: number) => `${n} ${n === 1 ? 'run' : 'runs'} on record`,
  bringBack: 'Bring back to office',
};
