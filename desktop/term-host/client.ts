import { spawn } from 'node:child_process';
import { closeSync, openSync, renameSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import {
  ensureSocketDir,
  readOrCreateToken,
  termHostPaths,
  type TermHostPaths,
} from './endpoint.js';
import {
  FrameDecoder,
  TERM_HOST_PROTOCOL,
  encodeData,
  encodeJson,
  type AttachResult,
  type ErrorCode,
  type ExitInfo,
  type ListResult,
  type Request,
  type ScreenRead,
  type ScreenRestore,
  type SessionSpec,
  type SessionStats,
} from './protocol.js';

/** The client end of a connection (a `net.Socket`, or a fake). */
export interface ClientConnection {
  write(data: Buffer): boolean;
  end(): void;
  destroy(): void;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  /** Stops and restarts reading (a `net.Socket`); a view behind its screen uses them. */
  pause?(): unknown;
  resume?(): unknown;
}

export class TermHostError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** No daemon listens at all (no socket, or a stale one): nothing runs there. */
    readonly absent = false,
  ) {
    super(message);
    this.name = 'TermHostError';
  }
}

type Listener<A extends unknown[]> = (...args: A) => void;
const WRITE_CHUNK_BYTES = 1024 * 1024;

/**
 * The app's typed handle on the terminal host: requests resolve with the daemon's answer, and
 * output, exits and resync snapshots arrive through the `on…` subscriptions.
 */
