import { existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { TerminalTarget } from '../src/shared/types.js';
import { intlLocale, m } from '../src/shared/i18n/index.js';
import {
  findClaudeProcess,
  forget,
  processAlive,
  remember,
  runCommand,
  type ClaudeLiveDeps,
  type ClaudeProcess,
} from '../server/adapters/claude-live.js';

// Desktop-only: these helpers can focus and type into a live terminal, so they are
// never reachable through OfficeService.call (shared with the web preview). Reading the
// process records themselves is shared with the collector (server/adapters/claude-live.ts).
export {
  findClaudeProcess,
  parseClaudeProcess,
  remember,
  spaces,
  type ClaudeProcess,
  type RunOptions,
} from '../server/adapters/claude-live.js';

export interface TerminalDeps extends ClaudeLiveDeps {
  /** `${CODEX_HOME:-~/.codex}`: shared daemon state for Codex CLI sessions. */
  codexHome: string;
  bin: (name: 'orca' | 'tmux' | 'codex') => string;
  wait: (ms: number) => Promise<void>;
}

export type TerminalHost =
  | { kind: 'orca'; handle: string; title: string }
  | { kind: 'tmux'; socket: string; pane: string; label: string };

export interface LiveTerminal {
  process: ClaudeProcess;
  host: TerminalHost;
}

const BINARIES = {
  orca: ['/usr/local/bin/orca', '/opt/homebrew/bin/orca'],
  tmux: ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'],
  // Native binaries only: the npm launcher is a node script, and Finder-launched apps lack node.
  codex: [
    '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
    '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
    '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex',
  ],
};

/** The binary the shared daemon itself runs speaks its protocol best; then installed CLIs. */
function codexBinary(codexHome: string) {
  const releases = path.join(codexHome, 'packages', 'app-server-daemon', 'releases');
  try {
    const newest = readdirSync(releases)
      .filter((name) => existsSync(path.join(releases, name, 'bin', 'codex')))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1);
    if (newest) return path.join(releases, newest, 'bin', 'codex');
  } catch {
    /* no managed daemon installed */
  }
  return BINARIES.codex.find(existsSync) ?? 'codex';
}

