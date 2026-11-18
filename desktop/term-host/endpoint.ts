// Endpoint ownership follows the rules in Orca's src/main/daemon/AGENTS.md (MIT,
// github.com/stablyai/orca): bind a private name, claim the public one with link(2), replace an
// incumbent only after proving it dead, and never remove a public name on shutdown.
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { TERM_HOST_PROTOCOL } from './protocol.js';

export interface TermHostPaths {
  /** Private directory (0700) for the token, the log and, normally, the socket. */
  dir: string;
  /** Unix socket path, or a named pipe on Windows. Versioned by protocol. */
  socket: string;
  token: string;
  log: string;
}

/** Unix socket paths are limited (104 bytes on macOS, 108 on Linux, including the NUL). */
const SOCKET_PATH_LIMIT = 100;

/** Where the terminal host of the app whose data lives in `dataDir` listens. */
export function termHostPaths(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.(),
): TermHostPaths {
  const dir = path.join(dataDir, 'term-host');
  const name = `v${TERM_HOST_PROTOCOL}.sock`;
  let socket = path.join(dir, name);
  if (platform === 'win32') {
    // Pipe names are global: keyed by user and data dir so two users or two app copies never meet.
    const key = createHash('sha256')
      .update(`${userName()}\0${path.resolve(dir)}`)
      .digest('hex');
    socket = `\\\\.\\pipe\\agent-office-term-host-v${TERM_HOST_PROTOCOL}-${key.slice(0, 16)}`;
  } else if (Buffer.byteLength(socket) > SOCKET_PATH_LIMIT) {
    // A long data dir: a short private directory under /tmp instead (checked like the real one).
    const key = createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 12);
    socket = path.posix.join(shortSocketRoot(uid), key, name);
  }
  return { dir, socket, token: path.join(dir, 'token'), log: path.join(dir, 'daemon.log') };
}

function shortSocketRoot(uid: number | undefined) {
  return `/tmp/agent-office-term-host-${uid ?? 'user'}`;
}

function userName() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME ?? 'user';
  }
}

/**
 * Creates `dir` (and parents) owned by us with mode 0700, tightening a looser existing one.
 * A directory someone else owns is refused: we must not hand our token to their listener.
 */
