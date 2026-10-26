import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { m } from '../src/shared/i18n/index.js';
import { SHELL_NAME, type ShellAttachment, type ShellInfo } from '../src/shared/mini-shell.js';
import { defaultResumeDeps } from './tmux-resume.js';
import { tmuxArg } from './terminal-host.js';

/** The part of node-pty this module uses (a fake in tests). */
export interface PtyLike {
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
export interface ShellDeps {
  run: (file: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => Promise<string>;
  binary: (name: string) => Promise<string>;
  directory: (cwd: string) => Promise<boolean>;
  /** The person's login shell. */
  loginShell: () => Promise<string>;
  spawn: (
    file: string,
    args: string[],
    options: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv },
  ) => Promise<PtyLike>;
  platform: string;
  /** Dedicated tmux server (`tmux -L`), never the person's own and not tmux resume's. */
  server: string;
}
/** A server name a test may pick instead of the real one (`AGENT_OFFICE_SHELL_SERVER`). */
export function shellServer(env: NodeJS.ProcessEnv = process.env) {
  const v = env.AGENT_OFFICE_SHELL_SERVER;
  return v && /^[a-zA-Z0-9_-]{1,64}$/.test(v) && v !== 'agent-office' ? v : 'agent-office-shell';
}
/** The login shell, only when /etc/shells lists it; otherwise the system default. */
export async function loginShell(
  candidates = [safeUserShell(), process.env.SHELL],
  read = (f: string) => readFile(f, 'utf8'),
  platform = process.platform,
) {
  const listed = new Set(
    (await read('/etc/shells').catch(() => ''))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('/')),
  );
  for (const c of candidates) if (c && path.isAbsolute(c) && listed.has(c)) return c;
  return platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
}
function safeUserShell() {
  try {
    return os.userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}
/** The slice of node-pty's API used here, declared locally: `node-pty` is an optional
 * dependency, so type-checking and building must not need it installed. */
interface NodePty {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cwd: string;
      cols: number;
      rows: number;
      env: NodeJS.ProcessEnv;
    },
  ): PtyLike;
}
/**
 * Loads node-pty on first use (a build without the native module still starts, without the
 * feature). A runtime require by name keeps it out of the bundle and of `tsc`'s module
 * resolution. The bundled app has `require`; scripts run through tsx from the repo resolve it
 * from the working directory.
 */
export function loadNodePty(
  load: (id: string) => unknown = typeof require === 'function'
    ? require
    : createRequire(path.join(process.cwd(), 'index.js')),
): NodePty {
  const name = ['node', 'pty'].join('-');
  return load(name) as NodePty;
}
export const defaultShellDeps = (): ShellDeps => ({
  run: (file, args, options) =>
    defaultResumeDeps.run(file, args, options) as unknown as Promise<string>,
  binary: defaultResumeDeps.binary,
  directory: defaultResumeDeps.directory,
  loginShell: () => loginShell(),
  async spawn(file, args, options) {
    return loadNodePty().spawn(file, args, { name: 'xterm-256color', ...options });
  },
  platform: process.platform,
  server: shellServer(),
});

/** One folder's shell: a stable name, and a token that proves this app made it. */
export function describeShell(cwd: string) {
  if (!cwd || !path.isAbsolute(cwd) || /[\x00-\x1f\x7f]/.test(cwd))
    throw new Error(m().shell.folderMissing);
  const folder = path.resolve(cwd);
  const token = createHash('sha256').update(`shell:${folder}`).digest('hex');
  return { name: `shell-${token.slice(0, 16)}`, token, cwd: folder };
}
const NO_SERVER = /no server running|No such file or directory|error connecting/i;
/** Child environment: no inherited tmux client, a UTF-8 locale even when started from Finder. */
export function shellEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.CLAUDECODE;
  delete env.ELECTRON_RUN_AS_NODE;
  if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = 'en_US.UTF-8';
  return env;
}

