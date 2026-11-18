// The built-in terminal's view (#401): one window per session of the app's own terminal host,
// drawing its screen with xterm and typing into it. Pure rules shared by the desktop main
// process (which holds the connection to the daemon) and the window (which only draws).
import { clampCols, clampRows, SHELL_LIMITS } from './mini-shell';

/** A built-in terminal session's id, as the daemon accepts them. */
export const TERM_SESSION = /^[A-Za-z0-9_.-]{1,64}$/;
const VIEW_ID = /^[0-9a-f-]{36}$/;

/** What a terminal window shows: a session main chose, never one the window names. */
export interface TermTarget {
  session: string;
  /** What runs there, to show in the header (the agent and its folder). */
  title: string;
  cwd: string;
}

/** A live view of the window's session. Keys and sizes go to `viewId` only. */
export interface TermAttachment {
  viewId: string;
  /** Feed this to a fresh xterm of `cols`×`rows` first: the screen as it is now. */
  restore: string;
  cols: number;
  rows: number;
  /** The session has ended: `restore` is its last screen and nothing more comes. */
  exited?: { code: number | null; signal: number | null };
}

export type TermCommand =
  /** Attaches the window to its own session at this size (main reads which one). */
  | { type: 'attach'; cols: number; rows: number }
  | { type: 'detach'; viewId: string }
  | { type: 'resize'; viewId: string; cols: number; rows: number }
  /** Flow control: the view has too much output queued (pause) or caught up (resume). */
  | { type: 'flow'; viewId: string; paused: boolean }
  /** Ends the window's session, after the person confirmed it in main's dialog. */
  | { type: 'kill' };

/** History a view asks for on attach: the screen and a short tail (the transcript holds the rest). */
export const TERM_VIEW_SCROLLBACK = 200;

/**
 * Checks a command from a terminal window. Anything not exactly one of these shapes is refused:
 * a window never names a session, a program or a folder, only its own view.
 */
export function parseTermCommand(raw: unknown): TermCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bad command');
  const c = raw as Record<string, unknown>;
  const viewId = () => {
    if (typeof c.viewId !== 'string' || !VIEW_ID.test(c.viewId)) throw new Error('bad view');
    return c.viewId;
  };
  switch (c.type) {
    case 'attach':
      return { type: 'attach', cols: clampCols(c.cols), rows: clampRows(c.rows) };
    case 'detach':
      return { type: 'detach', viewId: viewId() };
    case 'resize':
      return { type: 'resize', viewId: viewId(), cols: clampCols(c.cols), rows: clampRows(c.rows) };
    case 'flow':
      if (typeof c.paused !== 'boolean') throw new Error('bad flow');
      return { type: 'flow', viewId: viewId(), paused: c.paused };
    case 'kill':
      return { type: 'kill' };
    default:
      throw new Error('bad command');
  }
}

/** Keystrokes for a view: a string within the size limit, else nothing is written. */
export function validTermInput(viewId: unknown, data: unknown): data is string {
  return (
    typeof viewId === 'string' &&
    VIEW_ID.test(viewId) &&
    typeof data === 'string' &&
    data.length > 0 &&
    data.length <= SHELL_LIMITS.maxInput
  );
}

/**
 * The sizes to ask for right after attaching, so the program draws its screen again (SIGWINCH):
 * a restored screen misses what the snapshot cannot hold (character sets, saved cursors). A
 * view of another size than the session's resizes it, which is already the signal; the same
 * size is nudged one row smaller and back.
 */
export function nudgeSizes(
  session: { cols: number; rows: number },
  view: { cols: number; rows: number },
): { cols: number; rows: number }[] {
  if (session.cols !== view.cols || session.rows !== view.rows) return [view];
  return [{ cols: view.cols, rows: Math.max(1, view.rows - 1) }, view];
}

/**
 * When a view should be attached: while its window is shown and the view is mounted. Hidden
 * (minimised, closed, another space where the page is hidden) it detaches, so nothing streams
 * while nobody sees it; shown again it attaches afresh and redraws from the daemon's screen.
 */
export function wantsAttach(state: { mounted: boolean; visible: boolean; ended: boolean }) {
  return state.mounted && state.visible && !state.ended;
}
