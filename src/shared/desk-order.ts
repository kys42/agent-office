/**
 * A zone's desks after dragging `dragged` before or after `target`. A shared bench (same
 * worktree + branch) is one long desk, so its members move together as one block, and a drop
 * on another bench's member lands beside that whole bench.
 */
export function moveDesk(
  stations: { id: string; bench: string }[],
  dragged: string,
  target: string,
  side: 'before' | 'after',
): string[] {
  const ids = stations.map((s) => s.id);
  const from = stations.find((s) => s.id === dragged)?.bench;
  const to = stations.find((s) => s.id === target)?.bench;
  if (from === undefined || to === undefined || from === to) return ids;
  const block = stations.filter((s) => s.bench === from);
  const rest = stations.filter((s) => s.bench !== from);
  let at = rest.findIndex((s) => s.bench === to);
  if (side === 'after') while (at < rest.length && rest[at].bench === to) at++;
  return [...rest.slice(0, at), ...block, ...rest.slice(at)].map((s) => s.id);
}
