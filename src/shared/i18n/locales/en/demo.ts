// Sample office for the demo and screenshots. Each entry is one desk, in seat order.
export const demo = {
  sessions: [
    {
      alias: 'Coco',
      title: 'Welcome a new teammate to the office',
      action: 'Hooking up the session collector',
    },
    {
      alias: 'Nemo',
      title: 'Make search results faster',
      action: 'Looking through the search flow',
    },
    {
      alias: 'Butler',
      title: 'Morning work briefing',
      action: "Gathering today's records",
    },
    {
      alias: 'Carrot',
      title: 'September work retro',
      action: 'Pick a title for the retro',
    },
    {
      alias: 'Beep',
      title: 'Fix the login retry bug',
      action: 'Running regression tests',
    },
    {
      alias: 'Momo',
      title: 'Tidy up components',
      action: 'All done with this reply!',
    },
    {
      alias: 'Cube',
      title: 'Time to squash a tiny bug',
      action: 'Taking a short break',
    },
    {
      alias: 'Crabby',
      title: 'Sort out the weekly schedule',
      action: 'Waiting for the next chat',
    },
  ],
  request: (title: string) =>
    `Please keep working on "${title}". Keep the direction we agreed on earlier, and check that it holds up in the real, everyday flow too.`,
  summary:
    "Here's a summary of what I've checked so far. Teammates on the same project now sit close together, and they keep their desks even when new records arrive.",
  detail:
    "Next, I'm looking at where context gets lost during real use. The latest conversation shows up first, and longer content opens up right when you need it. ",
  // The demo action leads the reply, so end it like a sentence before the summary follows.
  message(action: string) {
    const lead = /[.!?]$/.test(action) ? action : `${action}.`;
    return `${lead}\n\n${this.summary}\n\n${this.detail.repeat(5)}`;
  },
  connectorPath: 'Demo data',
  connectorMessage: 'Sample sessions · kept apart from real work',
  runtimeReason: 'Public work status in the demo',
  statusReason: 'Interactive demo · sample status',
  usageSource: 'Demo sample',
};
