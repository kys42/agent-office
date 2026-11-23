import { existsSync } from 'node:fs';
import {
  TermHostClient,
  TermHostError,
  bundledDaemon,
  connectTermHost,
  type ConnectOptions,
  type DaemonCommand,
} from './term-host/client.js';
import { termHostPaths } from './term-host/endpoint.js';
import type { ListResult, ScreenRead, SessionSpec, SessionStats } from './term-host/protocol.js';

/**
 * The built-in terminal as the rest of the main process sees it (#401): the terminal host
 * daemon (desktop/term-host/, docs/development/TERM-HOST.md) behind a few calls.
 *
 * - Only a launch starts the daemon. Every lookup (who runs where, a screen read, a key) only
 *   connects to one that already runs: with no socket there is nothing to find, said at once
 *   without touching the disk beyond one `stat`, and remembered for a second like a failure.
 * - One control connection serves the lookups; it closes after a short idle time so the daemon
 *   can still exit once its sessions end (it waits for no session and no client).
 * - Every request a lookup makes has a time limit: a daemon that stopped answering makes a
 *   lookup unknown, never stuck.
 */

/** The live sessions of the daemon that runs, and its pid (the parent of every session). */
export interface BuiltinInventory {
  daemonPid: number;
  sessions: SessionStats[];
}

export interface BuiltinTerminals {
  /** Live sessions; null when no daemon runs. Throws when one runs but could not be asked. */
  sessions(fresh?: boolean): Promise<BuiltinInventory | null>;
  /** The visible screen of a live session (`ScreenRead`). */
  screen(sessionId: string): Promise<ScreenRead>;
  /** Keyboard input, in order with every other request (never starts a daemon). */
  write(sessionId: string, data: string): Promise<void>;
  /** Starts a session, starting the daemon first when none runs. */
  create(spec: SessionSpec): Promise<SessionStats>;
  /** Ends a session and everything in its process group (never starts a daemon). */
  kill?(sessionId: string): Promise<boolean>;
  /**
   * Brings a session's screen to the front (a terminal window), answering what was done. Left
   * out where the app cannot show one: going there is then refused with a reason.
   */
  show?(sessionId: string): Promise<string>;
}

export interface TermBuiltinOptions {
  /** The app's data directory (`app.getPath('userData')`). */
  dataDir: string;
  platform?: string;
  /** How a launch starts the daemon (the packaged one when left out). */
  daemon?: DaemonCommand;
  /** Tests: the connection and the clock. */
  connect?: (options: ConnectOptions) => Promise<TermHostClient>;
  socketExists?: (socket: string) => boolean;
  now?: () => number;
  /** Lookups share one answer this long (and a failure as long). */
  cacheMs?: number;
  /** A lookup's request gives up after this long. */
  requestMs?: number;
  /** The control connection closes after this long unused. */
  idleMs?: number;
}

/** Where the built-in terminal exists at all (Windows comes with #401's 2b). */
export const builtinSupported = (platform: string = process.platform) =>
  platform === 'darwin' || platform === 'linux';

export class TermBuiltin implements BuiltinTerminals {
  /** Set by main once it can open a terminal window (see `BuiltinTerminals.show`). */
  show?: (sessionId: string) => Promise<string>;
  private client: Promise<TermHostClient> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private cached: { at: number; value: Promise<ListResult | null> } | null = null;
  private readonly socket: string;
  private readonly now: () => number;

  constructor(private readonly options: TermBuiltinOptions) {
    this.socket = termHostPaths(options.dataDir).socket;
    this.now = options.now ?? Date.now;
  }

  get supported() {
    return builtinSupported(this.options.platform ?? process.platform);
  }

  async sessions(fresh = false): Promise<BuiltinInventory | null> {
    const list = await this.listing(fresh);
    return list && { daemonPid: list.daemon.pid, sessions: list.sessions.filter((s) => !s.exit) };
  }

