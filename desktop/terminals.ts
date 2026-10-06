import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { TerminalTarget } from '../src/shared/types.js';

// Desktop-only: these helpers can focus and type into a live terminal, so they are
// never reachable through OfficeService.call (shared with the web preview).

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, for text that must not pass through argv parsing. */
  input?: string;
  timeout?: number;
}

export interface TerminalDeps {
  sessionsDir: string;
  /** Rejections carry the command's stdout, e.g. a JSON refusal with a non-zero exit. */
  run: (file: string, args: string[], options?: RunOptions) => Promise<string>;
  alive: (pid: number) => boolean;
  bin: (name: 'orca' | 'tmux') => string;
  wait: (ms: number) => Promise<void>;
}

/** One record of `<claude config>/sessions/<pid>.json`. Undocumented CLI state; validate everything. */
export interface ClaudeProcess {
  pid: number;
  sessionId: string;
  procStart: string;
  status: string;
  updatedAt: number;
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
};

export const defaultTerminalDeps = (): TerminalDeps => ({
  sessionsDir: path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'),
    'sessions',
  ),
  run: (file, args, options = {}) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        file,
        args,
        { timeout: options.timeout ?? 8000, maxBuffer: 1_000_000, env: options.env ?? process.env },
        (error, stdout) =>
          error ? reject(Object.assign(error, { stdout: String(stdout ?? '') })) : resolve(stdout),
      );
      if (options.input !== undefined) child.stdin?.end(options.input);
    }),
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  bin: (name) => BINARIES[name].find(existsSync) ?? name,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

const spaces = (value: string) => value.trim().replace(/\s+/g, ' ');

export function parseClaudeProcess(file: string, text: string): ClaudeProcess | null {
  try {
    const d = JSON.parse(text);
    const pid = Number(path.basename(file, '.json'));
    if (!Number.isInteger(pid) || pid <= 1 || d.pid !== pid) return null;
    if (typeof d.sessionId !== 'string' || !/^[\w-]{8,80}$/.test(d.sessionId)) return null;
    if (typeof d.procStart !== 'string' || typeof d.status !== 'string') return null;
    if (d.kind !== undefined && d.kind !== 'interactive') return null;
    return {
      pid,
      sessionId: d.sessionId,
      procStart: d.procStart,
      status: d.status,
      updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

/** The live interactive Claude Code process for a session, verified against PID reuse. */
export async function findClaudeProcess(
  sessionId: string,
  deps: TerminalDeps,
): Promise<ClaudeProcess | null> {
  const files = await readdir(deps.sessionsDir).catch(() => [] as string[]);
  const candidates: ClaudeProcess[] = [];
  for (const name of files) {
    if (!/^\d+\.json$/.test(name)) continue;
    const text = await readFile(path.join(deps.sessionsDir, name), 'utf8').catch(() => '');
    const record = parseClaudeProcess(name, text);
    if (record?.sessionId === sessionId) candidates.push(record);
  }
  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const record of candidates) {
    if (!deps.alive(record.pid)) continue;
    // procStart is written in UTC with the C locale; a recycled PID starts at another time.
    const started = await deps
      .run('/bin/ps', ['-o', 'lstart=', '-p', String(record.pid)], {
        env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
      })
      .catch(() => '');
    if (started && spaces(started) === spaces(record.procStart)) return record;
  }
  return null;
}

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
    deps.run('/bin/ps', ['-axo', 'pid=,ppid=,tty=,comm=']),
  ]).catch(() => ['', '', '']);
  return { env: parseProcessEnv(full.trim(), args.trim()), owner: ptyOwner(table, pid) };
}

/** Finds the terminal pane that hosts the process. tmux is the direct host when present. */
export async function findHost(
  pid: number,
  deps: TerminalDeps,
  inspected?: Promise<ProcessView>,
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
    const shown = await deps
      .run(deps.bin('orca'), ['terminal', 'show', `--terminal=${env.orcaHandle}`, '--json'])
      .catch(() => '');
    try {
      const t = JSON.parse(shown)?.result?.terminal;
      if (
        t?.handle === env.orcaHandle &&
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
    } catch {
      /* Orca is not running or the handle is gone. */
    }
  }
  return null;
}

