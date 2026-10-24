import { remember } from '../server/adapters/claude-live.js';
import type { RunOptions } from '../server/adapters/claude-live.js';
import { m } from '../src/shared/i18n/index.js';
import type { TerminalTarget } from '../src/shared/types.js';

/**
 * The environment for Orca CLI calls about this computer: without Orca's remote-runtime
 * selection (an environment, a pairing code, or its older pairing variable), so an inherited
 * pairing never routes a local lookup, switch or launch to another machine.
 */
export function localOrcaEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const local = { ...env };
  delete local.ORCA_ENVIRONMENT;
  delete local.ORCA_PAIRING_CODE;
  delete local.ORCA_REMOTE_PAIRING;
  return local;
}
/** Host discovery and navigation are shared by agents; this module never types input. */
export interface TerminalHostDeps {
  run: (file: string, args: string[], options?: RunOptions) => Promise<string>;
  bin: (name: 'orca' | 'tmux' | 'codex') => string;
  /** `process.platform` when left out; tests pin it. */
  platform?: string;
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

/**
 * All Orca terminals by handle: one CLI call (~0.5s) instead of one per session. Shared by the
 * live-process lookup below and the tab-only fallback (desktop/orca-tabs.ts). `complete` only
 * when Orca answered with the whole list: not `truncated` (Orca's default row limit), not failed.
 * Matching one known handle works on a partial list; proving a tab is the only match does not.
 */
export function orcaTerminalList(deps: TerminalHostDeps, fresh: boolean) {
  return remember(deps, 'orca-terminals', 5000, fresh, async () => {
    const byHandle = new Map<string, Record<string, unknown>>();
    let complete = false;
    try {
      const out = await deps.run(deps.bin('orca'), ['terminal', 'list', '--json'], {
        env: localOrcaEnv(),
      });
      const result = JSON.parse(out)?.result;
      for (const t of result?.terminals ?? [])
        if (typeof t?.handle === 'string') byHandle.set(t.handle, t);
      complete = Array.isArray(result?.terminals) && result.truncated !== true;
    } catch {
      /* Orca is not running. */
    }
    return { byHandle, complete };
  });
}

export const orcaTerminals = async (deps: TerminalHostDeps, fresh: boolean) =>
  (await orcaTerminalList(deps, fresh)).byHandle;

/** Finds the terminal pane that hosts the process. tmux is the direct host when present. */
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

/**
 * A terminal lookup that tells "nothing there" from "could not tell": only `none` lets a weaker
 * fallback (the Orca tab by title, desktop/orca-tabs.ts) stand in.
 */
export type TerminalLookup<T> =
  { kind: 'found'; terminal: T } | { kind: 'none' } | { kind: 'unknown' };

export const hostName = (host: TerminalHost) => (host.kind === 'orca' ? 'Orca' : 'tmux');

/** Public screen location; private routing addresses stay in the main process. */
export function focusTarget(host: TerminalHost): NonNullable<TerminalTarget['focus']> {
  return { kind: host.kind, label: host.kind === 'orca' ? host.title : host.label };
}

/** A navigation refusal whose message may be shown directly; transport errors stay private. */
export class TerminalFocusError extends Error {}

export async function focusHost(host: TerminalHost, deps: TerminalHostDeps): Promise<string> {
  if (host.kind === 'orca') {
    const out = await deps.run(
      deps.bin('orca'),
      ['terminal', 'switch', `--terminal=${host.handle}`, '--json'],
      { env: localOrcaEnv() },
    );
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
  return focusTmux(host, deps);
}

/** POSIX single quotes: safe to hand to a shell as one word. */
export const shellQuote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

/**
 * An argument as tmux must get it: a trailing `;` ends a tmux command even in its own argv word
 * (and inside shell quotes), so it is escaped; tmux reads `\;` back as the literal `;`.
 */
export const tmuxArg = (s: string) => s.replace(/;$/, '\\;');

/**
 * Opens a new Terminal.app window running `command`. The command travels as an AppleScript
 * argument, never spliced into the script source. macOS only.
 */
export async function openInTerminalApp(
  run: TerminalHostDeps['run'],
  command: string,
): Promise<void> {
  await run('/usr/bin/osascript', [
    '-e',
    'on run argv\ntell application "Terminal"\nactivate\ndo script (item 1 of argv)\nend tell\nend run',
    command,
  ]);
}

/** Attached tmux clients, most recently active first. */
export function parseTmuxClients(out: string): { tty: string; pid: number; activity: number }[] {
  const clients = [];
  for (const line of out.split('\n')) {
    const [tty, pid, activity] = line.trim().split('\t');
    if (tty?.startsWith('/dev/') && /^\d+$/.test(pid ?? ''))
      clients.push({ tty, pid: Number(pid), activity: Number(activity) || 0 });
  }
  return clients.sort((a, b) => b.activity - a.activity);
}

/**
 * The macOS app that hosts a process: the outermost `.app` bundle of its first ancestor that
 * runs from one (Terminal, iTerm2, Ghostty, WezTerm, Alacritty, kitty, Orca's helper, ...).
 * `null` when no such ancestor exists (ssh, a daemonized terminal server, a dead process).
 */
export function appBundleOf(table: string, pid: number): string | null {
  const rows = new Map<number, { ppid: number; command: string }>();
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), command: m[3].trim() });
  }
  let current = rows.get(pid);
  for (let depth = 0; current && depth < 32; depth++) {
    // A helper bundle nested inside the app (Orca Helper.app) still belongs to the outer app.
    const bundle = /\.app\/Contents\/MacOS\//.test(current.command)
      ? /^(\/.*?\.app)\//.exec(current.command)?.[1]
      : undefined;
    if (bundle) return bundle;
    if (current.ppid <= 1) return null;
    current = rows.get(current.ppid);
  }
  return null;
}

