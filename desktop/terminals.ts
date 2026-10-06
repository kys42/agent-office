import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TerminalTarget } from '../src/shared/types.js';

// Desktop-only: these helpers can focus and type into a live terminal, so they are
// never reachable through OfficeService.call (shared with the web preview).
const exec = promisify(execFile);

export interface TerminalDeps {
  sessionsDir: string;
  run: (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
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
  run: async (file, args, env) =>
    (await exec(file, args, { timeout: 8000, maxBuffer: 1_000_000, env: env ?? process.env }))
      .stdout,
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
        ...process.env,
        TZ: 'UTC',
        LC_ALL: 'C',
      })
      .catch(() => '');
    if (started && spaces(started) === spaces(record.procStart)) return record;
  }
  return null;
}

export interface ProcessEnv {
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
    orcaHandle: last(/(?:^|\s)ORCA_TERMINAL_HANDLE=(term_[\w-]{1,80})(?=\s|$)/g),
    orcaTab: last(/(?:^|\s)ORCA_TAB_ID=([\w-]{1,80})(?=\s|$)/g),
    tmuxSocket: last(/(?:^|\s)TMUX=(\/[^\s,]{1,300}),\d+,\d+(?=\s|$)/g),
    tmuxPane: last(/(?:^|\s)TMUX_PANE=(%\d{1,6})(?=\s|$)/g),
  };
}

/** Finds the terminal pane that hosts the process. tmux is the direct host when present. */
export async function findHost(pid: number, deps: TerminalDeps): Promise<TerminalHost | null> {
  const ps = (args: string[]) => deps.run('/bin/ps', [...args, '-p', String(pid)]);
  const [full, args, tty] = await Promise.all([
    ps(['-wwE', '-o', 'command=']),
    ps(['-ww', '-o', 'command=']),
    ps(['-o', 'tty=']),
  ]).catch(() => ['', '', '']);
  const env = parseProcessEnv(full.trim(), args.trim());
  const device = tty.trim();
  if (env.tmuxSocket && env.tmuxPane && /^ttys?\d+$/.test(device)) {
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
    if (paneTty === `/dev/${device}` && label)
      return { kind: 'tmux', socket: env.tmuxSocket, pane: env.tmuxPane, label };
  }
  if (env.orcaHandle) {
    const shown = await deps
      .run(deps.bin('orca'), ['terminal', 'show', '--terminal', env.orcaHandle, '--json'])
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
    const host = await findHost(proc.pid, deps);
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
    await deps.run(deps.bin('orca'), ['terminal', 'switch', '--terminal', host.handle, '--json']);
    await deps.run('/usr/bin/open', ['-a', 'Orca']).catch(() => '');
    return 'Orca의 해당 터미널로 이동했어요';
  }
  const tmux = deps.bin('tmux');
  await deps.run(tmux, ['-S', host.socket, 'select-window', '-t', host.pane]);
  await deps.run(tmux, ['-S', host.socket, 'select-pane', '-t', host.pane]);
  return `tmux ${host.label} 패널을 선택했어요`;
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

export async function sendToTerminal(
  live: LiveTerminal,
  input: unknown,
  deps = defaultTerminalDeps(),
): Promise<string> {
  const text = cleanInput(input);
  if (live.process.status !== 'idle')
    throw new TerminalInputError('작업 중이에요. 끝나면 다시 보내 주세요.');
  const { host } = live;
  if (host.kind === 'orca') {
    const out = await deps.run(deps.bin('orca'), [
      'terminal',
      'send',
      '--terminal',
      host.handle,
      '--text',
      text,
      '--enter',
      '--wait-submit',
      '5',
      '--json',
    ]);
    const send = JSON.parse(out)?.result?.send;
    if (send?.accepted !== true) throw new TerminalInputError('Orca가 입력을 받지 않았어요.');
    const stages: unknown = send.prompt?.stages;
    return Array.isArray(stages) && stages.includes('turn_started')
      ? 'Orca 터미널에 보냈고 작업이 시작됐어요'
      : 'Orca 터미널에 보냈어요';
  }
  const tmux = deps.bin('tmux');
  const buffer = `agent-office-${randomUUID()}`;
  await deps.run(tmux, ['-S', host.socket, 'set-buffer', '-b', buffer, '--', text]);
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
  await deps.wait(150);
  await deps.run(tmux, ['-S', host.socket, 'send-keys', '-t', host.pane, 'Enter']);
  return `tmux ${host.label}에 보냈어요`;
}
