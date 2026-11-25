import path from 'node:path';
import type {
  BuiltinListing,
  BuiltinSessionAction,
  BuiltinSessionAgent,
  BuiltinSessionRow,
  TermPreview,
  TermProject,
} from '../src/shared/term-list.js';
import type { Session, ZoneRule } from '../src/shared/types.js';
import { projectKey } from '../src/shared/office.js';
import { applyZone, zoneLabel } from '../src/shared/zones.js';
import {
  parseManagerSession,
  parsePreviewRequest,
  previewLines,
  TERM_MANAGER_PREVIEW_COLS,
} from '../src/shared/term-list.js';
import type { TermTarget } from '../src/shared/term-view.js';
import type { ListResult, ScreenRead, SessionStats } from './term-host/protocol.js';

/**
 * Settings › 내장 터미널: the sessions the app's terminal host daemon keeps running in the
 * background (docs/development/TERM-HOST.md), joined with what only the app knows (which window
 * shows one, which office conversation runs in it, how much memory its process holds), and the
 * actions on one. The page only draws the result; nothing here starts a daemon.
 */
export interface TermListDeps {
  /** This platform has a built-in terminal. */
  supported: boolean;
  /** The daemon's list (`TermBuiltin.listing`); null when none runs. */
  listing(fresh: boolean): Promise<ListResult | null>;
  /** Screen content is hidden (`preferences.privacy`): no folder, program or name leaves. */
  hidden(): boolean;
  /** One of the app's terminal windows shows this session now. */
  windowOpen(session: string): boolean;
  /** The office conversations running in these live sessions (see `officeAgentsIn`). */
  agents(sessions: { id: string; cwd: string }[]): Promise<Map<string, BuiltinSessionAgent[]>>;
  /** Resident memory in bytes by pid, for the ones that could be read (see `psRss`). */
  memory?(pids: number[]): Promise<Map<number, number>>;
  /** The office project holding a folder no conversation was found in (see `folderProject`). */
  project?(cwd: string): TermProject | null;
}

export async function builtinListing(deps: TermListDeps, fresh = true): Promise<BuiltinListing> {
  const hiddenAtStart = deps.hidden();
  const empty: BuiltinListing = {
    supported: deps.supported,
    daemon: null,
    sessions: [],
    hidden: hiddenAtStart,
  };
  if (!deps.supported) return empty;
  let list: ListResult | null;
  try {
    list = await deps.listing(fresh);
  } catch (error) {
    return { ...empty, error: (error as Error).message };
  }
  if (!list) return empty;
  const live = list.sessions.filter((s) => !s.exit);
  const [agents, memory] = await Promise.all([
    hiddenAtStart
      ? new Map<string, BuiltinSessionAgent[]>()
      : deps.agents(live.map((s) => ({ id: s.id, cwd: s.cwd }))).catch(() => new Map()),
    deps.memory?.(live.map((s) => s.pid)).catch(() => new Map<number, number>()) ??
      new Map<number, number>(),
  ]);
  // Hiding turned on while the lookups ran still hides this answer.
  const hidden = hiddenAtStart || deps.hidden();
  const sessions: BuiltinSessionRow[] = list.sessions
    .map((s) => {
      const rss = s.exit ? undefined : memory.get(s.pid);
      const found = agents.get(s.id) ?? [];
      return {
        id: s.id,
        program: hidden ? '' : path.basename(s.argv[0] ?? ''),
        cwd: hidden ? '' : s.cwd,
        agents: hidden ? [] : found,
        ...(!hidden && { project: rowProject(s.cwd, found, deps) }),
        startedAt: s.createdAt,
        pid: s.pid,
        ...(rss !== undefined && { rss }),
        ...(s.exit && { exit: { code: s.exit.code, signal: s.exit.signal, at: s.exit.at } }),
        windowOpen: deps.windowOpen(s.id),
        attached: s.attached,
        ...(typeof s.bytesIn === 'number' && { output: s.bytesIn }),
      };
    })
    // Running first, newest first; ended ones after, most recently ended first.
    .sort((a, b) =>
      !!a.exit !== !!b.exit
        ? a.exit
          ? 1
          : -1
        : a.exit && b.exit
          ? b.exit.at - a.exit.at
          : b.startedAt - a.startedAt,
    );
  return {
    supported: true,
    hidden,
    daemon: {
      pid: list.daemon.pid,
      startedAt: list.daemon.startedAt,
      rss: list.total.rss,
      live: live.length,
      sessions: list.sessions.length,
    },
    sessions,
  };
}