const cache = new Map<string, { at: number; value: Promise<LiveTerminal | null> }>();
// Keyed by pid and start time, so a recycled pid never reuses another process's view.
const views = new Map<string, Promise<ProcessView>>();

export function locateTerminal(
  sessionId: string,
  options: { fresh?: boolean; deps?: TerminalDeps } = {},
): Promise<LiveTerminal | null> {
  const hit = cache.get(sessionId);
  if (!options.fresh && hit && Date.now() - hit.at < 3000) return hit.value;
  const deps = options.deps ?? defaultTerminalDeps();
  const value = (async () => {
    const proc = await findClaudeProcess(sessionId, deps);
    if (!proc) return null;
    const key = `${proc.pid}:${proc.procStart}`;
    let view = views.get(key);
    if (!view || options.deps) {
      view = inspectProcess(proc.pid, deps);
      views.set(key, view);
      if (views.size > 200) views.delete(views.keys().next().value!);
    }
    const host = await findHost(proc.pid, deps, view);
    return host ? { process: proc, host } : null;
  })();
  cache.set(sessionId, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return value;
}

/** Drop a cached lookup once its state is known to have changed, e.g. right after sending. */
export const forgetTerminal = (sessionId: string) => cache.delete(sessionId);

export const hostName = (host: TerminalHost) => (host.kind === 'orca' ? 'Orca' : 'tmux');

/** What the renderer may know: never the handle or socket, which main re-resolves per action. */
export function terminalTarget(live: LiveTerminal): TerminalTarget {
  return {
    kind: live.host.kind,
    label: live.host.kind === 'orca' ? live.host.title : live.host.label,
    status: live.process.status,
    canSend: live.process.status === 'idle',
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
    if (navigated === false) throw new TerminalInputError('Orca가 그 터미널로 이동하지 못했어요.');
    await deps.run('/usr/bin/open', ['-a', 'Orca']).catch(() => '');
    return 'Orca의 해당 터미널로 이동했어요';
  }
  const tmux = deps.bin('tmux');
  await deps.run(tmux, ['-S', host.socket, 'select-window', '-t', host.pane]);
  await deps.run(tmux, ['-S', host.socket, 'select-pane', '-t', host.pane]);
  // A client looking at another tmux session needs switching; with no attached client this
  // fails harmlessly and the pane is simply the active one.
  await deps.run(tmux, ['-S', host.socket, 'switch-client', '-t', host.pane]).catch(() => '');
  return `tmux ${host.label} 패널을 선택했어요`;
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
  if (typeof text !== 'string') throw new TerminalInputError('보낼 내용을 입력해 주세요.');
  const value = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .trim();
  if (!value) throw new TerminalInputError('보낼 내용을 입력해 주세요.');
  if (value.length > MAX_SEND_LENGTH)
    throw new TerminalInputError(`${MAX_SEND_LENGTH.toLocaleString()}자 이하로 보내 주세요.`);
  return value;
}

const notOwner = 'Claude가 지금 터미널 앞에 있지 않아요(일시정지 등). 터미널을 확인해 주세요.';

export async function sendToTerminal(
  live: LiveTerminal,
  input: unknown,
  deps = defaultTerminalDeps(),
): Promise<string> {
  const text = cleanInput(input);
  if (live.process.status !== 'idle')
    throw new TerminalInputError('작업 중이에요. 끝나면 다시 보내 주세요.');
  if (!(await ownsTerminal(live.process.pid, deps))) throw new TerminalInputError(notOwner);
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
      throw new TerminalInputError(`Orca가 입력을 받지 않았어요${reason}.`);
    }
    const stages: unknown = send.prompt?.stages;
    return Array.isArray(stages) && stages.includes('turn_started')
      ? 'Orca 터미널에 보냈고 작업이 시작됐어요'
      : 'Orca 터미널에 보냈어요';
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
  const again = await findClaudeProcess(live.process.sessionId, deps);
  if (
    again?.pid !== live.process.pid ||
    again.status !== 'idle' ||
    !(await ownsTerminal(again.pid, deps))
  )
    throw new TerminalInputError(
      '입력창에 넣었지만 그사이 상태가 바뀌어 제출하지 않았어요. 터미널을 확인해 주세요.',
    );
  await deps.run(tmux, ['-S', host.socket, 'send-keys', '-t', host.pane, 'Enter']);
  return `tmux ${host.label}에 보냈어요`;
}
