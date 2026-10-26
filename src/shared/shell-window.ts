// The mini terminal's own window (one per folder shell), opened beside the window it was asked
// from. Pure placement and stored-size rules; desktop/shell-windows.ts owns the windows.
import { clampInto, type Rect } from './dock-geometry.js';
import { SHELL_NAME, type ShellTarget } from './mini-shell.js';

/** First size of a terminal window; the person's own resize is remembered after that. */
export const SHELL_WINDOW_SIZE = { width: 640, height: 400 };
/** Still a header and a few lines of a terminal. */
export const SHELL_WINDOW_MIN = { width: 360, height: 200 };
/** Terminal windows open at once; opening one more closes (detaches) the oldest. */
export const SHELL_WINDOW_MAX = 6;
const GAP = 8;
const MARGIN = 8;
/** Two windows this close are "on top of each other": the newer one steps aside. */
const NEAR = 24;
const STEP = 32;

/** A remembered terminal window size (`shell-window-size.json`), or null when not a sane one. */
export function readShellWindowSize(v: unknown): { width: number; height: number } | null {
  const p = v as { width?: unknown; height?: unknown } | null;
  const ok = (n: unknown, min: number) =>
    typeof n === 'number' && Number.isFinite(n) && n >= min && n <= 4000;
  return p && ok(p.width, SHELL_WINDOW_MIN.width) && ok(p.height, SHELL_WINDOW_MIN.height)
    ? { width: Math.round(p.width as number), height: Math.round(p.height as number) }
    : null;
}

/**
 * Where a terminal window opens for the window it was asked from (`anchor`, screen coordinates):
 * to its right when there is room, else to its left, else above or below it (a wide, short row),
 * else just inside its right edge (a big window that fills the screen). Top-aligned with the
 * anchor, always inside the work area, and stepped aside from terminal windows already there.
 */
export function shellWindowBounds(
  anchor: Rect,
  area: Rect,
  size: { width: number; height: number } = SHELL_WINDOW_SIZE,
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

/** What a window may ask to open: a local session (by id) or an existing shell (by name). */
export function parseShellWindowTarget(raw: unknown): ShellTarget {
  const t = raw as { id?: unknown; name?: unknown; cwd?: unknown } | null;
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('bad target');
  const cwd = typeof t.cwd === 'string' && t.cwd.length <= 4096 ? t.cwd : '';
  if (typeof t.name === 'string') {
    if (!SHELL_NAME.test(t.name)) throw new Error('bad name');
    return { name: t.name, cwd };
  }
  if (typeof t.id === 'string' && t.id.length > 0 && t.id.length <= 400) return { id: t.id, cwd };
  throw new Error('bad target');
}