/** A row's project: its conversation's, else the office's for its folder, else its folder. */
function rowProject(
  cwd: string,
  agents: BuiltinSessionAgent[],
  deps: Pick<TermListDeps, 'project'>,
): TermProject {
  const linked = agents.find((a) => a.project)?.project;
  if (linked) return linked;
  const known = (() => {
    try {
      return deps.project?.(cwd) ?? null;
    } catch {
      return null;
    }
  })();
  return known ?? { key: path.resolve(cwd), name: path.basename(cwd) || cwd };
}

/** A conversation of the office, as `officeAgentsIn` needs it (a snapshot session). */
export interface OfficeConversation {
  id: string;
  provider: string;
  nativeId: string;
  cwd?: string | null;
  remote?: unknown;
  alias?: string | null;
  title: string;
  updatedAt: number;
  project?: string;
  branch?: string | null;
  agentName?: string;
  resident?: { name?: string } | null;
  relation?: { team?: string } | null;
  workspace?: Session['workspace'];
  area?: Session['area'];
}

/**
 * What the office calls a conversation, besides its title: its resident name, the person's
 * nickname for it (사무실 별명), a team member's name (its title is that name) or the agent's own
 * name. Empty when it has none.
 */
export const officeNickname = (c: OfficeConversation) =>
  (c.resident?.name || c.alias || (c.relation?.team ? c.title : '') || c.agentName || '')
    .replace(/\s+/g, ' ')
    .trim();

/** A conversation's project as the office groups it: its zone key and the zone's name. */
export function conversationProject(c: OfficeConversation): TermProject {
  // The office's own grouping (custom areas, then the repository, then the folder).
  const session = { ...c, cwd: c.cwd ?? null, project: c.project ?? '' } as unknown as Session;
  const key = projectKey(session);
  const name = zoneLabel(session) || c.workspace?.name || path.basename(c.cwd ?? '') || key;
  return { key, name };
}

/**
 * The office project a folder belongs to when no conversation runs in it: the office's local
 * conversation whose folder, worktree or repository holds it (the deepest) gives the repository,
 * and the office's own area rules (`rules`) are applied to this folder itself. A rule that holds
 * that conversation but not this folder (a narrower path, its worktree, its own session) does not
 * carry over: only the repository does.
 */
export function folderProject(
  cwd: string,
  conversations: OfficeConversation[],
  rules: ZoneRule[] = [],
): TermProject | null {
  const folder = path.resolve(cwd);
  const holds = (root: string | null | undefined) => {
    if (!root) return 0;
    const r = path.resolve(root);
    return folder === r || folder.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
      ? r.length
      : 0;
  };
  let best: { depth: number; at: number; c: OfficeConversation; sameTree: boolean } | null = null;
  for (const c of conversations) {
    if (c.remote) continue;
    const tree = Math.max(holds(c.cwd), holds(c.workspace?.worktree));
    const repo = c.workspace?.evidence === 'git-common-dir' ? holds(c.workspace.root) : 0;
    const depth = Math.max(tree, repo);
    if (!depth) continue;
    if (!best || depth > best.depth || (depth === best.depth && c.updatedAt > best.at))
      best = { depth, at: c.updatedAt, c, sameTree: tree > 0 };
  }
  if (!best) return null;
  const { c, sameTree } = best;
  // This folder as a session of its own: the conversation's repository, its worktree and branch
  // only when the folder is inside that worktree, never its area or its id.
  const own = {
    ...c,
    id: `term-folder:${folder}`,
    cwd: folder,
    area: undefined,
    ...(sameTree
      ? {}
      : {
          branch: null,
          project: c.workspace?.name ?? c.project,
          workspace: c.workspace && { ...c.workspace, worktree: null, git: undefined },
        }),
  } as unknown as Session;
  const area = applyZone(own, rules).area;
  if (area) return { key: area.key, name: area.name };
  // No area of its own: the conversation's project (its folder's, or its repository's).
  return conversationProject(
    sameTree ? { ...c, area: undefined } : (own as unknown as OfficeConversation),
  );
}

