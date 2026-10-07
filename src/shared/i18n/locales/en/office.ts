export const office = {
  region: 'Pixel office',
  phase: { dawn: 'Early morning', day: 'Daytime', dusk: 'Dusk', night: 'Night' },
  station: (name: string, status: string) => `${name}, ${status}`,
  dragToZone: (posture: string) => `${posture} · Drag to another zone`,
  empty: {
    title: 'Waiting for the next teammate',
    body: "A desk appears as soon as there's new activity.",
    action: "See who's in the Lounge",
  },
  drop: {
    newZone: 'Drop here to start a new zone',
    moveTo: (zone?: string) => (zone ? `Move to the ${zone} zone` : 'Move to this zone'),
    elsewhere: 'Drop on another zone or on empty floor',
  },
  hud: {
    counts: (projects: number, desks: number) =>
      `${projects} ${projects === 1 ? 'project' : 'projects'} · ${desks} ${desks === 1 ? 'desk' : 'desks'}`,
    helpers: (n: number) => `${n} ${n === 1 ? 'helper' : 'helpers'}`,
    working: (n: number) => `${n} working`,
    callTitle: "Go to a teammate who's waiting",
    calling: (n: number) => `${n} calling`,
  },
  zoom: {
    outLabel: 'Zoom out of the office',
    outTitle: 'Zoom out',
    fitLabel: 'Fit the whole office',
    fitTitle: 'See every teammate at a glance',
    fit: 'Fit all',
    inLabel: 'Zoom into the office',
    inTitle: 'Zoom in · scroll to look around',
  },
  // Workspace around the map: zone tabs, toolbar, folded records and the archive room.
  spaces: 'Office spaces',
  zones: { office: 'Office', waiting: 'Lounge', archive: 'Archive' },
  live: {
    demo: 'Sample data',
    paused: 'Collection is paused',
    live: 'Checks local records every 5 seconds',
  },
  settingsLabel: 'Open office settings',
  settingsTitle: 'Change off-duty and archive rules',
  refreshLabel: 'Refresh sessions',
  refreshTitle: 'Check again now',
  veiled: {
    summary: 'Hidden teammates',
    body: 'They come back on their own with their next conversation. Pick one to show them now.',
    again: 'Show again',
    all: 'Show all again',
  },
  records: {
    summary: 'Helper & background runs',
    body: 'Helpers from earlier work and internal runs are tucked away here.',
    hidden: 'Hidden record',
    more: 'Show more',
  },
  archive: {
    title: 'Archive',
    body: 'Older records live here. Originals and notes stay just as they were.',
    hiddenSession: 'Hidden session',
    hiddenProject: 'Project hidden',
    activity: (ago: string, opens: number) =>
      `Active ${ago} · opened ${opens} ${opens === 1 ? 'time' : 'times'}`,
    byYou: 'Archived by you',
    aged: 'Auto-archived',
    bringBack: 'Bring back to office',
  },
  emptyRoom: {
    title: 'This space is empty',
    body: 'It fills up naturally as your teammates get to work.',
  },
};
