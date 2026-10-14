import { remember } from '../server/adapters/claude-live.js';
import type { RunOptions } from '../server/adapters/claude-live.js';
import { m } from '../src/shared/i18n/index.js';
import type { TerminalTarget } from '../src/shared/types.js';

/** Host discovery and navigation are shared by agents; this module never types input. */
export interface TerminalHostDeps {
  run: (file: string, args: string[], options?: RunOptions) => Promise<string>;
  bin: (name: 'orca' | 'tmux' | 'codex') => string;
}

export type TerminalHost =
  | { kind: 'orca'; handle: string; title: string }
  | { kind: 'tmux'; socket: string; pane: string; label: string };

export interface ProcessEnv {
  /** Any tmux marker, valid or not: such a process is never routed to an outer terminal. */
  inTmux: boolean;
  orcaHandle?: string;
  orcaTab?: string;
  tmuxSocket?: string;
  tmuxPane?: string;
}

/**
 * `ps -E` prints the arguments followed by the environment. The caller passes the arguments
 * separately so text inside them can never pose as an environment variable.
 */
export function parseProcessEnv(full: string, args: string): ProcessEnv {
  const env = full.startsWith(args.trimEnd()) ? full.slice(args.trimEnd().length) : '';
  const last = (pattern: RegExp) => {
    let value: string | undefined;
    for (const m of env.matchAll(pattern)) value = m[1];
    return value;
  };
  return {
    inTmux: /(?:^|\s)TMUX(?:_PANE)?=/.test(env),
    orcaHandle: last(/(?:^|\s)ORCA_TERMINAL_HANDLE=(term_[\w-]{1,80})(?=\s|$)/g),
    orcaTab: last(/(?:^|\s)ORCA_TAB_ID=([\w-]{1,80})(?=\s|$)/g),
    tmuxSocket: last(/(?:^|\s)TMUX=(\/[^\s,]{1,300}),\d+,\d+(?=\s|$)/g),
    tmuxPane: last(/(?:^|\s)TMUX_PANE=(%\d{1,6})(?=\s|$)/g),
  };
}

/**
 * The program that owns the process's terminal: walk up the parents while they share the
 * tty; the first one on another tty (or none) holds the pty. Environment variables are
 * inherited and can name an outer terminal (screen, zellij, nvim :terminal inside Orca),
 * so the owner decides which host is real.
 */
export function ptyOwner(table: string, pid: number): { tty: string; command: string } | null {
  const rows = new Map<number, { ppid: number; tty: string; command: string }>();
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), tty: m[3], command: m[4].trim() });
  }
  const own = rows.get(pid);
  if (!own || !/^ttys?\d+$/.test(own.tty)) return null;
  let current = own;
  for (let depth = 0; depth < 16; depth++) {
    const parent = rows.get(current.ppid);
    if (!parent) return null;
    if (parent.tty !== own.tty) return { tty: own.tty, command: parent.command };
    current = parent;
  }
  return null;
}

const isTmux = (command: string) => /(?:^|\/)tmux(?::|\s|$)/.test(command);
const isOrca = (command: string) => command.includes('/Orca.app/Contents/');

export interface ProcessView {
  env: ProcessEnv;
  owner: { tty: string; command: string } | null;
}

/** Environment and pty owner: both fixed for the life of a process. */
export async function inspectProcess(pid: number, deps: TerminalHostDeps): Promise<ProcessView> {
  const ps = (args: string[]) => deps.run('/bin/ps', [...args, '-p', String(pid)]);
  const [full, args, table] = await Promise.all([
    ps(['-wwE', '-o', 'command=']),
    ps(['-ww', '-o', 'command=']),
    // The whole process table is shared by every lookup in the same second.
    remember(deps, 'process-table', 1000, false, () =>
      deps.run('/bin/ps', ['-axo', 'pid=,ppid=,tty=,comm=']),
    ),
  ]).catch(() => ['', '', '']);
  return { env: parseProcessEnv(full.trim(), args.trim()), owner: ptyOwner(table, pid) };
}