/** Where a provider's live conversation runs (its adapter's terminal lookup). */
export type TerminalLocator = (
  nativeId: string,
) => Promise<{ host: { kind: string; session?: string } } | null>;

/**
 * The office's conversations running in each built-in session: the local ones in a session's
 * folder, located the way a jump locates them (each provider's own lookup, `locators`), at most
 * `limit` per folder, newest first. A provider without a lookup is never matched.
 */
export async function officeAgentsIn(
  sessions: { id: string; cwd: string }[],
  conversations: OfficeConversation[],
  locators: Partial<Record<string, TerminalLocator>>,
  limit = 20,
): Promise<Map<string, BuiltinSessionAgent[]>> {
  const found = new Map<string, BuiltinSessionAgent[]>();
  const wanted = new Set(sessions.map((s) => s.id));
  const folders = new Set(sessions.map((s) => path.resolve(s.cwd)));
  const perFolder = new Map<string, number>();
  const candidates = conversations
    .filter((c) => !c.remote && !!c.cwd && folders.has(path.resolve(c.cwd)) && locators[c.provider])
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((c) => {
      const folder = path.resolve(c.cwd!);
      const n = perFolder.get(folder) ?? 0;
      perFolder.set(folder, n + 1);
      return n < limit;
    });
  for (const c of candidates) {
    const terminal = await locators[c.provider]!(c.nativeId).catch(() => null);
    const session = terminal?.host.kind === 'builtin' ? terminal.host.session : undefined;
    if (!session || !wanted.has(session)) continue;
    const list = found.get(session) ?? [];
    const alias = officeNickname(c);
    list.push({
      id: c.id,
      name: alias || c.title,
      provider: c.provider,
      ...(alias && { alias }),
      ...(c.title && { title: c.title }),
      project: conversationProject(c),
      updatedAt: c.updatedAt,
    });
    found.set(session, list);
  }
  return found;
}

/** `ps -o pid=,rss=` output (rss in KB) as bytes by pid. */
export function parseRss(table: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), Number(m[2]) * 1024);
  }
  return out;
}

/** Resident memory of these pids from one `ps` call (none asked: no call). */
export function psRss(run: (file: string, args: string[]) => Promise<string>) {
  return async (pids: number[]): Promise<Map<number, number>> => {
    const valid = pids.filter((p) => Number.isInteger(p) && p > 0);
    if (!valid.length) return new Map();
    // ps exits 1 when some pid is gone; what it printed for the others still counts.
    const out = await run('/bin/ps', ['-o', 'pid=,rss=', '-p', valid.join(',')]).catch(
      (error: { stdout?: string }) => error?.stdout ?? '',
    );
    return parseRss(out);
  };
}

/** What an action on one session needs from the app. */
export interface TermActionDeps {
  /** Opens (or brings forward) the session's window; refuses with a reason. */
  show(session: string): Promise<unknown>;
  /** Closes the session's window, if one is open (the session keeps running). */
  hide(session: string): boolean;
  /** Asks the person, then ends the session: true once ended, false when they cancelled. */
  kill(session: string): Promise<boolean>;
}

/**
 * A session's own terminal windows (`TermWindows`): what a row's 열기 opens, its 숨기기 closes
 * and its "window open" state reads. All three must mean the same windows, so a row opened from
 * the list shows as open and can be hidden again (the terminal manager is not one of them).
 */
