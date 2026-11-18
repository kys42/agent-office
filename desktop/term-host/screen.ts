import serializeModule from '@xterm/addon-serialize';
import headlessModule, { type Terminal } from '@xterm/headless';
import { EscapeTail } from './escape-tail.js';
import { ModeTracker, modeSequences, type TerminalModes } from './modes.js';
import type { ScreenRestore } from './protocol.js';

/**
 * Output waiting for the parser beyond this is not fed to the emulator. xterm parses
 * asynchronously and throws once 50 MB are pending; PTY reads are never paused (a full kernel
 * buffer would freeze the program), so a flood faster than parsing must be shed here instead.
 * The screen is then stale until the program redraws; the bytes are still forwarded live.
 */
export const PARSE_BACKLOG_LIMIT = 32 * 1024 * 1024;

/**
 * Bytes per cell held by a buffer line (xterm stores three 32-bit words per cell; allocation
 * slack measured to ~14) and per line of bookkeeping. Measured on @xterm/headless 6 at 200
 * columns: 1,050 lines held ~3.05 MB of array buffers and ~0.64 MB of heap.
 */
const CELL_BYTES = 14;
const LINE_BYTES = 640;

// Both packages are CommonJS bundles whose exports Node's ESM loader cannot name statically.
const { SerializeAddon } = serializeModule;
const { Terminal: HeadlessTerminal } = headlessModule;

/** One session's headless terminal: what the program has drawn, and in which input modes. */
export class HeadlessScreen {
  private readonly terminal: Terminal;
  private readonly serializer = new SerializeAddon();
  private readonly modeTracker: ModeTracker;
  private readonly tail = new EscapeTail();
  private pendingBytes = 0;
  private disposed = false;
  /** Sequence number of the last chunk the parser has finished. */
  parsedSeq = 0;
  droppedBytes = 0;

  constructor(cols: number, rows: number, scrollback: number) {
    this.terminal = new HeadlessTerminal({
      cols,
      rows,
      scrollback,
      allowProposedApi: true,
      logLevel: 'off',
    });
    this.terminal.loadAddon(this.serializer);
    this.modeTracker = new ModeTracker(this.terminal);
  }

  /** Queues one PTY chunk (numbered `seq`) for the parser. False when shed (see the limit). */
  write(data: string | Uint8Array, seq: number): boolean {
    if (this.disposed) return false;
    const size = data.length;
    if (this.pendingBytes + size > PARSE_BACKLOG_LIMIT) {
      this.droppedBytes += size;
      return false;
    }
    this.pendingBytes += size;
    this.terminal.write(data, () => {
      this.pendingBytes -= size;
      this.parsedSeq = seq;
      // In parse order, so the tail matches the screen a snapshot taken now would show.
      if (typeof data !== 'string') this.tail.push(data);
    });
    return true;
  }

  /** Runs `callback` once everything written so far is parsed: the screen then matches it. */
  whenParsed(callback: () => void) {
    if (this.disposed) return void queueMicrotask(callback);
    this.terminal.write('', callback);
  }

  modes(): TerminalModes {
    return this.modeTracker.read();
  }

  /**
   * The screen as ANSI plus the modes to restore after it. `scrollback` limits history lines
   * (0: the visible screen only, about 8 KB at 200×50); all held lines when omitted.
   * See `pendingTail` for what must follow it.
   */
  snapshot(scrollback?: number): ScreenRestore {
    const snapshot = this.serializer.serialize({ scrollback, excludeModes: true });
    return {
      snapshot,
      modes: modeSequences(this.modes()),
      cols: this.terminal.cols,
      rows: this.terminal.rows,
    };
  }

  /** The unfinished sequence the stream is in (see EscapeTail); goes after a snapshot. */
  pendingTail(): Buffer {
    return this.tail.pending();
  }

  resize(cols: number, rows: number) {
    if (this.disposed) return;
    if (cols === this.terminal.cols && rows === this.terminal.rows) return;
    this.terminal.resize(cols, rows);
  }

  get size() {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  get scrollbackLines() {
    if (this.disposed) return 0;
    return Math.max(0, this.terminal.buffer.normal.length - this.terminal.rows);
  }

  /** Estimated memory of the buffers (the alternate screen counted while it is shown). */
  get approxBytes() {
    if (this.disposed) return 0;
    const lines =
      this.terminal.buffer.normal.length +
      (this.terminal.buffer.active.type === 'alternate' ? this.terminal.rows : 0);
    return lines * (this.terminal.cols * CELL_BYTES + LINE_BYTES);
  }

  /** Frees the buffers. Cleared first: that releases the line arrays without waiting on GC. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.reset();
    this.terminal.dispose();
  }
}
