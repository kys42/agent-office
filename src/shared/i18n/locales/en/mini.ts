export const mini = {
  title: 'Our Office',
  count: (n: number) => `${n} ${n === 1 ? 'teammate' : 'teammates'}`,
  more: ' · expand to see everyone',
  expand: 'Expand office',
  hide: 'Hide Mini Office',
  open: (name: string) => `Open ${name}`,
  unread: 'New',
  project: 'Project',
  empty: "Waiting for your teammates' records.",
};
