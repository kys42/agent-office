import { remember, forget } from '../server/adapters/claude-live.js';
import { defaultTerminalDeps, ownsTerminal } from './terminals.js';
import { findHost, type TerminalHost } from './terminal-host.js';
import type { TerminalDeps } from './terminals.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const THREAD = new RegExp(`^${UUID}$`, 'i');

/**
 * Codex's title items are separated by " | ". Put thread-id first so long names cannot
 * truncate it. Only this current, full identifier is evidence: argv, history, name and cwd
 * cannot say which thread a screen is showing after /resume or /new.
 */
export function codexTitleThread(title: string): string | null {
  return new RegExp(`^(${UUID})(?: \\| |$)`, 'i').exec(title)?.[1].toLowerCase() ?? null;
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
  return result.ok === true &&
    t?.handle === host.handle &&
    t.connected === true &&
    t.writable !== false &&
    t.orphaned !== true &&
    typeof t.title === 'string'
    ? t.title
    : null;
}

async function screenInventory(deps: TerminalDeps, fresh: boolean): Promise<CodexTerminal[]> {
  return remember(deps, 'codex-focus-screens', 2000, fresh, async () => {
    if (fresh) {
      forget(deps, 'process-table');
      forget(deps, 'orca-terminals');
    }
    const table = await deps.run('/bin/ps', ['-axo', 'pid=,tty=,comm=']).catch(() => '');
    const screens = await Promise.all(
      codexScreenPids(table).map(async (pid) => {
        try {
          const start = () =>
            deps
              .run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
                env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
              })
              .then((out) => out.trim());
          const procStart = await start();
          if (!procStart || !deps.alive(pid) || !(await ownsTerminal(pid, deps))) return null;
          // One host inventory per scan; each screen title below is read afresh.
          const host = await findHost(pid, deps);
          if (!host) return null;
          const title = await screenTitle(host, deps);
          const threadId = title === null ? null : codexTitleThread(title);
          if (!threadId || (await start()) !== procStart || !(await ownsTerminal(pid, deps)))
            return null;
          return { threadId, pid, procStart, host };
        } catch {
          return null;
        }
      }),
    );
    return screens.filter((s): s is CodexTerminal => s !== null);
  });
}

/** Multiple attached screens are ambiguous: keep the resume command instead of guessing. */
export async function findCodexTerminal(
  threadId: string,
  options: { fresh?: boolean; deps?: TerminalDeps } = {},
): Promise<CodexTerminal | null> {
  if (!THREAD.test(threadId)) return null;
  const matches = (
    await screenInventory(options.deps ?? defaultTerminalDeps(), !!options.fresh)
  ).filter((s) => s.threadId === threadId.toLowerCase());
  return matches.length === 1 ? matches[0] : null;
}
