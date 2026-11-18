import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import {
  FrameDecoder,
  FrameError,
  MAX_FRAME_BYTES,
  MAX_HELLO_FRAME_BYTES,
  SESSION_ID,
  TERM_HOST_PROTOCOL,
  encodeData,
  encodeJson,
  type ErrorCode,
  type EventMessage,
  type Frame,
  type ListResult,
  type ResponseMessage,
  type SessionSpec,
} from './protocol.js';
import {
  Attachment,
  Session,
  type KillGroup,
  type SessionEvents,
  type SpawnPty,
} from './session.js';

/** A connected stream (a `net.Socket` in the daemon, a fake in tests). */
export interface Connection {
  write(data: Buffer): boolean;
  readonly writableLength: number;
  end(): void;
  destroy(): void;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'drain' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface HostLimits {
  /** With no session and no client, exit after this long. */
  idleMs: number;
  /** How long an ended session's exit status and last screen stay attachable. */
  exitRetentionMs: number;
  helloTimeoutMs: number;
  defaultScrollback: number;
  maxScrollback: number;
  maxSessions: number;
  /** Bytes waiting in a client's socket at which output stops being written to it. */
  highWaterBytes: number;
  /** Output queued for one attachment beyond this is dropped for a fresh snapshot. */
  maxLagBytes: number;
  /** Batches output: chunks arriving within this window go out as one frame. */
  flushDelayMs: number;
  killGraceMs: number;
  syncWaitMs: number;
}

export const DEFAULT_LIMITS: HostLimits = {
  idleMs: 60_000,
  exitRetentionMs: 5 * 60_000,
  helloTimeoutMs: 5_000,
  defaultScrollback: 1_000,
  maxScrollback: 10_000,
  maxSessions: 64,
  highWaterBytes: 512 * 1024,
  maxLagBytes: 4 * 1024 * 1024,
  flushDelayMs: 4,
  killGraceMs: 3_000,
  syncWaitMs: 100,
};

export interface HostDeps {
  token: string;
  /** node-pty's spawn, loaded on first use; throws when the native module is unavailable. */
  loadSpawn: () => SpawnPty;
  /** Null where process groups do not exist (Windows): the PTY's own kill is used. */
  killGroup: KillGroup | null;
  limits?: Partial<HostLimits>;
  /** The environment for sessions that bring none. */
  baseEnv?: NodeJS.ProcessEnv;
  /** False once another daemon has taken the endpoint: create nothing more. */
  ownsEndpoint?: () => boolean;
  /** Idle (or asked to shut down): the daemon should exit. */
  onIdle?: () => void;
  /** A session's screen was freed (the daemon may collect garbage soon after). */
  onScreenFreed?: () => void;
  log?: (line: string) => void;
}

const SIGNALS = new Set<string>(['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGKILL']);
const MAX_SIZE = 1000;

class RequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** One connection: authenticated by `hello`, then requests, writes, and batched output. */
class Client {
  readonly decoder = new FrameDecoder(MAX_HELLO_FRAME_BYTES);
  readonly attachments = new Map<string, Attachment>();
  authed = false;
  closed = false;
  private flushTimer: NodeJS.Timeout | null = null;
  helloTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly host: TermHost,
    readonly conn: Connection,
  ) {}

  send(message: ResponseMessage | EventMessage) {
    if (!this.closed) this.conn.write(encodeJson(message));
  }

  scheduleFlush() {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.host.limits.flushDelayMs);
  }

  /**
   * Writes queued output, one frame per session, while the socket keeps up. Past the high-water
   * mark it waits for `drain`; an attachment whose queue outgrows `maxLagBytes` meanwhile is
   * moved to a snapshot instead (see Session.onOutput).
   */
  flush() {
    if (this.closed) return;
    for (const attachment of this.attachments.values()) {
      if (this.conn.writableLength >= this.host.limits.highWaterBytes) return;
      if (attachment.state === 'lagged') this.host.resync(this, attachment);
      else if (attachment.state === 'live') this.writeOutput(attachment);
    }
  }

  writeOutput(attachment: Attachment) {
    const data = attachment.drain();
    if (!data || this.closed) return;
    attachment.session.bytesOut += data.length;
    this.conn.write(encodeData(attachment.session.id, data));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    for (const attachment of this.attachments.values()) {
      attachment.session.attachments.delete(attachment);
    }
    this.attachments.clear();
  }
}

/**
 * The daemon's state: sessions, clients, and the request handlers between them. Free of
 * sockets and node-pty so tests drive it with fakes; daemon.ts wires the real ones.
 */
