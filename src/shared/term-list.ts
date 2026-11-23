// The built-in terminal's session list (Settings › 내장 터미널): what runs in the app's terminal
// host daemon in the background, and what the person can do with each session. The main process
// builds the list (desktop/term-list.ts); Settings only draws it.
import { TERM_SESSION } from './term-view';

/** An office conversation found running in a session (located like a jump). */
export interface BuiltinSessionAgent {
  /** The office session id (opens its card). */
  id: string;
  /** Its colleague name (alias) or title. */
  name: string;
  provider: string;
}

export interface BuiltinSessionRow {
  id: string;
  /** The program's name (`claude`, `codex`, …), not its arguments. Empty while hidden. */
  program: string;
  /** The session's folder. Empty while screen content is hidden. */
  cwd: string;
  /** The conversations of the office found running here (none when not located). */
  agents: BuiltinSessionAgent[];
  /** Epoch ms. */
  startedAt: number;
  /** The session's own process (the agent, run directly). */
  pid: number;
  /** That process's resident memory in bytes, when it could be read. */
  rss?: number;
  /** Ended (the daemon keeps its last screen a few minutes). */
  exit?: { code: number | null; signal: number | null; at: number };
  /** One of the app's terminal windows shows it now. */
  windowOpen: boolean;
  /** Views attached in the daemon now (a shown window attaches; a hidden one does not). */
  attached: number;
}

export interface BuiltinDaemonSummary {
  pid: number;
  startedAt: number;
  /** The daemon process's resident memory in bytes. */
  rss: number;
  live: number;
  sessions: number;
}

export interface BuiltinListing {
  /** This platform has a built-in terminal at all. */
  supported: boolean;
  /** No daemon runs (nothing to list); `error` when one runs but did not answer. */
  daemon: BuiltinDaemonSummary | null;
  sessions: BuiltinSessionRow[];
  /** Screen content is hidden: folders, programs and names are left out. */
  hidden: boolean;
  error?: string;
}

/** What Settings can do with one session. */
export type BuiltinSessionAction = 'open' | 'hide' | 'kill';
export const BUILTIN_SESSION_ACTIONS: readonly BuiltinSessionAction[] = ['open', 'hide', 'kill'];

/** Checks an action request from a page: a session id the daemon accepts and a known action. */
export function parseBuiltinAction(
  session: unknown,
  action: unknown,
): { session: string; action: BuiltinSessionAction } {
  if (typeof session !== 'string' || !TERM_SESSION.test(session)) throw new Error('bad session');
  if (!BUILTIN_SESSION_ACTIONS.includes(action as BuiltinSessionAction))
    throw new Error('bad action');
  return { session, action: action as BuiltinSessionAction };
}

/** How often Settings refreshes the list while it is on screen. */
export const BUILTIN_LIST_REFRESH_MS = 3000;

/** Rough size for a row (`214 MB`). */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
