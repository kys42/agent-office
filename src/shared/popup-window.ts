// The app's popup windows (docs/development/POPUP-CARDS.md · 옆에 뜨는 팝업 창): small windows of their
// own that open beside the window they were asked from — the mini terminal, the bookmark reader.
// Pure placement, float and stored-size rules; desktop/popup-windows.ts owns the windows.
import { clampInto, type Rect } from './dock-geometry.js';

export interface WindowSize {
  width: number;
  height: number;
}
const GAP = 8;
const MARGIN = 8;
/** Two windows this close are "on top of each other": the newer one steps aside. */
const NEAR = 24;
const STEP = 32;

/** A remembered window size (e.g. `shell-window-size.json`), or null when not a sane one. */
export function readWindowSize(v: unknown, min: WindowSize): WindowSize | null {
  const p = v as { width?: unknown; height?: unknown } | null;
  const ok = (n: unknown, least: number) =>
    typeof n === 'number' && Number.isFinite(n) && n >= least && n <= 4000;
  return p && ok(p.width, min.width) && ok(p.height, min.height)
    ? { width: Math.round(p.width as number), height: Math.round(p.height as number) }
    : null;
}

/**
 * Where a popup window opens for the window it was asked from (`anchor`, screen coordinates):
 * to its right when there is room, else to its left, else above or below it (a wide, short row),
 * else just inside its right edge (a big window that fills the screen). Top-aligned with the
 * anchor, always inside the work area, and stepped aside (diagonally) from the same kind's
 * windows already there.
 */
export function popupWindowBounds(
  anchor: Rect,
  area: Rect,
  size: WindowSize,
  occupied: Rect[] = [],
): Rect {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  let base: Rect;
  if (anchor.x + anchor.width + GAP + width <= right)
    base = { x: anchor.x + anchor.width + GAP, y: anchor.y, width, height };
  else if (anchor.x - GAP - width >= area.x)
    base = { x: anchor.x - GAP - width, y: anchor.y, width, height };
  else if (anchor.y - GAP - height >= area.y)
    base = { x: anchor.x + anchor.width - width, y: anchor.y - GAP - height, width, height };
  else if (anchor.y + anchor.height + GAP + height <= bottom)
    base = { x: anchor.x + anchor.width - width, y: anchor.y + anchor.height + GAP, width, height };
  else
    base = {
      x: anchor.x + anchor.width - width - MARGIN,
      y: anchor.y + Math.min(48, Math.max(0, anchor.height - height)),
      width,
      height,
    };
  base = clampInto(base, area);
  // Step away from windows already there, trying each diagonal: at an edge one direction
  // clamps back onto the same spot, another still has room.
  const free = (r: Rect) =>
    !occupied.some((o) => Math.abs(o.x - r.x) < NEAR && Math.abs(o.y - r.y) < NEAR);
  for (let step = 0; step <= occupied.length; step++)
    for (const [dx, dy] of [
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ]) {
      const next = clampInto(
        { ...base, x: base.x + dx * step * STEP, y: base.y + dy * step * STEP },
        area,
      );
      if (free(next)) return next;
    }
  return base;
}

/**
 * Whether a popup floats over other apps: only beside a window that floats itself (a preview
 * card, the desk dock). The big office, a pinned card or an ordinary popup give an ordinary one.
 */
export function popupFloats(opener: { main: boolean; alwaysOnTop: boolean }) {
  return !opener.main && opener.alwaysOnTop;
}

/**
 * What opening a keyed popup does: brings the open window with that key forward, or makes a
 * new one — closing the oldest first when `max` are already open.
 */
export function popupOpenPlan<E extends { key: string }>(
  open: E[],
  key: string,
  max: number,
): { focus: E } | { create: true; evict?: E } {
  const same = open.find((e) => e.key === key);
  if (same) return { focus: same };
  return open.length >= max ? { create: true, evict: open[0] } : { create: true };
}