export class TermHost implements SessionEvents {
  readonly limits: HostLimits;
  readonly sessions = new Map<string, Session>();
  readonly clients = new Set<Client>();
  readonly startedAt = Date.now();
  private spawn: SpawnPty | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private retention = new Map<string, NodeJS.Timeout>();
  private stopping: Promise<void> | null = null;
  private readonly tokenDigest: Buffer;

  constructor(private readonly deps: HostDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.tokenDigest = digest(deps.token);
    this.checkIdle();
  }

  handleConnection(conn: Connection) {
    const client = new Client(this, conn);
    this.clients.add(client);
    this.checkIdle();
    // Long timers are unref'd: the listening socket is what keeps the daemon alive.
    client.helloTimer = setTimeout(() => {
      if (!client.authed) this.drop(client, 'no hello');
    }, this.limits.helloTimeoutMs).unref();
    conn.on('data', (chunk) => {
      if (client.closed) return;
      let frames: Frame[];
      try {
        frames = client.decoder.push(chunk);
      } catch (error) {
        return this.drop(client, (error as FrameError).message);
      }
      for (const frame of frames) {
        if (client.closed) return;
        this.onFrame(client, frame);
      }
    });
    conn.on('drain', () => client.flush());
    conn.on('error', () => this.disconnect(client));
    conn.on('close', () => this.disconnect(client));
  }

  private drop(client: Client, why: string) {
    this.deps.log?.(`client dropped: ${why}`);
    client.conn.destroy();
    this.disconnect(client);
  }

  private disconnect(client: Client) {
    if (!this.clients.delete(client)) return;
    client.close();
    this.checkIdle();
  }

  private onFrame(client: Client, frame: Frame) {
    if (frame.kind === 'data') {
      if (!client.authed) return this.drop(client, 'data before hello');
      // Keyboard input: fire-and-forget, in order with everything else on the connection.
      this.sessions.get(frame.sessionId)?.write(frame.data);
      return;
    }
    const message = frame.message as { t?: unknown; id?: unknown; op?: unknown };
    if (
      !message ||
      message.t !== 'req' ||
      !Number.isSafeInteger(message.id) ||
      typeof message.op !== 'string'
    ) {
      return this.drop(client, 'malformed message');
    }
    const id = message.id as number;
    if (!client.authed) return this.hello(client, id, message as Record<string, unknown>);
    this.handle(client, message as Record<string, unknown>).then(
      (result) => client.send({ t: 'res', id, ok: true, result: result ?? null }),
      (error: unknown) => {
        const failure =
          error instanceof RequestError
            ? { code: error.code, message: error.message }
            : { code: 'bad-request' as const, message: String((error as Error)?.message ?? error) };
        client.send({ t: 'res', id, ok: false, error: failure });
      },
    );
  }

  private hello(client: Client, id: number, message: Record<string, unknown>) {
    const refuse = (code: ErrorCode, text: string) => {
      client.send({ t: 'res', id, ok: false, error: { code, message: text } });
      client.conn.end();
      this.disconnect(client);
    };
    if (message.op !== 'hello') return refuse('auth', 'hello first');
    // About to exit: the client retries and reaches (or starts) the next daemon.
    if (this.stopping) return refuse('unavailable', 'daemon is stopping');
    if (message.protocol !== TERM_HOST_PROTOCOL) {
      return refuse('version', `daemon speaks protocol ${TERM_HOST_PROTOCOL}`);
    }
    const token = typeof message.token === 'string' ? message.token : '';
    if (!timingSafeEqual(digest(token), this.tokenDigest)) return refuse('auth', 'bad token');
    client.authed = true;
    client.decoder.maxFrameBytes = MAX_FRAME_BYTES;
    if (client.helloTimer) clearTimeout(client.helloTimer);
    client.helloTimer = null;
    client.send({
      t: 'res',
      id,
      ok: true,
      result: { protocol: TERM_HOST_PROTOCOL, pid: process.pid, startedAt: this.startedAt },
    });
  }

  private async handle(client: Client, message: Record<string, unknown>): Promise<unknown> {
    switch (message.op) {
      case 'create':
        return this.create(message.spec);
      case 'list':
        return this.list();
      case 'attach':
        return this.attach(client, this.session(message.sessionId), message.scrollback);
      case 'detach': {
        const session = this.session(message.sessionId);
        const attachment = client.attachments.get(session.id);
        if (attachment) {
          client.attachments.delete(session.id);
          session.attachments.delete(attachment);
        }
        return null;
      }
      case 'resize': {
        const session = this.session(message.sessionId);
        const cols = size(message.cols, 'cols');
        const rows = size(message.rows, 'rows');
        if (!session.resize(cols, rows)) throw new RequestError('exited', 'session has exited');
        return null;
      }
      case 'kill': {
        const session = this.session(message.sessionId);
        const signal = message.signal ?? 'SIGHUP';
        if (typeof signal !== 'string' || !SIGNALS.has(signal)) {
          throw new RequestError('bad-request', 'signal');
        }
        return { killed: session.kill(signal as NodeJS.Signals) };
      }
      case 'shutdown':
        // After this answer is written.
        setImmediate(() => void this.shutdown().then(() => this.deps.onIdle?.()));
        return null;
      default:
        throw new RequestError('bad-request', `unknown op ${String(message.op)}`);
    }
  }