export class TermHostClient {
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; attach?: string }
  >();
  /**
   * Events for a session that arrive right after its attach answer, held until the caller has
   * run: whoever awaits `attach` draws the snapshot before its first output, even when the answer
   * and that output came in one chunk.
   */
  private readonly held = new Map<string, (() => void)[]>();
  private nextId = 1;
  private isClosed = false;
  private readonly output = new Set<Listener<[string, Buffer]>>();
  private readonly exits = new Set<Listener<[string, ExitInfo]>>();
  private readonly resyncs = new Set<Listener<[string, ScreenRestore]>>();
  private readonly closes = new Set<Listener<[]>>();

  constructor(private readonly conn: ClientConnection) {
    conn.on('data', (chunk) => this.onData(chunk));
    conn.on('error', () => this.finish());
    conn.on('close', () => this.finish());
  }

  get closed() {
    return this.isClosed;
  }

  hello(token: string, client = 'agent-office') {
    return this.request<{ protocol: number; pid: number; startedAt: number }>({
      op: 'hello',
      protocol: TERM_HOST_PROTOCOL,
      token,
      client,
    });
  }

  create(spec: SessionSpec) {
    return this.request<SessionStats>({ op: 'create', spec });
  }

  list() {
    return this.request<ListResult>({ op: 'list' });
  }

  /** The screen to draw (feed `restoreSequence(result)` to a fresh xterm), then live output. */
  attach(sessionId: string, options: { scrollback?: number } = {}) {
    return this.request<AttachResult>({ op: 'attach', sessionId, ...options }, sessionId);
  }

  async detach(sessionId: string) {
    await this.request({ op: 'detach', sessionId });
  }

  /** The visible screen as the composer reads it, once the output so far is parsed. */
  screen(sessionId: string) {
    return this.request<ScreenRead>({ op: 'screen', sessionId });
  }

  /** Keyboard input; ordered with every other message on this connection. */
  write(sessionId: string, data: string | Uint8Array) {
    if (this.isClosed) throw new TermHostError('closed', 'terminal host connection closed');
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    // A huge paste goes in several frames, each well under the frame limit.
    for (let at = 0; at === 0 || at < bytes.length; at += WRITE_CHUNK_BYTES) {
      this.conn.write(encodeData(sessionId, bytes.subarray(at, at + WRITE_CHUNK_BYTES)));
    }
  }

  async resize(sessionId: string, cols: number, rows: number) {
    await this.request({ op: 'resize', sessionId, cols, rows });
  }

  kill(sessionId: string, signal?: 'SIGHUP' | 'SIGINT' | 'SIGTERM' | 'SIGKILL') {
    return this.request<{ killed: boolean }>({
      op: 'kill',
      sessionId,
      ...(signal ? { signal } : {}),
    });
  }

  /** Ends every session and stops the daemon. */
  async shutdown() {
    await this.request({ op: 'shutdown' });
  }

  onOutput(listener: Listener<[sessionId: string, data: Buffer]>) {
    return subscribe(this.output, listener);
  }

  onExit(listener: Listener<[sessionId: string, exit: ExitInfo]>) {
    return subscribe(this.exits, listener);
  }

  /** The view fell behind: clear it and draw this instead (output resumes after it). */
  onResync(listener: Listener<[sessionId: string, restore: ScreenRestore]>) {
    return subscribe(this.resyncs, listener);
  }

  onClose(listener: Listener<[]>) {
    return subscribe(this.closes, listener);
  }

  /**
   * Stops reading this connection while a view catches up, and starts again. The daemon then
   * holds back, and past its limit replaces what this view missed with a fresh screen
   * (`onResync`); the program itself never waits. Only for a connection that can pause.
   */
  pauseReading(paused: boolean) {
    if (this.isClosed || typeof this.conn.pause !== 'function') return;
    if (paused) this.conn.pause();
    else this.conn.resume?.();
  }

  close() {
    this.conn.end();
    this.finish();
  }

  /** Closes without waiting for the other side (it may not be answering at all). */
  destroy() {
    this.conn.destroy();
    this.finish();
  }

  private request<T>(request: Request, attach?: string): Promise<T> {
    if (this.isClosed) {
      return Promise.reject(new TermHostError('closed', 'terminal host connection closed'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, attach });
      this.conn.write(encodeJson({ t: 'req', id, ...request }));
    });
  }

  /** Delivers `event` for `sessionId` now, or after the attach answer it follows (see `held`). */
  private deliver(sessionId: string, event: () => void) {
    const held = this.held.get(sessionId);
    if (held) held.push(event);
    else event();
  }

  private holdAfterAttach(sessionId: string) {
    if (this.held.has(sessionId)) return;
    this.held.set(sessionId, []);
    // A macrotask: the awaiting caller's continuation (microtasks) runs first.
    setImmediate(() => {
      const events = this.held.get(sessionId) ?? [];
      this.held.delete(sessionId);
      for (const event of events) event();
    });
  }

  private onData(chunk: Buffer) {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch {
      this.conn.destroy();
      return this.finish();
    }
    for (const frame of frames) {
      if (frame.kind === 'data') {
        const { sessionId, data } = frame;
        this.deliver(sessionId, () => {
          for (const listener of this.output) listener(sessionId, data);
        });
        continue;
      }
      const message = frame.message as Record<string, unknown>;
      if (message?.t === 'res') {
        const waiter = this.pending.get(message.id as number);
        if (!waiter) continue;
        this.pending.delete(message.id as number);
        if (message.ok) {
          if (waiter.attach) this.holdAfterAttach(waiter.attach);
          waiter.resolve(message.result);
        } else {
          const error = message.error as { code: ErrorCode; message: string };
          waiter.reject(new TermHostError(error.code, error.message));
        }
      } else if (message?.t === 'ev' && message.ev === 'exit') {
        const sessionId = message.sessionId as string;
        const exit = message.exit as ExitInfo;
        this.deliver(sessionId, () => {
          for (const listener of this.exits) listener(sessionId, exit);
        });
      } else if (message?.t === 'ev' && message.ev === 'snapshot') {
        const sessionId = message.sessionId as string;
        const { snapshot, modes, cols, rows } = message as unknown as ScreenRestore;
        this.deliver(sessionId, () => {
          for (const listener of this.resyncs) listener(sessionId, { snapshot, modes, cols, rows });
        });
      }
    }
  }

  private finish() {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const waiter of this.pending.values()) {
      waiter.reject(new TermHostError('closed', 'terminal host connection closed'));
    }
    this.pending.clear();
    for (const listener of this.closes) listener();
  }
}

function subscribe<T>(set: Set<T>, listener: T) {
  set.add(listener);
  return () => void set.delete(listener);
}