export interface SessionWindows {
  open(session: string): Promise<unknown>;
  close(session: string): boolean;
  has(session: string): boolean;
}

/** The actions of a list row (Settings, the terminal manager) on a session's own window. */
export function rowActions(
  windows: SessionWindows,
  kill: (session: string) => Promise<boolean>,
): TermActionDeps {
  return { show: (id) => windows.open(id), hide: (id) => windows.close(id), kill };
}

/** Runs one Settings action; answers whether something changed. */
export async function builtinAction(
  deps: TermActionDeps,
  session: string,
  action: BuiltinSessionAction,
): Promise<boolean> {
  switch (action) {
    case 'open':
      await deps.show(session);
      return true;
    case 'hide':
      return deps.hide(session);
    case 'kill':
      return deps.kill(session);
  }
}

/** What runs in a built-in session, for a terminal's header: the agent and its folder. */
export const termTitle = (s: Pick<SessionStats, 'argv' | 'cwd'>) =>
  `${path.basename(s.argv[0] ?? '')} · ${path.basename(s.cwd) || s.cwd}`;

/**
 * The terminal manager's requests (터미널 관리 창, docs/development/TERM-HOST.md): choosing the
 * session it shows and reading previews of the others. The window names sessions, so each is
 * checked here against the daemon's own list; nothing here starts a daemon.
 */
export interface TermManagerDeps {
  /** Screen content is hidden (`preferences.privacy`). */
  hidden(): boolean;
  /** The daemon's list (`TermBuiltin.listing`); null when none runs. */
  listing(fresh: boolean): Promise<ListResult | null>;
  /** A live session's visible screen (`TermBuiltin.screen`). */
  screen(session: string): Promise<{
    lines: string[];
    cursor?: Pick<ScreenRead['cursor'], 'y'>;
    title?: string;
  }>;
  /** The refusals said to the person. */
  messages: { hidden: string; gone: string };
}

/**
 * Selects a session for the manager to show: one the daemon lists (running, or ended with its
 * last screen still kept). Refused while screen content is hidden. Answers what its header shows.
 */
export async function managerSelect(deps: TermManagerDeps, raw: unknown): Promise<TermTarget> {
  const session = parseManagerSession(raw);
  if (deps.hidden()) throw new Error(deps.messages.hidden);
  const stats = (await deps.listing(true))?.sessions.find((s) => s.id === session);
  if (!stats) throw new Error(deps.messages.gone);
  // Hidden while it was looked up: its title and folder never leave after that.
  if (deps.hidden()) throw new Error(deps.messages.hidden);
  return { session, title: termTitle(stats), cwd: stats.cwd };
}

/**
 * Previews of a few running sessions: the last rows of each visible screen (`previewLines`) and
 * the title its program set (a row's name when no conversation is linked).
 * Unknown or ended sessions, and screens that could not be read, are left out; while screen
 * content is hidden (before or after the reads) nothing is answered.
 */
export async function managerPreviews(
  deps: TermManagerDeps,
  raw: unknown,
): Promise<Record<string, TermPreview>> {
  const wanted = parsePreviewRequest(raw);
  if (!wanted.length || deps.hidden()) return {};
  const live = new Set(
    (await deps.listing(false))?.sessions.filter((s) => !s.exit).map((s) => s.id) ?? [],
  );
  const out: Record<string, TermPreview> = {};
  await Promise.all(
    wanted
      .filter((id) => live.has(id))
      .map(async (id) => {
        const screen = await deps.screen(id).catch(() => null);
        if (!screen) return;
        // eslint-disable-next-line no-control-regex
        const title = (screen.title ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
        out[id] = {
          lines: previewLines(screen),
          ...(title && { title: title.slice(0, TERM_MANAGER_PREVIEW_COLS) }),
        };
      }),
  );
  return deps.hidden() ? {} : out;
}