  private session(id: unknown) {
    const session = typeof id === 'string' ? this.sessions.get(id) : undefined;
    if (!session) throw new RequestError('unknown-session', `no session ${String(id)}`);
    return session;
  }

  private create(raw: unknown) {
    if (this.stopping) throw new RequestError('unavailable', 'daemon is stopping');
    if (this.deps.ownsEndpoint && !this.deps.ownsEndpoint()) {
      throw new RequestError('unavailable', 'daemon no longer owns its endpoint; reconnect');
    }
    const spec = validSpec(raw, this.limits);
    const live = [...this.sessions.values()].filter((s) => s.live).length;
    if (live >= this.limits.maxSessions) throw new RequestError('limit', 'too many sessions');
    const id = spec.id ?? this.newId();
    if (this.sessions.has(id)) throw new RequestError('exists', `session ${id} exists`);
    try {
      this.spawn ??= this.deps.loadSpawn();
    } catch (error) {
      throw new RequestError('unavailable', `node-pty unavailable: ${(error as Error).message}`);
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.env ?? this.deps.baseEnv ?? process.env)) {
      if (typeof v === 'string') env[k] = v;
    }
    // The daemon runs as Node through Electron; programs it starts must not inherit that.
    delete env.ELECTRON_RUN_AS_NODE;
    let pty;
    try {
      pty = this.spawn(spec.argv[0], spec.argv.slice(1), {
        name: 'xterm-256color',
        cwd: spec.cwd,
        env,
        cols: spec.cols,
        rows: spec.rows,
      });
    } catch (error) {
      throw new RequestError('spawn-failed', (error as Error).message);
    }
    const session = new Session(
      id,
      {
        argv: spec.argv,
        cwd: spec.cwd,
        cols: spec.cols,
        rows: spec.rows,
        scrollback: spec.scrollback ?? this.limits.defaultScrollback,
      },
      pty,
      this,
      this.limits,
      this.deps.killGroup,
    );
    this.sessions.set(id, session);
    this.checkIdle();
    this.deps.log?.(`session ${id} started (pid ${pty.pid})`);
    return session.stats();
  }

  private newId() {
    for (;;) {
      const id = randomBytes(6).toString('hex');
      if (!this.sessions.has(id)) return id;
    }
  }

  private attach(client: Client, session: Session, scrollback: unknown) {
    const lines =
      scrollback === undefined
        ? undefined
        : Number.isInteger(scrollback) && (scrollback as number) >= 0
          ? (scrollback as number)
          : undefined;
    if (!session.live) {
      return Promise.resolve({
        session: session.stats(),
        exit: session.exit,
        ...session.lastScreen(),
      });
    }
    const previous = client.attachments.get(session.id);
    if (previous) session.attachments.delete(previous);
    const attachment = new Attachment(session, client);
    client.attachments.set(session.id, attachment);
    session.attachments.add(attachment);
    return new Promise((resolve) => {
      session.capture(attachment, lines, (restore) => {
        const result = {
          session: session.stats(),
          ...(session.exit ? { exit: session.exit } : {}),
          ...restore,
        };
        // Detached, reattached or ended meanwhile: answer, but this attachment is not live.
        if (client.attachments.get(session.id) !== attachment) return resolve(result);
        // The response is sent before any output queued after the snapshot is flushed.
        attachment.state = 'live';
        resolve(result);
        client.scheduleFlush();
      });
    });
  }

  /** Session events. */
  queued(attachment: Attachment) {
    (attachment.owner as Client).scheduleFlush();
  }

  lagged(attachment: Attachment) {
    (attachment.owner as Client).scheduleFlush();
  }

  /** Replaces the output a slow client missed with a fresh snapshot. */
  resync(client: Client, attachment: Attachment) {
    const session = attachment.session;
    this.deps.log?.(`session ${session.id}: client lagged, sending a snapshot`);
    session.capture(attachment, 0, (restore) => {
      if (client.closed || client.attachments.get(session.id) !== attachment) return;
      client.send({ t: 'ev', ev: 'snapshot', sessionId: session.id, reason: 'resync', ...restore });
      attachment.state = 'live';
      client.scheduleFlush();
    });
  }

  exited(session: Session) {
    this.deps.log?.(`session ${session.id} exited (${JSON.stringify(session.exit)})`);
    this.deps.onScreenFreed?.();
    for (const attachment of session.attachments) {
      const client = attachment.owner as Client;
      // Output from before the exit goes first, whatever the socket's backlog.
      if (attachment.state === 'live') client.writeOutput(attachment);
      client.attachments.delete(session.id);
    }
    session.attachments.clear();
    for (const client of this.clients) {
      if (client.authed) {
        client.send({ t: 'ev', ev: 'exit', sessionId: session.id, exit: session.exit! });
      }
    }
    this.retention.set(
      session.id,
      setTimeout(() => {
        this.retention.delete(session.id);
        this.sessions.delete(session.id);
        this.checkIdle();
      }, this.limits.exitRetentionMs).unref(),
    );
    this.checkIdle();
  }

  list(): ListResult {
    const sessions = [...this.sessions.values()].map((s) => s.stats());
    const memory = process.memoryUsage();
    return {
      daemon: { pid: process.pid, protocol: TERM_HOST_PROTOCOL, startedAt: this.startedAt },
      sessions,
      total: {
        sessions: sessions.length,
        live: sessions.filter((s) => !s.exit).length,
        clients: [...this.clients].filter((c) => c.authed).length,
        scrollbackLines: sum(sessions, 'scrollbackLines'),
        approxBytes: sum(sessions, 'approxBytes'),
        bytesIn: sum(sessions, 'bytesIn'),
        bytesOut: sum(sessions, 'bytesOut'),
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        arrayBuffers: memory.arrayBuffers,
      },
    };
  }

  /** Counts down to exit while there is no session (live or retained) and no client. */
  private checkIdle() {
    const idle = this.sessions.size === 0 && this.clients.size === 0 && !this.stopping;
    if (!idle) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      return;
    }
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.deps.log?.('idle: exiting');
      void this.shutdown().then(() => this.deps.onIdle?.());
    }, this.limits.idleMs).unref();
  }

  /** Ends every session (group signal, then SIGKILL after the grace period) and every client. */
  shutdown(): Promise<void> {
    this.stopping ??= (async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      const live = [...this.sessions.values()].filter((s) => s.live);
      for (const session of live) session.kill('SIGHUP');
      const deadline = Date.now() + this.limits.killGraceMs + 1_000;
      while (live.some((s) => s.live) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      for (const timer of this.retention.values()) clearTimeout(timer);
      this.retention.clear();
      for (const client of [...this.clients]) {
        client.conn.end();
        this.disconnect(client);
      }
    })();
    return this.stopping;
  }
}