/** How to start the daemon: a Node-compatible executable and the arguments before our flags. */
export interface DaemonCommand {
  execPath: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * The packaged daemon: the app's own executable as Node, running term-host.cjs from the same
 * folder as main.cjs. A small young generation keeps idle churn from growing RSS (Orca measured
 * ~120 MB without it); `--expose-gc` lets the daemon collect right after freeing a screen.
 */
export function bundledDaemon(dir = typeof __dirname === 'string' ? __dirname : ''): DaemonCommand {
  return {
    execPath: process.execPath,
    args: ['--max-semi-space-size=4', '--expose-gc', path.join(dir, 'term-host.cjs')],
  };
}

export interface ConnectDeps {
  connect(socketPath: string): Promise<ClientConnection>;
  spawnDaemon(command: DaemonCommand, flags: string[], paths: TermHostPaths): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface ConnectOptions {
  /** The app's data directory (`app.getPath('userData')`); never the real one in tests. */
  dataDir: string;
  /** Starts a daemon when none answers. Omitted: only connect to a running one. */
  daemon?: DaemonCommand;
  /** Passed to a daemon this call starts. */
  daemonOptions?: { idleMs?: number; scrollback?: number; exitRetentionMs?: number };
  timeoutMs?: number;
  clientName?: string;
  deps?: Partial<ConnectDeps>;
}

const MAX_SPAWNS = 3;
const HELLO_TIMEOUT_MS = 3_000;
const RESPAWN_GAP_MS = 750;

/**
 * Connects to this user's terminal host, starting it if nothing answers. Safe to race: two app
 * instances may each start a daemon, but only one can publish the socket (endpoint.ts); the
 * other exits and both clients end up on the winner.
 */
export async function connectTermHost(options: ConnectOptions): Promise<TermHostClient> {
  const deps: ConnectDeps = { ...defaultConnectDeps, ...options.deps };
  const paths = termHostPaths(options.dataDir);
  // Before connecting: a listener planted at a predictable path must not receive our token.
  ensureSocketDir(paths);
  const token = readOrCreateToken(paths.token);
  const deadline = deps.now() + (options.timeoutMs ?? 10_000);
  const flags = daemonFlags(options.daemonOptions);
  let spawns = 0;
  let lastSpawn = -Infinity;
  let delay = 20;
  let last: unknown = null;
  for (;;) {
    try {
      const client = new TermHostClient(await deps.connect(paths.socket));
      try {
        // A listener that accepts and never answers must not hold us past the deadline.
        const left = Math.max(1, Math.min(HELLO_TIMEOUT_MS, deadline - deps.now()));
        await withTimeout(client.hello(token, options.clientName), left, () => client.destroy());
        return client;
      } catch (error) {
        client.close();
        // Auth and version failures will not fix themselves; a stopping daemon will.
        if (error instanceof TermHostError && (error.code === 'auth' || error.code === 'version')) {
          throw error;
        }
        last = error;
      }
    } catch (error) {
      if (error instanceof TermHostError) throw error;
      last = error;
      const code = (error as NodeJS.ErrnoException).code;
      const absent = code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ENOTSOCK';
      if (absent && !options.daemon) {
        throw new TermHostError('unavailable', 'no terminal host is running', true);
      }
      const now = deps.now();
      if (absent && spawns < MAX_SPAWNS && now - lastSpawn >= RESPAWN_GAP_MS) {
        deps.spawnDaemon(options.daemon!, flags, paths);
        spawns++;
        lastSpawn = now;
      }
    }
    if (deps.now() >= deadline) {
      throw new TermHostError(
        'unavailable',
        `terminal host did not answer (${String((last as Error)?.message ?? last)}); see ${paths.log}`,
      );
    }
    await deps.sleep(delay);
    delay = Math.min(delay * 2, 200);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new TermHostError('unavailable', 'terminal host did not answer hello'));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function daemonFlags(options: ConnectOptions['daemonOptions'] = {}) {
  const flags: string[] = [];
  if (options.idleMs !== undefined) flags.push('--idle-ms', String(options.idleMs));
  if (options.scrollback !== undefined) flags.push('--scrollback', String(options.scrollback));
  if (options.exitRetentionMs !== undefined) {
    flags.push('--exit-retention-ms', String(options.exitRetentionMs));
  }
  return flags;
}

const LOG_ROTATE_BYTES = 1024 * 1024;

export const defaultConnectDeps: ConnectDeps = {
  connect: (socketPath) =>
    new Promise((resolve, reject) => {
      const socket = connect({ path: socketPath });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }));
      }, 2_000);
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve(socket);
      });
    }),
  /** Detached, in its own process group, output to a capped log in the private directory. */
  spawnDaemon(command, flags, paths) {
    try {
      if (statSync(paths.log).size > LOG_ROTATE_BYTES) renameSync(paths.log, `${paths.log}.1`);
    } catch {
      // No log yet.
    }
    const log = openSync(paths.log, 'a', 0o600);
    try {
      const child = spawn(
        command.execPath,
        [...command.args, '--dir', paths.dir, '--socket', paths.socket, ...flags],
        {
          cwd: paths.dir,
          detached: true,
          stdio: ['ignore', log, log],
          env: { ...(command.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
        },
      );
      child.on('error', () => {});
      child.unref();
    } finally {
      closeSync(log);
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};
