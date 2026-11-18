/**
 * The terminal host's wire protocol: what the app's main process and the detached daemon say to
 * each other over one per-user socket.
 *
 * Framing: `[kind u8][body length u32 BE][body]`.
 * - kind 1 (JSON): a UTF-8 JSON control message (requests, responses, events).
 * - kind 2 (DATA): `[session id length u8][session id UTF-8][raw bytes]`. PTY output from the
 *   daemon and keyboard input from the app.
 *
 * Why not NDJSON for data: terminal output is escape-heavy and JSON spells every ESC as
 * `\u001b` (six bytes), and base64 adds a third and costs an encode and a decode per chunk. A
 * length prefix carries arbitrary bytes as they are, needs no scanning for a delimiter, and lets
 * the reader refuse an oversized frame from its header before buffering the body.
 */

/** Bumped on any incompatible change; it also names the socket so old and new daemons coexist. */
export const TERM_HOST_PROTOCOL = 1;

export const FRAME_JSON = 1;
export const FRAME_DATA = 2;
const HEADER_BYTES = 5;
/** Largest frame after `hello`. Output is batched well below this; snapshots fit with room. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** Largest frame before `hello` succeeds: an unauthenticated peer cannot make us buffer much. */
export const MAX_HELLO_FRAME_BYTES = 4096;

/** Ids the daemon accepts for sessions: short, printable, and safe to put in a file name. */
export const SESSION_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export interface SessionSpec {
  /** Chosen by the caller (unique among live and retained sessions); generated when omitted. */
  id?: string;
  /** Program and arguments, run directly (no shell unless argv names one). */
  argv: string[];
  cwd: string;
  /** The full child environment. Omitted: the daemon's own, minus Electron's run-as-node flag. */
  env?: Record<string, string>;
  cols: number;
  rows: number;
  /** Lines of history kept in memory for this session (the daemon's default when omitted). */
  scrollback?: number;
}

export interface ExitInfo {
  /** Null when the process was ended by a signal and the platform reports no code. */
  code: number | null;
  signal: number | null;
  /** Epoch ms. */
  at: number;
}

export interface SessionStats {
  id: string;
  pid: number;
  argv: string[];
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  /** Lines of history currently held (not counting the visible screen). */
  scrollbackLines: number;
  /** Estimated memory held by the headless terminal buffer. 0 once the session has exited. */
  approxBytes: number;
  /** Bytes read from the PTY (the program's output). */
  bytesIn: number;
  /** Bytes of output forwarded to attached clients. */
  bytesOut: number;
  /** Bytes typed into the PTY. */
  bytesWritten: number;
  /** Output the emulator skipped because its parse backlog was full (should stay 0). */
  droppedBytes: number;
  attached: number;
  exit?: ExitInfo;
}

export interface HostTotals {
  sessions: number;
  live: number;
  clients: number;
  scrollbackLines: number;
  approxBytes: number;
  bytesIn: number;
  bytesOut: number;
  /** The daemon process as a whole. */
  rss: number;
  heapUsed: number;
  arrayBuffers: number;
}

export interface ListResult {
  daemon: { pid: number; protocol: number; startedAt: number };
  sessions: SessionStats[];
  total: HostTotals;
}

export interface ScreenRestore {
  /** The serialized screen (and history, unless limited), as ANSI. */
  snapshot: string;
  /** DEC private modes and keyboard state to apply after `snapshot` (see `restoreSequence`). */
  modes: string;
  cols: number;
  rows: number;
}

export interface AttachResult extends ScreenRestore {
  session: SessionStats;
  /** Set when the session has already ended: `snapshot` is then its last screen. */
  exit?: ExitInfo;
}

export type Request =
  | { op: 'hello'; protocol: number; token: string; client?: string }
  | { op: 'create'; spec: SessionSpec }
  | { op: 'list' }
  /** `scrollback`: lines of history to include (all held lines when omitted). */
  | { op: 'attach'; sessionId: string; scrollback?: number }
  | { op: 'detach'; sessionId: string }
  | { op: 'resize'; sessionId: string; cols: number; rows: number }
  | { op: 'kill'; sessionId: string; signal?: string }
  /** Ends every session and stops the daemon. */
  | { op: 'shutdown' };

export type RequestMessage = Request & { t: 'req'; id: number };

