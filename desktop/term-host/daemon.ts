/**
 * Terminal host daemon entry (bundled as dist-desktop/term-host.cjs). The app starts it detached
 * with `ELECTRON_RUN_AS_NODE=1 <app executable> term-host.cjs --dir <dir> --socket <path>`; it
 * outlives the app, keeps PTYs and their headless screens, and exits on its own once it has had
 * no session and no client for a while. See docs/development/TERM-HOST.md.
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { chmodSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_LIMITS, TermHost, type HostLimits } from './host.js';
import {
  ensureSocketDir,
  ownsSocket,
  privateBindPath,
  publishSocket,
  readOrCreateToken,
  type SocketIdentity,
} from './endpoint.js';
import type { SpawnPty } from './session.js';

/** Exit codes, for the log: another daemon serves this user; the endpoint could not be taken. */
const EXIT_OCCUPIED = 20;
const EXIT_NOT_PUBLISHED = 21;
const LOG_LIMIT = 512 * 1024;
const OWNERSHIP_CHECK_MS = 2_000;

let logged = 0;
function log(line: string) {
  if (logged > LOG_LIMIT) return;
  const text = `${new Date().toISOString()} [${process.pid}] ${line}\n`;
  logged += text.length;
  process.stderr.write(logged > LOG_LIMIT ? `${text}(log limit reached)\n` : text);
}

function parseArgs(argv: string[]) {
  const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const number = (name: string) => {
    const v = value(name);
    return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
  };
  const dir = value('dir');
  const socket = value('socket');
  if (!dir || !socket) throw new Error('usage: term-host --dir <dir> --socket <path>');
  const limits: Partial<HostLimits> = {};
  for (const [flag, key] of [
    ['idle-ms', 'idleMs'],
    ['scrollback', 'defaultScrollback'],
    ['exit-retention-ms', 'exitRetentionMs'],
  ] as const) {
    const n = number(flag);
    if (n !== undefined) limits[key] = n;
  }
  return { dir, socket, limits };
}

/** node-pty, resolved from this bundle (or, run from source, next to this file). */
function loadSpawn(): SpawnPty {
  const load =
    typeof require === 'function' ? require : createRequire(path.resolve(process.argv[1]));
  const pty = load(['node', 'pty'].join('-')) as { spawn: SpawnPty };
  return pty.spawn.bind(pty);
}

/**
 * With `--expose-gc` (the app passes it), collect a moment after screens are freed: the line
 * buffers are array buffers that an otherwise idle daemon would keep until some later GC.
 */
let collectTimer: NodeJS.Timeout | null = null;
function scheduleCollect() {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc || collectTimer) return;
  collectTimer = setTimeout(() => {
    collectTimer = null;
    gc();
  }, 1_000);
  collectTimer.unref();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.title = 'agent-office-term-host';
  // Detached: no terminal will hang up on us, and a stray HUP must not end every session.
  process.on('SIGHUP', () => {});
  const paths = {
    dir: args.dir,
    socket: args.socket,
    token: path.join(args.dir, 'token'),
    log: path.join(args.dir, 'daemon.log'),
  };
  ensureSocketDir(paths);
  const token = readOrCreateToken(paths.token);
  let identity: SocketIdentity | null = null;
  let exiting = false;
  const exit = (code: number) => {
    if (exiting) return;
    exiting = true;
    log(`exit ${code}`);
    // Never unlink the public socket name: the next daemon replaces it after proving us gone.
    process.exit(code);
  };
  const host = new TermHost({
    token,
    loadSpawn,
    killGroup: process.platform === 'win32' ? null : (pid, signal) => process.kill(-pid, signal),
    limits: { ...DEFAULT_LIMITS, ...args.limits },
    ownsEndpoint: () => ownsSocket(paths.socket, identity),
    onIdle: () => exit(0),
    onScreenFreed: scheduleCollect,
    log,
  });
  const server = createServer((socket) => host.handleConnection(socket));
  server.on('error', (error) => {
    log(`server error: ${error.message}`);
    void host.shutdown().then(() => exit(1));
  });
  const bindPath = process.platform === 'win32' ? paths.socket : privateBindPath(paths.socket);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(bindPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    log(`listen failed: ${code ?? (error as Error).message}`);
    // A named pipe in use means another daemon already serves this user.
    return exit(code === 'EADDRINUSE' ? EXIT_OCCUPIED : EXIT_NOT_PUBLISHED);
  }
  if (process.platform !== 'win32') chmodSync(bindPath, 0o600);
  const outcome = await publishSocket(bindPath, paths.socket);
  if (outcome.status !== 'published') {
    log(`not serving: endpoint ${outcome.status}`);
    server.close();
    return exit(outcome.status === 'occupied' ? EXIT_OCCUPIED : EXIT_NOT_PUBLISHED);
  }
  identity = outcome.identity;
  log(`serving ${paths.socket}`);
  // Another daemon took the socket (see endpoint.ts): new clients reach it, not us. Stop once
  // nothing of ours is left running; until then, keep serving the clients already here.
  let lostLogged = false;
  setInterval(() => {
    if (ownsSocket(paths.socket, identity)) return;
    if (!lostLogged) log('endpoint taken by another daemon; draining');
    lostLogged = true;
    if (host.liveSessions === 0) void host.shutdown().then(() => exit(EXIT_NOT_PUBLISHED));
  }, OWNERSHIP_CHECK_MS).unref();
  const stop = () => void host.shutdown().then(() => exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('uncaughtException', (error) => {
    log(`uncaught: ${error.stack ?? error.message}`);
    // Take the sessions down with us rather than leave them unreachable.
    for (const session of host.sessions.values()) session.kill('SIGKILL');
    exit(1);
  });
}

main().catch((error: Error) => {
  log(`startup failed: ${error.stack ?? error.message}`);
  process.exit(1);
});
