import { cardBounds, clampInto, type Point, type Rect } from './dock-geometry.js';

/** The preferred opening point is local presentation state, not a colleague pin. */
export function readCardPosition(raw: unknown): Point | null {
  const p = raw as { enabled?: unknown; x?: unknown; y?: unknown } | null;
  return p?.enabled === true &&
    typeof p.x === 'number' &&
    typeof p.y === 'number' &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    Math.abs(p.x) <= 100_000 &&
    Math.abs(p.y) <= 100_000
    ? { x: Math.round(p.x), y: Math.round(p.y) }
    : null;
}

export function popupBounds(
  anchor: Rect,
  area: Rect,
  size: { width: number; height: number },
  position: Point | null,
  occupied: Rect[] = [],
): Rect {
  const base = position
    ? clampInto({ ...position, ...size }, area)
    : cardBounds(anchor, area, size);
  // Keep the existing pinned windows still and leave their headers reachable.
  for (let step = 0; step <= occupied.length + 1; step++) {
    for (const sign of [1, -1]) {
      const next = clampInto(
        { ...base, x: base.x + step * 40 * sign, y: base.y + step * 40 * sign },
        area,
      );
      if (!occupied.some((r) => Math.abs(r.x - next.x) < 24 && Math.abs(r.y - next.y) < 24))
        return next;
    }
  }
  return base;
}