export type ErrorCode =
  | 'bad-request'
  | 'version'
  | 'auth'
  | 'unknown-session'
  | 'exists'
  | 'exited'
  | 'spawn-failed'
  | 'unavailable'
  | 'limit'
  | 'closed';

export type ResponseMessage =
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: { code: ErrorCode; message: string } };

export type EventMessage =
  | { t: 'ev'; ev: 'exit'; sessionId: string; exit: ExitInfo }
  /** Sent instead of output a slow client fell too far behind on: replace the screen with this. */
  | ({ t: 'ev'; ev: 'snapshot'; sessionId: string; reason: 'resync' } & ScreenRestore);

export type Frame =
  { kind: 'json'; message: unknown } | { kind: 'data'; sessionId: string; data: Buffer };

export class FrameError extends Error {}

/** What a fresh xterm should be fed to show a restored screen: drawn in one synchronized update. */
export function restoreSequence(restore: Pick<ScreenRestore, 'snapshot' | 'modes'>): string {
  return `\x1b[?2026h${restore.snapshot}${restore.modes}\x1b[?2026l`;
}

export function encodeJson(message: unknown): Buffer {
  const json = JSON.stringify(message);
  const length = Buffer.byteLength(json, 'utf8');
  const frame = Buffer.allocUnsafe(HEADER_BYTES + length);
  frame[0] = FRAME_JSON;
  frame.writeUInt32BE(length, 1);
  frame.write(json, HEADER_BYTES, 'utf8');
  return frame;
}

export function encodeData(sessionId: string, data: Uint8Array | string): Buffer {
  const id = Buffer.from(sessionId, 'utf8');
  if (id.length === 0 || id.length > 255) throw new FrameError('session id length');
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = 1 + id.length + bytes.length;
  const frame = Buffer.allocUnsafe(HEADER_BYTES + length);
  frame[0] = FRAME_DATA;
  frame.writeUInt32BE(length, 1);
  frame[HEADER_BYTES] = id.length;
  id.copy(frame, HEADER_BYTES + 1);
  frame.set(bytes, HEADER_BYTES + 1 + id.length);
  return frame;
}

/**
 * Incremental reader: feed socket chunks, get whole frames. Chunks are kept as a list and only
 * copied when a frame straddles them. An unknown kind, an oversized length or unparsable JSON
 * throws: the stream can no longer be trusted, so the caller closes the connection.
 */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private size = 0;
  private kind = 0;
  private need = -1;
  constructor(public maxFrameBytes = MAX_FRAME_BYTES) {}

  push(chunk: Buffer): Frame[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
    const frames: Frame[] = [];
    for (;;) {
      if (this.need < 0) {
        if (this.size < HEADER_BYTES) break;
        const head = this.take(HEADER_BYTES);
        const kind = head[0];
        const length = head.readUInt32BE(1);
        if (kind !== FRAME_JSON && kind !== FRAME_DATA) throw new FrameError(`frame kind ${kind}`);
        if (length > this.maxFrameBytes) throw new FrameError(`frame of ${length} bytes`);
        this.kind = kind;
        this.need = length;
      }
      if (this.size < this.need) break;
      const body = this.take(this.need);
      this.need = -1;
      frames.push(decodeBody(this.kind, body));
    }
    return frames;
  }

  /** Bytes received but not yet returned as a frame. */
  get buffered() {
    return this.size;
  }

  private take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    const first = this.chunks[0];
    if (first.length >= n) {
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.size -= n;
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[0];
      const count = Math.min(chunk.length, n - offset);
      chunk.copy(out, offset, 0, count);
      offset += count;
      if (count === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(count);
    }
    this.size -= n;
    return out;
  }
}

function decodeBody(kind: number, body: Buffer): Frame {
  if (kind === FRAME_JSON) {
    try {
      return { kind: 'json', message: JSON.parse(body.toString('utf8')) };
    } catch {
      throw new FrameError('unparsable JSON frame');
    }
  }
  const idLength = body[0] ?? 0;
  if (idLength === 0 || body.length < 1 + idLength) throw new FrameError('malformed data frame');
  return {
    kind: 'data',
    sessionId: body.toString('utf8', 1, 1 + idLength),
    data: body.subarray(1 + idLength),
  };
}