function digest(token: string) {
  return createHash('sha256').update(token, 'utf8').digest();
}

function sum<K extends keyof ListResult['sessions'][number]>(
  sessions: ListResult['sessions'],
  key: K,
) {
  return sessions.reduce((total, s) => total + (s[key] as number), 0);
}

function size(value: unknown, name: string) {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_SIZE) {
    throw new RequestError('bad-request', name);
  }
  return value as number;
}

function validSpec(raw: unknown, limits: HostLimits): SessionSpec {
  const spec = raw as Partial<SessionSpec> | null;
  const bad = (what: string) => new RequestError('bad-request', `spec.${what}`);
  if (!spec || typeof spec !== 'object') throw bad('');
  if (spec.id !== undefined && (typeof spec.id !== 'string' || !SESSION_ID.test(spec.id))) {
    throw bad('id');
  }
  const argv = spec.argv;
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every((a) => typeof a === 'string' && !a.includes('\0')) ||
    argv[0] === ''
  ) {
    throw bad('argv');
  }
  if (typeof spec.cwd !== 'string' || !path.isAbsolute(spec.cwd) || spec.cwd.includes('\0')) {
    throw bad('cwd');
  }
  if (spec.env !== undefined) {
    if (!spec.env || typeof spec.env !== 'object' || Array.isArray(spec.env)) throw bad('env');
    for (const [k, v] of Object.entries(spec.env)) {
      if (typeof v !== 'string' || k.includes('=') || k.includes('\0') || v.includes('\0')) {
        throw bad('env');
      }
    }
  }
  const scrollback = spec.scrollback;
  if (
    scrollback !== undefined &&
    (!Number.isInteger(scrollback) || scrollback < 0 || scrollback > limits.maxScrollback)
  ) {
    throw bad('scrollback');
  }
  return {
    ...(spec.id ? { id: spec.id } : {}),
    argv: [...argv],
    cwd: spec.cwd,
    ...(spec.env ? { env: { ...spec.env } } : {}),
    cols: size(spec.cols, 'spec.cols'),
    rows: size(spec.rows, 'spec.rows'),
    ...(scrollback !== undefined ? { scrollback } : {}),
  };
}