const appName = (bundle: string) => bundle.replace(/^.*\//, '').replace(/\.app$/, '');

/**
 * Selects the pane, then makes it visible: an attached client is switched to it and the app
 * that owns that client is brought forward; with no client, macOS opens Terminal attached to
 * the session. Never types into the pane; the message says only what actually happened.
 */
async function focusTmux(
  host: Extract<TerminalHost, { kind: 'tmux' }>,
  deps: TerminalHostDeps,
): Promise<string> {
  const t = m().desktop.terminal;
  const tmux = deps.bin('tmux');
  const at = (...args: string[]) => deps.run(tmux, ['-S', host.socket, ...args]);
  await at('select-window', '-t', host.pane);
  await at('select-pane', '-t', host.pane);
  const darwin = (deps.platform ?? process.platform) === 'darwin';
  const [client] = parseTmuxClients(
    await at(
      'list-clients',
      '-t',
      host.pane,
      '-F',
      '#{client_tty}\t#{client_pid}\t#{client_activity}',
    ),
  );
  if (!client) {
    const session = (await at('display-message', '-p', '-t', host.pane, '#{session_name}')).trim();
    if (!session) throw new Error('tmux pane has no session');
    const command = `${shellQuote(tmux)} -S ${shellQuote(host.socket)} attach-session -t ${shellQuote(tmuxArg('=' + session))}`;
    if (!darwin) throw new TerminalFocusError(t.tmuxAttachHint(host.label, command));
    try {
      await openInTerminalApp(deps.run, command);
    } catch {
      throw new TerminalFocusError(t.tmuxOpenFailed(host.label));
    }
    return t.tmuxAttached(host.label);
  }
  // A client looking at another session of this server needs switching to the pane's session.
  await at('switch-client', '-c', client.tty, '-t', host.pane);
  if (!darwin) return t.tmuxNotRaised(host.label);
  const table = await deps.run('/bin/ps', ['-axo', 'pid=,ppid=,comm=']).catch(() => '');
  const bundle = appBundleOf(table, client.pid);
  if (!bundle) return t.tmuxNotRaised(host.label);
  const app = appName(bundle);
  // The window or tab that shows the client, where the app can be asked for it.
  const shown =
    app === 'Orca'
      ? await showOrcaTerminal(client.pid, deps)
      : app in TTY_SCRIPTS
        ? await showTtyTab(TTY_SCRIPTS[app], client.tty, deps)
        : false;
  if (shown) return t.tmuxFocused(host.label, app);
  // Only the app: whichever of its windows comes forward may show something else.
  try {
    await deps.run('/usr/bin/open', ['-a', bundle]);
  } catch {
    return t.tmuxNotRaised(host.label);
  }
  return t.tmuxAppOnly(host.label, app);
}

/**
 * A tmux client running in an Orca terminal: that terminal (named in the client's environment,
 * confirmed in Orca's own list) is switched to and Orca brought forward.
 */
async function showOrcaTerminal(pid: number, deps: TerminalHostDeps): Promise<boolean> {
  try {
    const ps = (args: string[]) => deps.run('/bin/ps', [...args, '-p', String(pid)]);
    const [full, args] = await Promise.all([
      ps(['-wwE', '-o', 'command=']),
      ps(['-ww', '-o', 'command=']),
    ]);
    const env = parseProcessEnv(full.trim(), args.trim());
    if (!env.orcaHandle) return false;
    const terminal = (await orcaTerminals(deps, true)).get(env.orcaHandle);
    if (
      terminal?.connected !== true ||
      terminal.orphaned === true ||
      (env.orcaTab && terminal.tabId !== env.orcaTab)
    )
      return false;
    const out = await deps.run(
      deps.bin('orca'),
      ['terminal', 'switch', `--terminal=${env.orcaHandle}`, '--json'],
      { env: localOrcaEnv() },
    );
    if (JSON.parse(out)?.result?.focus?.navigated === false) return false;
    await deps.run('/usr/bin/open', ['-a', 'Orca']).catch(() => '');
    return true;
  } catch {
    return false;
  }
}

/**
 * AppleScript that selects the tab (iTerm2: session) whose `tty` is `item 1 of argv` and brings
 * its window forward, answering `ok`; the tty travels as an argument, never in the source.
 */
const TTY_SCRIPTS: Record<string, string> = {
  Terminal: [
    'on run argv',
    'tell application "Terminal"',
    'repeat with w in windows',
    'repeat with t in tabs of w',
    'if tty of t is (item 1 of argv) then',
    'set selected of t to true',
    'set index of w to 1',
    'activate',
    'return "ok"',
    'end if',
    'end repeat',
    'end repeat',
    'end tell',
    'return "none"',
    'end run',
  ].join('\n'),
  iTerm: [
    'on run argv',
    'tell application "iTerm"',
    'repeat with w in windows',
    'repeat with t in tabs of w',
    'repeat with s in sessions of t',
    'if tty of s is (item 1 of argv) then',
    'tell w to select',
    'tell t to select',
    'tell s to select',
    'activate',
    'return "ok"',
    'end if',
    'end repeat',
    'end repeat',
    'end repeat',
    'end tell',
    'return "none"',
    'end run',
  ].join('\n'),
};

async function showTtyTab(script: string, tty: string, deps: TerminalHostDeps): Promise<boolean> {
  const out = await deps.run('/usr/bin/osascript', ['-e', script, tty]).catch(() => '');
  return out.trim() === 'ok';
}
