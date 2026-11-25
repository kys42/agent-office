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
  /**
   * What the office calls it (사무실 별명) or the agent's own name (a teammate's member name, a
   * named agent); empty when it has none.
   */
  alias?: string;
  /** The conversation's own title (a `/rename` title or the one the office shows). */
  title?: string;
  /** Its project as the office groups it (`projectKey` / `zoneLabel`). */
  project?: TermProject;
  /** Epoch ms of its latest activity. */
  updatedAt?: number;
}

/** A project heading of the session list: the office's own zone key and name. */
export interface TermProject {
  key: string;
  name: string;
}

export interface BuiltinSessionRow {
  id: string;
  /** The program's name (`claude`, `codex`, …), not its arguments. Empty while hidden. */
  program: string;
  /** The session's folder. Empty while screen content is hidden. */
  cwd: string;
  /** The conversations of the office found running here (none when not located). */
  agents: BuiltinSessionAgent[];
  /**
   * The project it belongs to: its conversation's, else the office project whose folder holds
   * its folder, else its folder. Missing while screen content is hidden.
   */
  project?: TermProject;
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
  /** Bytes its program printed so far (the manager's busy hint compares two lists). */
  output?: number;
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

// ─── The terminal manager (터미널 관리 창) ─────────────────────────────────────────────────────
// One window over the daemon's sessions, cmux/Orca-like: a list on the left, the selected
// session on the right. Only the selected one is attached (a live xterm); the others show at
// most a few rows of their visible screen, read now and then while the window is seen.

/** Where "go to its terminal" opens a built-in session. Missing: the manager. */
export const BUILTIN_OPEN_IN = ['manager', 'window'] as const;
export type BuiltinOpenIn = (typeof BUILTIN_OPEN_IN)[number];

/** Ended sessions the manager still lists (most recently ended first): the latest only. */
export const TERM_MANAGER_ENDED_MAX = 3;
/** Rows of a session's visible screen its preview shows. */
export const TERM_MANAGER_PREVIEW_ROWS = 3;
/** Sessions previewed per read (the newest running ones besides the selected one). */
export const TERM_MANAGER_PREVIEW_MAX = 8;
/** A preview row is cut to this many characters. */
export const TERM_MANAGER_PREVIEW_COLS = 160;
/** How often previews are read again, only while the manager is seen. */
export const TERM_MANAGER_PREVIEW_MS = 5000;

/** The manager's rows: every running session (newest first), then the latest few ended ones. */
export function managerRows(listing: BuiltinListing | null): BuiltinSessionRow[] {
  if (!listing) return [];
  const running = listing.sessions.filter((s) => !s.exit);
  const ended = listing.sessions.filter((s) => s.exit).slice(0, TERM_MANAGER_ENDED_MAX);
  return [...running, ...ended];
}

/**
 * The sessions worth a preview now: running ones other than the selected one, the newest
 * first, at most `TERM_MANAGER_PREVIEW_MAX`. None while screen content is hidden.
 */
export function previewTargets(
  rows: BuiltinSessionRow[],
  selected: string | null,
  hidden: boolean,
): string[] {
  if (hidden) return [];
  return rows
    .filter((r) => !r.exit && r.id !== selected)
    .slice(0, TERM_MANAGER_PREVIEW_MAX)
    .map((r) => r.id);
}

/**
 * A preview of a visible screen: its last non-blank rows above and at the cursor (what the
 * program drew last), trimmed, each cut to `TERM_MANAGER_PREVIEW_COLS`, control characters
 * dropped.
 */
export function previewLines(
  screen: { lines: string[]; cursor?: { y: number } },
  rows = TERM_MANAGER_PREVIEW_ROWS,
): string[] {
  const end = Math.min(
    screen.lines.length,
    screen.cursor && screen.cursor.y >= 0 ? screen.cursor.y + 1 : screen.lines.length,
  );
  const out: string[] = [];
  for (let i = end - 1; i >= 0 && out.length < rows; i--) {
    // eslint-disable-next-line no-control-regex
    const line = (screen.lines[i] ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (line) out.unshift(line.slice(0, TERM_MANAGER_PREVIEW_COLS));
  }
  return out;
}

/** Checks a preview request from the manager: a short list of valid, distinct session ids. */
export function parsePreviewRequest(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > TERM_MANAGER_PREVIEW_MAX) throw new Error('bad preview');
  const ids = raw.map((id) => {
    if (typeof id !== 'string' || !TERM_SESSION.test(id)) throw new Error('bad session');
    return id;
  });
  return [...new Set(ids)];
}

/** Checks a session id the manager names (to select or act on). */
export function parseManagerSession(raw: unknown): string {
  if (typeof raw !== 'string' || !TERM_SESSION.test(raw)) throw new Error('bad session');
  return raw;
}

/**
 * Whether a running session printed something since the list before: its program's output
 * count moved (a cheap "busy" hint; a redraw after a resize counts too). Unknown: false.
 */
export function outputMoved(
  before: BuiltinSessionRow | undefined,
  now: BuiltinSessionRow,
): boolean {
  if (now.exit || before?.output === undefined || now.output === undefined) return false;
  return now.output > before.output;
}

/** A manager shortcut: select the nth row (0-based), step through the rows, or close. */
export type ManagerKey = { select: number } | { step: 1 | -1 } | { close: true };

/**
 * The manager's own keys, read before the terminal sees them: ⌘1…⌘9 select, ⌘⇧[ / ⌘⇧] and
 * ⌃Tab / ⌃⇧Tab step, ⌘W closes the window (the sessions keep running). Anything else is the
 * terminal's (⌘0 stays the font reset).
 */
export function managerKey(e: {
  type?: string;
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}): ManagerKey | null {
  if ((e.type !== undefined && e.type !== 'keydown') || e.isComposing || e.altKey) return null;
  if (e.ctrlKey && !e.metaKey && e.key === 'Tab') return { step: e.shiftKey ? -1 : 1 };
  if (!e.metaKey || e.ctrlKey) return null;
  if (e.shiftKey) {
    if (e.code === 'BracketLeft' || e.key === '{' || e.key === '[') return { step: -1 };
    if (e.code === 'BracketRight' || e.key === '}' || e.key === ']') return { step: 1 };
    return null;
  }
  const digit = /^Digit([1-9])$/.exec(e.code ?? '')?.[1] ?? (/^[1-9]$/.test(e.key) ? e.key : '');
  if (digit) return { select: Number(digit) - 1 };
  if (e.code === 'KeyW' || e.key.toLowerCase() === 'w') return { close: true };
  return null;
}

/** The row `step` away from the selected one, wrapping around; the first when none is. */
export function stepSelection(rows: { id: string }[], selected: string | null, step: 1 | -1) {
  if (!rows.length) return null;
  const at = rows.findIndex((r) => r.id === selected);
  if (at < 0) return rows[0].id;
  return rows[(at + step + rows.length) % rows.length].id;
}

// ─── Row titles and project groups ─────────────────────────────────────────────────────────────
// Shared by Settings › 내장 터미널 and the terminal manager: which name a row shows first, and the
// project headings the rows sit under.

/** What a preview read gives besides its rows: the program's window title (OSC 0/2). */
export interface TermPreview {
  lines: string[];
  /** The title the program set; '' or missing when it set none. */
  title?: string;
}

/** Where a row's title came from (most telling first). */
export type TermTitleSource =
  'alias' | 'session' | 'terminal' | 'prompt' | 'path' | 'program' | 'id';

/** A prompt's input as a shell draws it: `user@host dir % make test` → `make test`. */
const PROMPT = /(?:^|\s)[$%#❯➜›»]\s+(\S.*)$/;

/** The command typed at the last prompt among these rows, if one looks like a prompt. */
export function promptCommand(lines: string[] | undefined): string {
  if (!lines) return '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const hit = PROMPT.exec(lines[i] ?? '');
    if (hit) return hit[1].trim();
  }
  return '';
}

/**
 * A row's title, most telling first: (a) the office nickname or agent name of the conversations
 * running there, (b) their session titles, and with none linked (c) the title the program set or
 * the command at its last prompt, (d) its short folder, then its program and id. Hidden: the id.
 */
export function termRowTitle(
  row: Pick<BuiltinSessionRow, 'id' | 'program' | 'cwd' | 'agents'>,
  preview: TermPreview | undefined,
  hidden: boolean,
  short: (path: string) => string = (p) => p,
): { text: string; source: TermTitleSource } {
  if (hidden) return { text: row.id, source: 'id' };
  const names = [...new Set(row.agents.map((a) => a.alias || a.title || a.name).filter(Boolean))];
  if (names.length)
    return {
      text: names.join(', '),
      source: row.agents.some((a) => a.alias) ? 'alias' : 'session',
    };
  const title = (preview?.title ?? '').trim();
  // A title that only repeats the program or folder tells nothing new.
  if (title && title !== row.program && title !== row.cwd && title !== short(row.cwd))
    return { text: title.slice(0, TERM_MANAGER_PREVIEW_COLS), source: 'terminal' };
  const typed = promptCommand(preview?.lines);
  if (typed) return { text: typed.slice(0, TERM_MANAGER_PREVIEW_COLS), source: 'prompt' };
  if (row.cwd) return { text: short(row.cwd), source: 'path' };
  if (row.program) return { text: row.program, source: 'program' };
  return { text: row.id, source: 'id' };
}

/** A project heading and its rows, in the order the list draws them. */
export interface TermGroup {
  /** '' for the one unnamed group (screen content hidden, or no folder known). */
  key: string;
  name: string;
  rows: BuiltinSessionRow[];
  /** Its latest activity (epoch ms). */
  at: number;
  /** Some session of it still runs. */
  running: boolean;
}

/** A session's latest activity: its start, its conversations' latest turn, or its end. */
export const rowActivity = (r: BuiltinSessionRow) =>
  Math.max(r.startedAt, r.exit?.at ?? 0, ...r.agents.map((a) => a.updatedAt ?? 0));

/**
 * The rows under their project headings: projects with a running session first, the most
 * recently active first; inside one, the rows keep their order. Rows without a project (screen
 * content hidden) make one unnamed group.
 */
export function groupRows(rows: BuiltinSessionRow[]): TermGroup[] {
  const groups = new Map<string, TermGroup>();
  for (const row of rows) {
    const key = row.project?.key ?? '';
    let g = groups.get(key);
    if (!g) {
      g = { key, name: row.project?.name ?? '', rows: [], at: 0, running: false };
      groups.set(key, g);
    }
    g.rows.push(row);
    g.at = Math.max(g.at, rowActivity(row));
    g.running ||= !row.exit;
  }
  return [...groups.values()].sort(
    (a, b) => Number(b.running) - Number(a.running) || b.at - a.at || a.name.localeCompare(b.name),
  );
}

/** The rows in the order the grouped list shows them (what ⌘1…9 and stepping follow). */
export const groupedOrder = (groups: TermGroup[]) => groups.flatMap((g) => g.rows);
