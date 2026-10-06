// Adapted from Pixel Agents tileMap.ts (MIT), Pablo De Lucca, 2026.
// Original and full license: vendor/pixel-agents/. Numeric map removed; fixed office obstacles supplied by caller.
export type Tile = { col: number; row: number };
export function findPath(
  start: Tile,
  end: Tile,
  blocked: Set<string>,
  cols = 40,
  rows = 30,
): Tile[] {
  const key = (p: Tile) => `${p.col},${p.row}`;
  const walk = (p: Tile) =>
    p.col >= 1 && p.row >= 6 && p.col < cols - 1 && p.row < rows - 1 && !blocked.has(key(p));
  if (key(start) === key(end) || !walk(end)) return [];
  const visited = new Set([key(start)]),
    parent = new Map<string, Tile>();
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (key(current) === key(end)) {
      const result: Tile[] = [];
      let p = end;
      while (key(p) !== key(start)) {
        result.unshift(p);
        p = parent.get(key(p))!;
      }
      return result;
    }
    for (const [x, y] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ]) {
      const p = { col: current.col + x, row: current.row + y };
      if (!walk(p) || visited.has(key(p))) continue;
      visited.add(key(p));
      parent.set(key(p), current);
      queue.push(p);
    }
  }
  return [];
}
