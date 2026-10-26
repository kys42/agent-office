import { remember, forget } from '../server/adapters/claude-live.js';
import { defaultTerminalDeps, ownsTerminal } from './terminals.js';
import {
  findHost,
  inspectProcess,
  localOrcaEnv,
  type TerminalHost,
  type TerminalLookup,
} from './terminal-host.js';
import type { TerminalDeps } from './terminals.js';
import { codexLoadedThreads } from './codex-queue.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const THREAD = new RegExp(`^${UUID}$`, 'i');
// Codex 0.162.1 truncates each title item to 32 characters (29 plus ASCII ellipsis).
const SHORT_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{5}\\.\\.\\.';

/**
 * Codex's title items are separated by " | ". Put thread-id first. Only this current
 * identifier (full or Codex's 32-character abbreviation) is evidence. A known attention
 * decoration can precede that first item; arbitrary title items cannot. Argv, history,
 * name and cwd cannot say which thread a screen shows after /resume or /new.
 */
export function codexTitleThread(title: string): string | null {
  // Orca's attention title alternates these two markers while waiting for input.
  const current = title.replace(/^\[ [.!] \] Action Required \| /, '');
  return (
    new RegExp(`^(${UUID}|${SHORT_UUID})(?: \\| |$)`, 'i').exec(current)?.[1].toLowerCase() ?? null
  );
}

/** Open writer locks supply full IDs, never screen addresses. Collisions stay unknown. */
export function resolveCodexTitleThread(reference: string, loaded: Set<string>): string | null {
  if (THREAD.test(reference)) return reference.toLowerCase();
  if (!new RegExp(`^${SHORT_UUID}$`, 'i').test(reference)) return null;
  const prefix = reference.slice(0, -3).toLowerCase();
  const matches = new Set(
    [...loaded]
      .filter((id) => THREAD.test(id) && id.toLowerCase().startsWith(prefix))
      .map((id) => id.toLowerCase()),
  );
  return matches.size === 1 ? [...matches][0] : null;
}

export interface CodexTerminal {
  threadId: string;
  pid: number;
  procStart: string;
  host: TerminalHost;
}

/** Only interactive native Codex processes; daemons, exec workers and wrappers have no tty. */
export function codexScreenPids(table: string): number[] {
  return codexScreens(table).pids;
}

/** The screens to read, and whether there were too many to read them all. */
export function codexScreens(table: string): { pids: number[]; oversized: boolean } {
  const found = new Set<number>();
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(ttys?\d+)\s+(?:\S*\/)?codex\s*$/.exec(line);
    if (m && Number(m[1]) > 1) found.add(Number(m[1]));
  }
  // An unexpectedly large inventory is unknown, never silently pick the first few screens.
  return found.size <= 64 ? { pids: [...found], oversized: false } : { pids: [], oversized: true };
}

async function screenTitle(host: TerminalHost, deps: TerminalDeps): Promise<string | null> {
  if (host.kind === 'tmux')
    return (
      await deps.run(deps.bin('tmux'), [
        '-S',
        host.socket,
        'display-message',
        '-p',
        '-t',
        host.pane,
        '#{pane_title}',
      ])
    ).trim();
  const result = JSON.parse(
    await deps.run(deps.bin('orca'), ['terminal', 'show', `--terminal=${host.handle}`, '--json'], {
      env: localOrcaEnv(),
    }),
  );
  const t = result?.result?.terminal;
  if (result.ok !== true || t?.handle !== host.handle || typeof t.title !== 'string')
    throw new Error('Cannot verify current terminal title');
  return t.connected === true && t.writable !== false && t.orphaned !== true ? t.title : null;
}

async function readScreen(
  pid: number,
  deps: TerminalDeps,
  fresh = false,
  loaded = () => codexLoadedThreads(deps, { strict: true }),
  /**
   * A Codex process whose screen cannot be tied to a thread (suspended, an unsupported host, no
   * id in its title, changed while read): it may show any thread.
   */
  hidden: () => void = () => {},
): Promise<CodexTerminal | null> {
  const start = () =>
    deps
      .run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
      })
      .then((out) => out.trim());
  const procStart = await start();
  if (!procStart || !deps.alive(pid) || !(await ownsTerminal(pid, deps))) {
    hidden();
    return null;
  }
  const inspected = inspectProcess(pid, deps);
  const host = await findHost(pid, deps, inspected, fresh);
  if (!host) {
    const view = await inspected;
    // A known unsupported owner is excluded; a failed supported-host lookup is unknown.
    if (
      !view.owner ||
      view.owner.command.includes('/Orca.app/Contents/') ||
      /(?:^|\/)tmux(?::|\s|$)/.test(view.owner.command)
    )
      throw new Error('Cannot verify screen host');
    hidden();
    return null;
  }
  const title = await screenTitle(host, deps);
  const reference = title === null ? null : codexTitleThread(title);
  let threadId = reference;
  if (reference && !THREAD.test(reference)) {
    threadId = resolveCodexTitleThread(reference, await loaded());
    // An unresolved screen could duplicate another screen with a full title ID.
    if (!threadId) throw new Error('Cannot resolve abbreviated screen identity');
  }
  if (!threadId) {
    hidden();
    return null;
  }
  if ((await start()) !== procStart || !(await ownsTerminal(pid, deps))) {
    hidden();
    return null;
  }
  return { threadId, pid, procStart, host };
}