interface Attachment {
  pty: PtyLike;
  owner: number;
  name: string;
}
/**
 * Shells kept by a dedicated tmux server, one per folder. A window attaches through a PTY
 * running `tmux attach`; closing the panel or the app only ends that client, so the shell and
 * what runs in it stay until the person ends it here or exits it.
 */
export class MiniShells {
  private attachments = new Map<string, Attachment>();
  /** Bumped when a window closes or reloads: a spawn still in flight for it is then dropped. */
  private epochs = new Map<number, number>();
  /** The window's current lifetime; capture it before any await of a request it made. */
  epoch(owner: number) {
    return this.epochs.get(owner) ?? 0;
  }
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private deps: ShellDeps = defaultShellDeps()) {}
  get supported() {
    return ['darwin', 'linux'].includes(this.deps.platform);
  }
  private async tmux(args: string[]) {
    const tmux = await this.deps.binary('tmux');
    return this.deps.run(tmux, ['-L', this.deps.server, ...args], { env: shellEnv() });
  }
  /** Shells this app made (the token matches the folder they say they are for). */
  async list(): Promise<ShellInfo[]> {
    if (!this.supported) return [];
    let rows: string;
    try {
      rows = await this.tmux([
        'list-sessions',
        '-F',
        '#{session_name}\t#{@agent_office_shell}\t#{@agent_office_shell_cwd}\t#{session_attached}',
      ]);
    } catch (error) {
      const e = error as Error & { stderr?: string };
      if (NO_SERVER.test(`${e.message}\n${e.stderr ?? ''}`)) return [];
      throw new Error(m().shell.failed);
    }
    const result: ShellInfo[] = [];
    for (const line of rows.split('\n')) {
      const [name, token, encoded, attached] = line.split('\t');
      if (!name || !SHELL_NAME.test(name)) continue;
      const cwd = Buffer.from(encoded ?? '', 'base64').toString('utf8');
      try {
        const expected = describeShell(cwd);
        if (expected.name !== name || expected.token !== token) continue;
      } catch {
        continue;
      }
      result.push({ name, cwd, attached: Number(attached) || 0 });
    }
    return result.sort((a, b) => a.cwd.localeCompare(b.cwd));
  }
  private async find(name: string) {
    const shell = (await this.list()).find((s) => s.name === name);
    if (!shell) throw new Error(m().shell.gone);
    return shell;
  }
  /** Starts the folder's shell when it is not there yet. Returns whether it was started. */
  ensure(cwd: string, cols: number, rows: number): Promise<boolean> {
    const task = this.queue.then(async () => {
      if (!this.supported) throw new Error(m().shell.unsupported);
      const data = describeShell(cwd);
      if (!(await this.deps.directory(data.cwd))) throw new Error(m().shell.folderMissing);
      if ((await this.list()).some((s) => s.name === data.name)) return false;
      const shell = await this.deps.loginShell();
      try {
        // Multiple command arguments are exec'd by tmux, not parsed by a shell. The ownership
        // marks go in the same tmux command queue as the session, so no one sees it unmarked.
        await this.tmux([
          '-f',
          '/dev/null',
          'new-session',
          '-d',
          '-x',
          String(cols),
          '-y',
          String(rows),
          '-s',
          data.name,
          '-c',
          // tmux reads a trailing `;` as a command separator, even as its own argv entry.
          tmuxArg(data.cwd),
          tmuxArg(shell),
          '-l',
          ';',
          'set-option',
          '-t',
          data.name,
          '@agent_office_shell_cwd',
          Buffer.from(data.cwd).toString('base64'),
          ';',
          'set-option',
          '-t',
          data.name,
          '@agent_office_shell',
          data.token,
          ';',
          // A small panel has no room for a status line; the wheel scrolls tmux's history.
          'set-option',
          '-t',
          data.name,
          'status',
          'off',
          ';',
          'set-option',
          '-t',
          data.name,
          'mouse',
          'on',
        ]);
      } catch {
        throw new Error(m().shell.failed);
      }
      return true;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
  /** Attaches `owner` (a window) to an existing shell through its own PTY. */
  async attach(
    owner: number,
    name: string,
    cols: number,
    rows: number,
    sink: { data: (ptyId: string, data: string) => void; exit: (ptyId: string) => void },
    created = false,
    since = this.epoch(owner),
  ): Promise<ShellAttachment> {
    if (!this.supported) throw new Error(m().shell.unsupported);
    const shell = await this.find(name);
    const tmux = await this.deps.binary('tmux');
    let pty: PtyLike;
    try {
      pty = await this.deps.spawn(
        tmux,
        ['-u', '-L', this.deps.server, 'attach-session', '-t', '=' + name],
        {
          cwd: (await this.deps.directory(shell.cwd)) ? shell.cwd : os.homedir(),
          cols,
          rows,
          env: shellEnv(),
        },
      );
    } catch {
      throw new Error(m().shell.noPty);
    }
    // The window left while this was starting: end the new client now, or it would stay
    // attached with no one to show it to (and no window that could ever detach it).
    if (this.epoch(owner) !== since) {
      pty.kill();
      throw new Error(m().shell.gone);
    }
    const ptyId = randomUUID();
    this.attachments.set(ptyId, { pty, owner, name });
    // Output is coalesced per tick: a burst (a long `ls`) is one message, not hundreds.
    let pending = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (!pending) return;
      const chunk = pending;
      pending = '';
      sink.data(ptyId, chunk);
    };
    pty.onData((d) => {
      pending += d;
      timer ??= setTimeout(flush, 8);
    });
    pty.onExit(() => {
      if (timer) clearTimeout(timer);
      flush();
      this.attachments.delete(ptyId);
      sink.exit(ptyId);
    });
    return { ptyId, name, cwd: shell.cwd, created };
  }
  /** Opens the folder's shell (starting it when needed) and attaches `owner`. */
  async open(
    owner: number,
    cwd: string,
    cols: number,
    rows: number,
    sink: Parameters<MiniShells['attach']>[4],
    since = this.epoch(owner),
  ) {
    // A request from a window that has since closed or reloaded starts nothing.
    if (this.epoch(owner) !== since) throw new Error(m().shell.gone);
    const created = await this.ensure(cwd, cols, rows);
    return this.attach(owner, describeShell(cwd).name, cols, rows, sink, created, since);
  }
  private own(owner: number, ptyId: string) {
    const a = this.attachments.get(ptyId);
    return a && a.owner === owner ? a : null;
  }
  /** Keystrokes from the window that owns this attachment; anything else is dropped. */
  write(owner: number, ptyId: string, data: string) {
    this.own(owner, ptyId)?.pty.write(data);
  }
  resize(owner: number, ptyId: string, cols: number, rows: number) {
    const a = this.own(owner, ptyId);
    if (!a) return;
    try {
      a.pty.resize(cols, rows);
    } catch {
      /* the client already left */
    }
  }
  /** Ends this window's client only; the shell keeps running in tmux. */
  detach(owner: number, ptyId: string) {
    const a = this.own(owner, ptyId);
    if (!a) return;
    this.attachments.delete(ptyId);
    a.pty.kill();
  }
  /** A window closed or reloaded: its clients go, the shells stay. */
  detachOwner(owner: number) {
    this.epochs.set(owner, this.epoch(owner) + 1);
    for (const [id, a] of this.attachments) if (a.owner === owner) this.detach(owner, id);
  }
  /** Ends the shell itself (after the person confirmed) — every client of it closes too. */
  async kill(name: string, confirm: (shell: ShellInfo) => Promise<boolean>) {
    const shell = await this.find(name);
    if (!(await confirm(shell))) return false;
    try {
      await this.tmux(['kill-session', '-t', '=' + shell.name]);
    } catch {
      throw new Error(m().shell.failed);
    }
    return true;
  }
  /** Quitting the app leaves every shell running; only the clients end. */
  dispose() {
    for (const [id, a] of this.attachments) this.detach(a.owner, id);
  }
  get attachedCount() {
    return this.attachments.size;
  }
}