/** Finds the terminal pane that hosts the process. tmux is the direct host when present. */
/** All live Orca terminals by handle: one CLI call (~0.5s) instead of one per session. */
function orcaTerminals(deps: TerminalHostDeps, fresh: boolean) {
  return remember(deps, 'orca-terminals', 5000, fresh, async () => {
    const byHandle = new Map<string, Record<string, unknown>>();
    try {
      const out = await deps.run(deps.bin('orca'), ['terminal', 'list', '--json']);
      for (const t of JSON.parse(out)?.result?.terminals ?? [])
        if (typeof t?.handle === 'string') byHandle.set(t.handle, t);
    } catch {
      /* Orca is not running. */
    }
    return byHandle;
  });
}

export async function findHost(
  pid: number,
  deps: TerminalHostDeps,
  inspected?: Promise<ProcessView>,
  fresh = false,
): Promise<TerminalHost | null> {
  const { env, owner } = await (inspected ?? inspectProcess(pid, deps));
  if (!owner) return null;
  const device = owner.tty;
  // Inside tmux the outer terminal (often Orca, inherited in the environment) may be showing
  // another pane or a shell, so an unverified tmux pane means no target at all.
  if (env.inTmux) {
    if (!env.tmuxSocket || !env.tmuxPane || !isTmux(owner.command)) return null;
    const shown = await deps
      .run(deps.bin('tmux'), [
        '-S',
        env.tmuxSocket,
        'display-message',
        '-p',
        '-t',
        env.tmuxPane,
        '#{pane_tty}\t#{session_name}:#{window_index}.#{pane_index}',
      ])
      .catch(() => '');
    const [paneTty, label] = shown.trim().split('\t');
    return paneTty === `/dev/${device}` && label
      ? { kind: 'tmux', socket: env.tmuxSocket, pane: env.tmuxPane, label }
      : null;
  }
  if (env.orcaHandle && isOrca(owner.command)) {
    const t = (await orcaTerminals(deps, fresh)).get(env.orcaHandle);
    if (
      t &&
      t.connected === true &&
      t.writable !== false &&
      t.orphaned !== true &&
      (!env.orcaTab || t.tabId === env.orcaTab)
    )
      return {
        kind: 'orca',
        handle: env.orcaHandle,
        title: typeof t.title === 'string' ? t.title.slice(0, 120) : '',
      };
  }
  return null;
}

export const hostName = (host: TerminalHost) => (host.kind === 'orca' ? 'Orca' : 'tmux');

/** Public screen location; private routing addresses stay in the main process. */
export function focusTarget(host: TerminalHost): NonNullable<TerminalTarget['focus']> {
  return { kind: host.kind, label: host.kind === 'orca' ? host.title : host.label };
}

/** A navigation refusal whose message may be shown directly; transport errors stay private. */
export class TerminalFocusError extends Error {}

export async function focusHost(host: TerminalHost, deps: TerminalHostDeps): Promise<string> {
  if (host.kind === 'orca') {
    const out = await deps.run(deps.bin('orca'), [
      'terminal',
      'switch',
      `--terminal=${host.handle}`,
      '--json',
    ]);
    let navigated: unknown;
    try {
      navigated = JSON.parse(out)?.result?.focus?.navigated;
    } catch {
      /* An older Orca without JSON focus details still switched. */
    }
    if (navigated === false) throw new TerminalFocusError(m().desktop.terminal.orcaNoSwitch);
    await deps.run('/usr/bin/open', ['-a', 'Orca']).catch(() => '');
    return m().desktop.terminal.orcaFocused;
  }
  const tmux = deps.bin('tmux');
  await deps.run(tmux, ['-S', host.socket, 'select-window', '-t', host.pane]);
  await deps.run(tmux, ['-S', host.socket, 'select-pane', '-t', host.pane]);
  // A client looking at another tmux session needs switching; with no attached client this
  // fails harmlessly and the pane is simply the active one.
  await deps.run(tmux, ['-S', host.socket, 'switch-client', '-t', host.pane]).catch(() => '');
  return m().desktop.terminal.tmuxFocused(host.label);
}