export function ensurePrivateDir(dir: string, platform: NodeJS.Platform = process.platform) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform === 'win32') return;
  const info = lstatSync(dir);
  if (!info.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (process.getuid && info.uid !== process.getuid()) {
    throw new Error(`${dir} is owned by another user`);
  }
  if ((info.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** Prepares the directory a socket lives in. The shared /tmp fallback is checked, not repaired. */
export function ensureSocketDir(
  paths: TermHostPaths,
  platform: NodeJS.Platform = process.platform,
) {
  ensurePrivateDir(paths.dir, platform);
  if (platform === 'win32') return;
  const socketDir = path.dirname(paths.socket);
  if (socketDir === paths.dir) return;
  for (const dir of [path.dirname(socketDir), socketDir]) {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = lstatSync(dir);
    const ours = !process.getuid || info.uid === process.getuid();
    if (!info.isDirectory() || !ours || (info.mode & 0o077) !== 0) {
      throw new Error(`${dir} is not a private directory owned by this user`);
    }
  }
}

/**
 * The shared secret every client presents in `hello`. Created once, 0600, by whoever needs it
 * first: written under a private name and linked into place, so a racing reader never sees a
 * half-written file and two creators agree on one token.
 */
export function readOrCreateToken(file: string, platform: NodeJS.Platform = process.platform) {
  const existing = readToken(file, platform);
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  const scratch = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(scratch, 'wx', 0o600);
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(scratch, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Someone else's token stays; a malformed file is replaced in one step.
    if (!readToken(file, platform)) renameSync(scratch, file);
  } finally {
    try {
      unlinkSync(scratch);
    } catch {
      // Our own scratch name; nothing else depends on it.
    }
  }
  const shared = readToken(file, platform);
  if (!shared) throw new Error(`could not read ${file}`);
  return shared;
}

function readToken(file: string, platform: NodeJS.Platform) {
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (platform !== 'win32') {
    const info = lstatSync(file);
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) {
      throw new Error(`${file} is not our token file`);
    }
    if ((info.mode & 0o077) !== 0) chmodSync(file, 0o600);
  }
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

/** `connected` proves a live owner; `missing`/`refused` prove none; `unknown` proves nothing. */
export type ProbeOutcome = 'connected' | 'missing' | 'refused' | 'unknown';

export function probeSocket(socketPath: string, timeoutMs = 500): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    let entryExists = false;
    if (process.platform !== 'win32') {
      try {
        lstatSync(socketPath);
        entryExists = true;
      } catch (error) {
        return resolve((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown');
      }
    }
    const socket = connect({ path: socketPath });
    const settle = (outcome: ProbeOutcome) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => settle('unknown'), timeoutMs);
    socket.once('connect', () => settle('connected'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTSOCK') settle('refused');
      // A dangling entry (e.g. a symlink) occupies the name but cannot serve it.
      else if (error.code === 'ENOENT') settle(entryExists ? 'refused' : 'missing');
      else settle('unknown');
    });
  });
}

/** A private bind name next to the public one: `server.close()` only ever unlinks this. */
export function privateBindPath(socketPath: string) {
  return path.join(path.dirname(socketPath), `.p${randomBytes(5).toString('hex')}`);
}

export type PublishOutcome =
  | { status: 'published'; identity: SocketIdentity | null }
  /** A live daemon owns the name: use it, never start beside it. */
  | { status: 'occupied' }
  /** Another publisher won a race, or the evidence was unclear: stand down. */
  | { status: 'lost' | 'inconclusive' };

export interface SocketIdentity {
  dev: bigint;
  ino: bigint;
}

/**
 * Moves a listening socket from its private `bindPath` to the public `socketPath`.
 *
 * - `link` first: it fails if the name is taken, which forces the question "is anyone there?"
 *   (an unconditional rename would replace a healthy daemon).
 * - Only a probe that is refused or finds nothing proves the incumbent dead; a timeout or a
 *   permission error proves nothing and we decline.
 * - The entry is re-checked by inode after the probe and probed again just before the rename,
 *   so a replacement that appeared meanwhile is not destroyed.
 * - `rename` swaps the name in one step (unlink-then-link would leave a gap clients see).
 * - The departing daemon never removes the public name; the next publisher replaces it.
 *
 * Windows named pipes are exclusive by name and vanish with their process: listening is the
 * whole protocol there, so this is a no-op.
 */
export async function publishSocket(
  bindPath: string,
  socketPath: string,
  probe: (p: string) => Promise<ProbeOutcome> = probeSocket,
): Promise<PublishOutcome> {
  if (process.platform === 'win32') return { status: 'published', identity: null };
  const identity = socketIdentity(bindPath, false);
  if (!identity) throw new Error(`cannot stat ${bindPath}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      linkSync(bindPath, socketPath);
      try {
        unlinkSync(bindPath);
      } catch {
        // The public name serves clients; a leftover private name is harmless.
      }
      return confirm(socketPath, identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const before = socketIdentity(socketPath, true);
    const first = await safeProbe(probe, socketPath);
    if (first === 'connected') return { status: 'occupied' };
    if (first === 'unknown') return { status: 'inconclusive' };
    if (!sameIdentity(before, socketIdentity(socketPath, true))) continue;
    // A replacement could reuse the dead entry's inode: ask once more right before replacing.
    const second = await safeProbe(probe, socketPath);
    if (second === 'connected') return { status: 'occupied' };
    if (second === 'unknown') return { status: 'inconclusive' };
    renameSync(bindPath, socketPath);
    return confirm(socketPath, identity);
  }
  return { status: 'inconclusive' };
}

async function safeProbe(probe: (p: string) => Promise<ProbeOutcome>, socketPath: string) {
  try {
    return await probe(socketPath);
  } catch {
    return 'unknown' as const;
  }
}

/** Still ours? Only a different inode or a missing entry counts as lost; anything else is not. */
export function ownsSocket(socketPath: string, identity: SocketIdentity | null) {
  if (!identity || process.platform === 'win32') return true;
  try {
    return sameIdentity(identity, socketIdentity(socketPath, false, true));
  } catch {
    return true;
  }
}

function confirm(socketPath: string, identity: SocketIdentity): PublishOutcome {
  const published = socketIdentity(socketPath, false);
  return sameIdentity(published, identity) ? { status: 'published', identity } : { status: 'lost' };
}

function socketIdentity(p: string, link: boolean, rethrow = false): SocketIdentity | null {
  try {
    const info = link ? lstatSync(p, { bigint: true }) : statSync(p, { bigint: true });
    return { dev: info.dev, ino: info.ino };
  } catch (error) {
    if (rethrow && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}

function sameIdentity(a: SocketIdentity | null, b: SocketIdentity | null) {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino;
}