let shared: TerminalDeps | undefined;
/** One shared instance, so the per-deps caches below persist between calls. */
export const defaultTerminalDeps = (): TerminalDeps =>
  (shared ??= {
    sessionsDir: path.join(
      process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'),
      'sessions',
    ),
    codexHome: process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
    run: runCommand,
    alive: processAlive,
    bin(name) {
      return name === 'codex'
        ? codexBinary(this.codexHome)
        : (BINARIES[name].find(existsSync) ?? name);
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

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
export async function inspectProcess(pid: number, deps: TerminalDeps): Promise<ProcessView> {
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
function orcaTerminals(deps: TerminalDeps, fresh: boolean) {
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
  deps: TerminalDeps,
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

export function locateTerminal(
  sessionId: string,
  options: { fresh?: boolean; deps?: TerminalDeps } = {},
): Promise<LiveTerminal | null> {
  const deps = options.deps ?? defaultTerminalDeps();
  const fresh = !!options.fresh;
  // A short window only merges concurrent lookups; the process record itself is cheap to read.
  return remember(deps, `locate:${sessionId}`, 1500, fresh, async () => {
    const proc = await findClaudeProcess(sessionId, deps, fresh);
    if (!proc) return null;
    const key = `${proc.pid}:${proc.procStart}`;
    // Environment and pty owner are fixed for the process's life; a failed read is retried.
    const view = remember(deps, `view:${key}`, Infinity, false, () =>
      inspectProcess(proc.pid, deps),
    );
    if (!(await view).owner) forget(deps, `view:${key}`);
    // Host verification rarely changes; cheap polls reuse it, actions always re-check.
    const host = await remember(deps, `host:${key}`, 15_000, fresh, () =>
      findHost(proc.pid, deps, view, fresh),
    );
    return host ? { process: proc, host } : null;
  });
}

/** Drop a cached lookup once its state is known to have changed, e.g. right after sending. */
export const forgetTerminal = (sessionId: string) =>
  forget(defaultTerminalDeps(), `locate:${sessionId}`);

export const hostName = (host: TerminalHost) => (host.kind === 'orca' ? 'Orca' : 'tmux');

/**
 * What the renderer may know: never the handle or socket, which main re-resolves per action.
 * Only an idle prompt takes typed text; `waiting` (a permission prompt or plan approval on
 * screen) would turn the text into an answer.
 */
export function terminalTarget(live: LiveTerminal): TerminalTarget {
  return {
    kind: live.host.kind,
    label: live.host.kind === 'orca' ? live.host.title : live.host.label,
    status: live.process.status,
    canSend: live.process.status === 'idle',
    canFocus: true,
  };
}

export async function focusTerminal(
  live: LiveTerminal,
  deps = defaultTerminalDeps(),
): Promise<string> {
  const { host } = live;
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
    if (navigated === false) throw new TerminalInputError(m().desktop.terminal.orcaNoSwitch);
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

/**
 * The process must own its terminal right now. A suspended Claude (ctrl+z) keeps an idle
 * record while its shell takes the foreground, and typed text would run as a shell command.
 */
export async function ownsTerminal(pid: number, deps: TerminalDeps): Promise<boolean> {
  const out = await deps
    .run('/bin/ps', ['-o', 'stat=,pgid=,tpgid=', '-p', String(pid)])
    .catch(() => '');
  const [stat, pgid, tpgid] = out.trim().split(/\s+/);
  return !!stat && !stat.includes('T') && /^\d+$/.test(pgid ?? '') && pgid === tpgid;
}

export const MAX_SEND_LENGTH = 4000;
/** A refusal the person can act on, shown as is. Other failures are reported generically. */
export class TerminalInputError extends Error {}

/** Plain typed text only: escape sequences and other control characters never reach the pty. */
export function cleanInput(text: unknown): string {
  if (typeof text !== 'string') throw new TerminalInputError(m().desktop.terminal.empty);
  const value = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .trim();
  if (!value) throw new TerminalInputError(m().desktop.terminal.empty);
  if (value.length > MAX_SEND_LENGTH)
    throw new TerminalInputError(
      m().desktop.terminal.tooLong(MAX_SEND_LENGTH.toLocaleString(intlLocale())),
    );
  return value;
}

export async function sendToTerminal(
  live: LiveTerminal,
  input: unknown,
  deps = defaultTerminalDeps(),
): Promise<string> {
  const text = cleanInput(input);
  if (live.process.status !== 'idle') throw new TerminalInputError(m().desktop.terminal.busy);
  if (!(await ownsTerminal(live.process.pid, deps)))
    throw new TerminalInputError(m().desktop.terminal.notOwner);
  const { host } = live;
  if (host.kind === 'orca') {
    // `--flag=value` is the only form Orca reads for a value that starts with `--`.
    let out: string;
    try {
      // Orca waits up to 5s for the turn to start, on top of its own startup.
      out = await deps.run(
        deps.bin('orca'),
        [
          'terminal',
          'send',
          `--terminal=${host.handle}`,
          `--text=${text}`,
          '--enter',
          '--wait-submit=5',
          '--json',
        ],
        { timeout: 20000 },
      );
    } catch (error) {
      out = (error as { stdout?: string }).stdout ?? '';
      if (!/"accepted"\s*:\s*false/.test(out)) throw error;
    }
    const send = JSON.parse(out)?.result?.send;
    if (send?.accepted !== true) {
      const reason = typeof send?.refusedReason === 'string' ? ` (${send.refusedReason})` : '';
      throw new TerminalInputError(m().desktop.terminal.orcaRefused(reason));
    }
    const stages: unknown = send.prompt?.stages;
    return Array.isArray(stages) && stages.includes('turn_started')
      ? m().desktop.terminal.orcaStarted
      : m().desktop.terminal.orcaSent;
  }
  const tmux = deps.bin('tmux');
  const buffer = `agent-office-${randomUUID()}`;
  // stdin, not argv: tmux treats a trailing `;` in an argument as a command separator.
  await deps.run(tmux, ['-S', host.socket, 'load-buffer', '-b', buffer, '-'], { input: text });
  try {
    // Bracketed paste keeps line breaks inside the prompt instead of submitting early.
    await deps.run(tmux, [
      '-S',
      host.socket,
      'paste-buffer',
      '-p',
      '-d',
      '-b',
      buffer,
      '-t',
      host.pane,
    ]);
  } catch (error) {
    await deps.run(tmux, ['-S', host.socket, 'delete-buffer', '-b', buffer]).catch(() => '');
    throw error;
  }
  await deps.wait(150);
  // A turn may have started meanwhile (a background task, a wake-up); Enter would then land
  // in it or pick a default choice. Look once more before submitting.
  const again = await findClaudeProcess(live.process.sessionId, deps, true);
  if (
    again?.pid !== live.process.pid ||
    again.status !== 'idle' ||
    !(await ownsTerminal(again.pid, deps))
  )
    throw new TerminalInputError(m().desktop.terminal.stateChanged);
  await deps.run(tmux, ['-S', host.socket, 'send-keys', '-t', host.pane, 'Enter']);
  return m().desktop.terminal.tmuxSent(host.label);
}