async function screenInventory(deps: TerminalDeps, fresh: boolean) {
  return remember(deps, 'codex-focus-screens', 2000, fresh, async () => {
    if (fresh) {
      forget(deps, 'process-table');
      forget(deps, 'orca-terminals');
    }
    let uncertain = false;
    const table = await deps.run('/bin/ps', ['-axo', 'pid=,tty=,comm=']).catch(() => {
      uncertain = true;
      return '';
    });
    // Unreadable screens are left out of the match, but may show any thread.
    let hidden = false;
    let loaded: Promise<Set<string>> | undefined;
    const load = () => (loaded ??= codexLoadedThreads(deps, { strict: true }));
    const inventory = codexScreens(table);
    if (inventory.oversized) uncertain = true;
    const screens = await Promise.all(
      inventory.pids.map(async (pid) => {
        try {
          // One host inventory per scan; each screen title below is read afresh.
          return await readScreen(pid, deps, false, load, () => (hidden = true));
        } catch {
          // A supported screen we could not read may be another view of the same thread.
          // Do not turn missing evidence into a unique target.
          uncertain = true;
          return null;
        }
      }),
    );
    return {
      screens: screens.filter((s): s is CodexTerminal => s !== null),
      uncertain,
      hidden,
    };
  });
}

/** Multiple attached screens are ambiguous: keep the resume command instead of guessing. */
export async function findCodexTerminal(
  threadId: string,
  options: { fresh?: boolean; deps?: TerminalDeps } = {},
): Promise<CodexTerminal | null> {
  const lookup = await lookupCodexTerminal(threadId, options);
  return lookup.kind === 'found' ? lookup.terminal : null;
}

/**
 * `findCodexTerminal` with its null split: `none` only when every interactive Codex process was
 * read and none shows this thread. One that cannot name its thread (suspended, another terminal
 * app, no id in its title), an unreadable screen or process table, several screens of the thread, or a screen that
 * changed while being checked is `unknown`: the thread may be on screen somewhere.
 */
export async function lookupCodexTerminal(
  threadId: string,
  options: { fresh?: boolean; deps?: TerminalDeps } = {},
): Promise<TerminalLookup<CodexTerminal>> {
  if (!THREAD.test(threadId)) return { kind: 'unknown' };
  const deps = options.deps ?? defaultTerminalDeps();
  const inventory = await screenInventory(deps, !!options.fresh);
  if (inventory.uncertain) return { kind: 'unknown' };
  const matches = inventory.screens.filter((s) => s.threadId === threadId.toLowerCase());
  if (!matches.length) return inventory.hidden ? { kind: 'unknown' } : { kind: 'none' };
  if (matches.length > 1) return { kind: 'unknown' };
  const selected = matches[0];
  if (!options.fresh) return { kind: 'found', terminal: selected };
  // A slow other candidate may have kept us waiting for seconds after this title was read.
  // Re-check the selected process, host and title after the entire inventory has settled.
  forget(deps, 'process-table');
  const current = await readScreen(selected.pid, deps, true).catch(() => null);
  return current?.threadId === selected.threadId && current.procStart === selected.procStart
    ? { kind: 'found', terminal: current }
    : { kind: 'unknown' };
}

/**
 * Whether the thread is on screen at all, for the duplicate-launch check: `found` when any
 * screen, verified afresh, shows it, even when another screen also does or could not be read
 * (that only stops `lookupCodexTerminal` from picking one to navigate to). `none` only when
 * every interactive Codex screen was read and none shows it.
 */
export async function codexThreadOnScreen(
  threadId: string,
  options: { fresh?: boolean; deps?: TerminalDeps } = {},
): Promise<TerminalLookup<CodexTerminal>> {
  if (!THREAD.test(threadId)) return { kind: 'unknown' };
  const deps = options.deps ?? defaultTerminalDeps();
  const inventory = await screenInventory(deps, !!options.fresh);
  const matches = inventory.screens.filter((s) => s.threadId === threadId.toLowerCase());
  if (!matches.length)
    return inventory.uncertain || inventory.hidden ? { kind: 'unknown' } : { kind: 'none' };
  if (!options.fresh) return { kind: 'found', terminal: matches[0] };
  // Re-check after the whole inventory settled: a screen may have switched threads meanwhile.
  forget(deps, 'process-table');
  for (const selected of matches) {
    const current = await readScreen(selected.pid, deps, true).catch(() => null);
    if (current?.threadId === selected.threadId && current.procStart === selected.procStart)
      return { kind: 'found', terminal: current };
  }
  return { kind: 'unknown' };
}
