// The mini terminal's own window (one per folder shell), opened beside the window it was asked
// from. Its sizes and target rules; placement is the shared popup rule (popup-window.ts), and
// desktop/shell-windows.ts owns the windows.
import type { Rect } from './dock-geometry.js';
import { SHELL_NAME, type ShellTarget } from './mini-shell.js';
import { popupWindowBounds, readWindowSize, type WindowSize } from './popup-window.js';

/** First size of a terminal window; the person's own resize is remembered after that. */
export const SHELL_WINDOW_SIZE = { width: 640, height: 400 };
/** Still a header and a few lines of a terminal. */
export const SHELL_WINDOW_MIN = { width: 360, height: 200 };
/** Terminal windows open at once; opening one more closes (detaches) the oldest. */
export const SHELL_WINDOW_MAX = 6;

/** A remembered terminal window size (`shell-window-size.json`), or null when not a sane one. */
export function readShellWindowSize(v: unknown): WindowSize | null {
  return readWindowSize(v, SHELL_WINDOW_MIN);
}

/**
 * Where a terminal window opens for the window it was asked from: the popup rule
 * (`popupWindowBounds`) at the terminal's size, stepped aside from terminal windows already there.
 */
export function shellWindowBounds(
  anchor: Rect,
  area: Rect,
  size: WindowSize = SHELL_WINDOW_SIZE,
  occupied: Rect[] = [],
): Rect {
  return popupWindowBounds(anchor, area, size, occupied);
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
