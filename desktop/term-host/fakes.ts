/**
 * Test doubles for the terminal host: a PTY that only does what a test tells it, an in-memory
 * connection pair whose writer can be stalled (a slow client), and a whole host wired to both.
 * Never imported by the app or the daemon.
 */
import { EventEmitter } from 'node:events';
import { TermHostClient } from './client.js';
import { TermHost, type HostLimits } from './host.js';
import type { PtyProcess, SpawnPty } from './session.js';

export class FakePty implements PtyProcess {
  private static nextPid = 41_000;
  readonly pid = FakePty.nextPid++;
  readonly written: Buffer[] = [];
  readonly sizes: [number, number][] = [];
  readonly kills: (string | undefined)[] = [];
  private data = new Set<(data: string | Uint8Array) => void>();
  private exits = new Set<(event: { exitCode: number; signal?: number }) => void>();
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly options: { cwd: string; env: Record<string, string>; cols: number; rows: number },
  ) {}
  onData(callback: (data: string | Uint8Array) => void) {
    this.data.add(callback);
  }
  onExit(callback: (event: { exitCode: number; signal?: number }) => void) {
    this.exits.add(callback);
  }
  /** The program printed `data`. */
  output(data: string | Uint8Array) {
    for (const callback of this.data) callback(data);
  }
  /** The program ended. */
  exit(exitCode = 0, signal?: number) {
    for (const callback of this.exits) callback({ exitCode, signal });
  }
  write(data: string | Buffer) {
    this.written.push(Buffer.from(data));
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
  }
  kill(signal?: string) {
    this.kills.push(signal);
  }
  get input() {
    return Buffer.concat(this.written).toString('utf8');
  }
}

/** One end of an in-memory stream. `stall()` holds writes as an unread socket buffer would. */
export class FakeConnection extends EventEmitter {
  peer!: FakeConnection;
  closed = false;
  writableLength = 0;
  private stalled = false;
  private held: Buffer[] = [];

  write(data: Buffer) {
    if (this.closed) return false;
    if (this.stalled) {
      this.held.push(Buffer.from(data));
      this.writableLength += data.length;
      return this.writableLength < 16 * 1024;
    }
    this.deliver(Buffer.from(data));
    return true;
  }

  stall() {
    this.stalled = true;
  }

  /** Delivers what was held and reports `drain`, like a socket whose reader caught up. */
  resume() {
    this.stalled = false;
    const held = this.held;
    this.held = [];
    this.writableLength = 0;
    for (const data of held) this.deliver(data);
    queueMicrotask(() => this.emit('drain'));
  }

  end() {
    this.close();
  }

  destroy() {
    this.close();
  }

  private deliver(data: Buffer) {
    const peer = this.peer;
    queueMicrotask(() => {
      if (!peer.closed) peer.emit('data', data);
    });
  }

  private close() {
    if (this.closed) return;
    queueMicrotask(() => {
      if (this.closed) return;
      this.closed = true;
      this.emit('close');
      this.peer.close();
    });
  }
}

export function connectionPair(): [server: FakeConnection, client: FakeConnection] {
  const server = new FakeConnection();
  const client = new FakeConnection();
  server.peer = client;
  client.peer = server;
  return [server, client];
}

export const FAKE_TOKEN = 'f'.repeat(64);

/** A host with fake PTYs and in-memory clients. Group signals are recorded, not sent. */
export function fakeTermHost(limits: Partial<HostLimits> = {}) {
  const ptys: FakePty[] = [];
  const groupSignals: [number, string][] = [];
  const spawn: SpawnPty = (file, args, options) => {
    const pty = new FakePty(file, args, options);
    ptys.push(pty);
    return pty;
  };
  let idle = 0;
  const host = new TermHost({
    token: FAKE_TOKEN,
    loadSpawn: () => spawn,
    killGroup: (pid, signal) => void groupSignals.push([pid, signal]),
    limits: { flushDelayMs: 0, ...limits },
    onIdle: () => void idle++,
  });
  const connections: FakeConnection[] = [];
  return {
    host,
    ptys,
    groupSignals,
    connections,
    get idleExits() {
      return idle;
    },
    /** A raw connection: the test speaks frames itself. */
    open() {
      const [server, client] = connectionPair();
      host.handleConnection(server);
      connections.push(server);
      return { server, client };
    },
    /** A client past `hello`. */
    async connect() {
      const { server, client: end } = this.open();
      const client = new TermHostClient(end);
      await client.hello(FAKE_TOKEN, 'test');
      return { client, server };
    },
  };
}