  /**
   * The daemon's whole list (ended sessions it still keeps, its totals and memory); null when no
   * daemon runs. Shares the lookups' one-second answer; never starts a daemon.
   */
  listing(fresh = false): Promise<ListResult | null> {
    if (!this.supported) return Promise.resolve(null);
    const cacheMs = this.options.cacheMs ?? 1000;
    const hit = this.cached;
    if (!fresh && hit && this.now() - hit.at < cacheMs) return hit.value;
    const value = this.listLive();
    this.cached = { at: this.now(), value };
    // A failure is remembered as long as an answer (lookups come often), then asked again.
    value.catch(() => undefined);
    return value;
  }

  private async listLive(): Promise<ListResult | null> {
    let client: TermHostClient;
    try {
      client = await this.connection(false);
    } catch (error) {
      if (error instanceof TermHostError && error.absent) return null;
      throw error;
    }
    return this.timed(client, client.list());
  }

  async screen(sessionId: string): Promise<ScreenRead> {
    const client = await this.connection(false);
    return this.timed(client, client.screen(sessionId));
  }

  async write(sessionId: string, data: string): Promise<void> {
    const client = await this.connection(false);
    client.write(sessionId, data);
  }

  async create(spec: SessionSpec): Promise<SessionStats> {
    if (!this.supported) throw new TermHostError('unavailable', 'not supported here');
    const client = await this.connection(true);
    try {
      return await client.create(spec);
    } finally {
      this.cached = null;
    }
  }

  async kill(sessionId: string): Promise<boolean> {
    const client = await this.connection(false);
    try {
      return (await this.timed(client, client.kill(sessionId))).killed;
    } finally {
      this.cached = null;
    }
  }

  /** One live session's facts (its folder and program), when it runs. */
  async session(sessionId: string, fresh = true) {
    return (await this.sessions(fresh))?.sessions.find((s) => s.id === sessionId) ?? null;
  }

  /**
   * A connection of its own, for a view (desktop/term-views.ts): only to a daemon that runs,
   * since a view needs a session there.
   */
  connectView(): Promise<TermHostClient> {
    if (!this.supported || !(this.options.socketExists ?? existsSync)(this.socket))
      return Promise.reject(new TermHostError('unavailable', 'no terminal host is running', true));
    return (this.options.connect ?? connectTermHost)({
      dataDir: this.options.dataDir,
      timeoutMs: this.options.requestMs ?? 2_000,
      clientName: 'agent-office-view',
    });
  }

  /** Lets go of the control connection (the app quits: sessions keep running in the daemon). */
  close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const client = this.client;
    this.client = null;
    void client?.then((c) => c.close()).catch(() => undefined);
  }

  /**
   * The control connection: the open one, else a new one. `start`: a launch, which may start
   * the daemon; anything else only connects, and with no socket at all fails at once.
   */
  private async connection(start: boolean): Promise<TermHostClient> {
    this.touch();
    const open = this.client;
    if (open) {
      const client = await open.catch(() => null);
      if (client && !client.closed) return client;
      if (this.client === open) this.client = null;
    }
    if (!start && !(this.options.socketExists ?? existsSync)(this.socket))
      throw new TermHostError('unavailable', 'no terminal host is running', true);
    const connect = this.options.connect ?? connectTermHost;
    const next = connect({
      dataDir: this.options.dataDir,
      ...(start && { daemon: this.options.daemon ?? bundledDaemon() }),
      timeoutMs: start ? 10_000 : (this.options.requestMs ?? 2_000),
      clientName: 'agent-office',
    });
    this.client = next;
    next.then(
      (client) => client.onClose(() => this.client === next && (this.client = null)),
      () => this.client === next && (this.client = null),
    );
    return next;
  }

  /** Closes the control connection once unused for a while, so the daemon may exit. */
  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.options.idleMs ?? 30_000);
    this.idleTimer.unref?.();
  }

  /** A request with a time limit; past it the connection is dropped (the next one reconnects). */
  private timed<T>(client: TermHostClient, request: Promise<T>): Promise<T> {
    const ms = this.options.requestMs ?? 2_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.destroy();
        reject(new TermHostError('unavailable', 'terminal host did not answer'));
      }, ms);
      request.then(
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
}
