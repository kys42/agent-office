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

export type DeskStation = { id: string; bench: string; remote?: boolean };
/**
 * What dropping `dragged` on `target`'s `side` would do: the marker (on a whole bench's edge,
 * where the block will land) and the local desks' new order to send. Null when the drop is no
 * target or changes nothing. A remote (federated) desk is never a target and is never sent: it
 * keeps its peer's numbering, so its place among the local desks is not ours to set.
 */
export function planDeskDrop(
  stations: DeskStation[],
  dragged: string,
  target: string,
  side: 'before' | 'after',
): { marker: { id: string; side: 'before' | 'after' }; ids: string[] } | null {
  const over = stations.find((s) => s.id === target);
  if (!over || over.remote) return null;
  const remote = new Set(stations.filter((s) => s.remote).map((s) => s.id));
  const local = (ids: string[]) => ids.filter((id) => !remote.has(id));
  const was = local(stations.map((s) => s.id));
  const ids = local(moveDesk(stations, dragged, target, side));
  if (ids.every((id, i) => id === was[i])) return null;
  const bench = stations.filter((s) => s.bench === over.bench);
  const edge = side === 'before' ? bench[0] : bench[bench.length - 1];
  return { marker: { id: edge.id, side }, ids };
}
