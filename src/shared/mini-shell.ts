// The mini terminal (a small shell beside the office, kept alive by tmux). Pure rules shared by
// the desktop main process (which owns the PTY) and the views (which only draw it).
import type { Session } from './types';

/** One shell kept on the dedicated tmux server, as `list` reports it. */
export interface ShellInfo {
  /** tmux session name, `shell-<16 hex>` (stable per folder). */
  name: string;
  cwd: string;
  /** Number of clients attached now (another panel, or a terminal elsewhere). */
  attached: number;
}
/** A live attachment of this window to a shell. Keystrokes go to `ptyId` only. */
export interface ShellAttachment {
  ptyId: string;
  name: string;
  cwd: string;
  /** True when this call started the shell (it did not exist yet). */
  created: boolean;
}
/** What a panel shows: a folder reached through a local session, or an existing shell. */
export interface ShellTarget {
  /** Local session whose folder the shell opens in (creates it when missing). */
  id?: string;
  /** An existing shell to reattach to. */
  name?: string;
  cwd: string;
}
export type ShellCommand =
  | { type: 'open'; id: string; cols: number; rows: number }
  | { type: 'attach'; name: string; cols: number; rows: number }
  | { type: 'list' }
  | { type: 'kill'; name: string }
  | { type: 'detach'; ptyId: string }
  | { type: 'resize'; ptyId: string; cols: number; rows: number };

export const SHELL_LIMITS = {
  minCols: 10,
  maxCols: 400,
  minRows: 3,
  maxRows: 150,
  /** One IPC write: a key, or a paste. Larger pastes are refused, not cut. */
  maxInput: 64 * 1024,
  /** The compact panel's height in rows; expanded it takes most of the window. */
  compactRows: 12,
} as const;
/** The folder's shell name: `shell-` + 16 hex of the folder token. */
export const SHELL_NAME = /^shell-[0-9a-f]{16}$/;
const PTY_ID = /^[0-9a-f-]{36}$/;
const SESSION_ID = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 400;

const size = (v: unknown, min: number, max: number) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('bad size');
  return Math.min(max, Math.max(min, Math.round(v)));
};
export const clampCols = (v: unknown) => size(v, SHELL_LIMITS.minCols, SHELL_LIMITS.maxCols);
export const clampRows = (v: unknown) => size(v, SHELL_LIMITS.minRows, SHELL_LIMITS.maxRows);

/**
 * The terminal size to use for a fitted proposal (FitAddon), within the same limits main clamps
 * the PTY to: xterm and tmux then agree on the size. Null when nothing could be measured.
 */
export function fitSize(
  proposed: { cols: number; rows: number } | undefined,
): { cols: number; rows: number } | null {
  if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return null;
  return { cols: clampCols(proposed.cols), rows: clampRows(proposed.rows) };
}
/**
 * Checks a command from a window. Anything not exactly one of these shapes is refused: the
 * renderer never names a folder, a binary or a tmux command, only a session it was shown, an
 * existing shell, or its own attachment.
 */
export function parseShellCommand(raw: unknown): ShellCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bad command');
  const c = raw as Record<string, unknown>;
  const ptyId = () => {
    if (typeof c.ptyId !== 'string' || !PTY_ID.test(c.ptyId)) throw new Error('bad pty');
    return c.ptyId;
  };
  const name = () => {
    if (typeof c.name !== 'string' || !SHELL_NAME.test(c.name)) throw new Error('bad name');
    return c.name;
  };
  switch (c.type) {
    case 'open':
      if (!SESSION_ID(c.id)) throw new Error('bad id');
      return { type: 'open', id: c.id, cols: clampCols(c.cols), rows: clampRows(c.rows) };
    case 'attach':
      return { type: 'attach', name: name(), cols: clampCols(c.cols), rows: clampRows(c.rows) };
    case 'list':
      return { type: 'list' };
    case 'kill':
      return { type: 'kill', name: name() };
    case 'detach':
      return { type: 'detach', ptyId: ptyId() };
    case 'resize':
      return { type: 'resize', ptyId: ptyId(), cols: clampCols(c.cols), rows: clampRows(c.rows) };
    default:
      throw new Error('bad command');
  }
}
/** Keystrokes for an attachment: a string within the size limit, else nothing is written. */
export function validShellInput(ptyId: unknown, data: unknown): data is string {
  return (
    typeof ptyId === 'string' &&
    PTY_ID.test(ptyId) &&
    typeof data === 'string' &&
    data.length > 0 &&
    data.length <= SHELL_LIMITS.maxInput
  );
}
/**
 * Splits a large paste into writes of at most `size` UTF-16 units, never between the two
 * halves of a surrogate pair (an emoji cut in two would reach the shell as two broken chars).
 */
export function splitInput(data: string, size = SHELL_LIMITS.maxInput / 2): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < data.length;) {
    let end = Math.min(data.length, i + size);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && end - i > 1 && last >= 0xd800 && last <= 0xdbff) end--;
    pieces.push(data.slice(i, end));
    i = end;
  }
  return pieces;
}
/** Local folders a zone can open a shell in: one per folder, never a remote office's. */
export function shellFolders(sessions: readonly Session[]): { id: string; cwd: string }[] {
  const seen = new Map<string, string>();
  for (const s of sessions)
    if (!s.remote && s.cwd && s.cwd.startsWith('/') && !seen.has(s.cwd)) seen.set(s.cwd, s.id);
  return [...seen].map(([cwd, id]) => ({ id, cwd }));
}
/** Whether a colleague's card offers a shell in their folder. */
export const canOpenShell = (s: Pick<Session, 'remote' | 'cwd'>) =>
  !s.remote && !!s.cwd && s.cwd.startsWith('/');
/** The last folder name, for a compact header (`~` stays readable for the home folder). */
export function shellLabel(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts.at(-1) ?? '/';
}
