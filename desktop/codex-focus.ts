import { remember, forget } from '../server/adapters/claude-live.js';
import { defaultTerminalDeps, ownsTerminal } from './terminals.js';
import { findHost, inspectProcess, type TerminalHost } from './terminal-host.js';
import type { TerminalDeps } from './terminals.js';
import { codexLoadedThreads } from './codex-queue.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const THREAD = new RegExp(`^${UUID}$`, 'i');
// Codex 0.162.1 truncates each title item to 32 characters (29 plus ASCII ellipsis).
const SHORT_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{5}\\.\\.\\.';

/**
 * Codex's title items are separated by " | ". Put thread-id first. Only this current
 * identifier (full or Codex's 32-character abbreviation) is evidence: argv, history,
 * name and cwd cannot say which thread a screen shows after /resume or /new.
 */
export function codexTitleThread(title: string): string | null {
  return (
    new RegExp(`^(${UUID}|${SHORT_UUID})(?: \\| |$)`, 'i').exec(title)?.[1].toLowerCase() ?? null
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
  const found = new Set<number>();
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(ttys?\d+)\s+(?:\S*\/)?codex\s*$/.exec(line);
    if (m && Number(m[1]) > 1) found.add(Number(m[1]));
  }
  // An unexpectedly large inventory is unknown, never silently pick the first few screens.
  return found.size <= 64 ? [...found] : [];
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
    await deps.run(deps.bin('orca'), ['terminal', 'show', `--terminal=${host.handle}`, '--json']),
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
  loaded = () => codexLoadedThreads(deps),
): Promise<CodexTerminal | null> {
  const start = () =>
    deps
      .run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
      })
      .then((out) => out.trim());
  const procStart = await start();
  if (!procStart || !deps.alive(pid) || !(await ownsTerminal(pid, deps))) return null;
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
  if (!threadId || (await start()) !== procStart || !(await ownsTerminal(pid, deps))) return null;
  return { threadId, pid, procStart, host };
}

async function screenInventory(deps: TerminalDeps, fresh: boolean) {
  return remember(deps, 'codex-focus-screens', 2000, fresh, async () => {
    if (fresh) {
      forget(deps, 'process-table');
      forget(deps, 'orca-terminals');
    }
    const table = await deps.run('/bin/ps', ['-axo', 'pid=,tty=,comm=']).catch(() => '');
    let uncertain = false;
    let loaded: Promise<Set<string>> | undefined;
    const load = () => (loaded ??= codexLoadedThreads(deps));
    const screens = await Promise.all(
      codexScreenPids(table).map(async (pid) => {
        try {
          // One host inventory per scan; each screen title below is read afresh.
          return await readScreen(pid, deps, false, load);
        } catch {
          // A supported screen we could not read may be another view of the same thread.
          // Do not turn missing evidence into a unique target.
          uncertain = true;
          return null;
        }
      }),
    );
    return { screens: screens.filter((s): s is CodexTerminal => s !== null), uncertain };
  });
}

/** Multiple attached screens are ambiguous: keep the resume command instead of guessing. */
export async function findCodexTerminal(
  threadId: string,
  options: { fresh?: boolean; deps?: TerminalDeps } = {},
): Promise<CodexTerminal | null> {
  if (!THREAD.test(threadId)) return null;
  const deps = options.deps ?? defaultTerminalDeps();
  const inventory = await screenInventory(deps, !!options.fresh);
  if (inventory.uncertain) return null;
  const matches = inventory.screens.filter((s) => s.threadId === threadId.toLowerCase());
  if (matches.length !== 1) return null;
  const selected = matches[0];
  if (!options.fresh) return selected;
  // A slow other candidate may have kept us waiting for seconds after this title was read.
  // Re-check the selected process, host and title after the entire inventory has settled.
  forget(deps, 'process-table');
  const current = await readScreen(selected.pid, deps, true).catch(() => null);
  return current?.threadId === selected.threadId && current.procStart === selected.procStart
    ? current
    : null;
}
