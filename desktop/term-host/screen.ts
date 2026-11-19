import serializeModule from '@xterm/addon-serialize';
import headlessModule, { type Terminal } from '@xterm/headless';
import unicode11Module from '@xterm/addon-unicode11';
import { EscapeTail } from './escape-tail.js';
import { ModeTracker, kittyStackSequence, modeSequences, type TerminalModes } from './modes.js';
import type { ScreenRead, ScreenRestore } from './protocol.js';

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

/** A snapshot larger than this once JSON-encoded keeps less history (frames stop at 16 MB). */
export const SNAPSHOT_BUDGET_BYTES = 8 * 1024 * 1024;
const ALT_SCREEN_SWITCH = '\x1b[?1049h\x1b[H';

// Both packages are CommonJS bundles whose exports Node's ESM loader cannot name statically.
const { SerializeAddon } = serializeModule;
const { Terminal: HeadlessTerminal } = headlessModule;
const { Unicode11Addon } = unicode11Module;

/** One session's headless terminal: what the program has drawn, and in which input modes. */
export class HeadlessScreen {
  private readonly terminal: Terminal;
  private readonly serializer = new SerializeAddon();
  private readonly modeTracker: ModeTracker;
  private readonly tail = new EscapeTail();
  private pendingBytes = 0;
  private disposed = false;
  /** Replies the emulator makes while parsing a chunk no view will see go to the program. */
  private replying = false;
  /** Sequence number of the last chunk the parser has finished. */
  parsedSeq = 0;
  droppedBytes = 0;
  /** The window title the program last set (OSC 0/2). */
  title = '';

  constructor(cols: number, rows: number, scrollback: number, onReply?: (reply: string) => void) {
    this.terminal = new HeadlessTerminal({
      cols,
      rows,
      scrollback,
      allowProposedApi: true,
      logLevel: 'off',
    });
    this.terminal.loadAddon(this.serializer);
    // Same cell widths as the view (TermChrome): emoji and wide text land in the same columns
    // live and in a restored screen.
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.unicode.activeVersion = '11';
    this.modeTracker = new ModeTracker(this.terminal);
    this.terminal.onTitleChange((title) => void (this.title = title));
    // Answers to the program's queries (cursor position, device attributes, ...).
    if (onReply) this.terminal.onData((reply) => this.replying && onReply(reply));
  }

  /**
   * Queues one PTY chunk (numbered `seq`) for the parser. False when shed (see the limit).
   * `answer`, asked as the chunk is parsed: whether the emulator answers its queries itself
   * (no view will see the chunk) or a view does (two answers would reach the program).
   */
  write(data: string | Uint8Array, seq: number, answer?: () => boolean): boolean {
    if (this.disposed) return false;
    const size = data.length;
    if (this.pendingBytes + size > PARSE_BACKLOG_LIMIT) {
      this.droppedBytes += size;
      return false;
    }
    this.pendingBytes += size;
    // xterm runs write callbacks in order, so this opens the window right before the chunk.
    if (answer) this.terminal.write('', () => void (this.replying = answer()));
    this.terminal.write(data, () => {
      this.replying = false;
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
  snapshot(scrollback?: number, budgetBytes = SNAPSHOT_BUDGET_BYTES): ScreenRestore {
    const modes = this.modes();
    let lines = scrollback;
    let snapshot = this.serializer.serialize({ scrollback: lines, excludeModes: true });
    // Very colourful history can encode to more than a frame holds: keep the newest part.
    while (lines !== 0 && encodedSize(snapshot, budgetBytes) > budgetBytes) {
      lines = Math.floor(Math.min(lines ?? Infinity, this.scrollbackLines) / 2);
      snapshot = this.serializer.serialize({ scrollback: lines, excludeModes: true });
    }
    // Even the visible screen alone is too big (a huge window, a colour per cell): send its text
    // without attributes, which is bounded by its size, rather than a frame the client refuses.
    if (encodedSize(snapshot, budgetBytes) > budgetBytes) snapshot = this.plainScreen();
    const normalStack = kittyStackSequence(modes.kittyStacks.normal);
    if (modes.alternateScreen && normalStack) {
      // The normal screen's kitty stack must be pushed while that screen is still active.
      const at = snapshot.indexOf(ALT_SCREEN_SWITCH);
      if (at >= 0) snapshot = snapshot.slice(0, at) + normalStack + snapshot.slice(at);
    }
    return {
      snapshot,
      modes: modeSequences(modes),
      cols: this.terminal.cols,
      rows: this.terminal.rows,
    };
  }

  /**
   * The visible rows as text with their faint ranges, the cursor and the title: what the app's
   * composer reads (see `ScreenRead`). Rows are trimmed on the right as `tmux capture-pane -p`
   * trims them; a wide character's second cell adds nothing.
   */
  read(): ScreenRead {
    const buffer = this.terminal.buffer.active;
    const cell = buffer.getNullCell();
    const lines: string[] = [];
    const faint: [number, number][][] = [];
    for (let y = 0; y < this.terminal.rows; y++) {
      const line = buffer.getLine(buffer.baseY + y);
      let text = '';
      const ranges: [number, number][] = [];
      for (let x = 0; line && x < this.terminal.cols; x++) {
        line.getCell(x, cell);
        if (cell.getWidth() === 0) continue;
        const chars = cell.getChars() || ' ';
        const start = text.length;
        text += chars;
        if (!cell.isDim()) continue;
        const last = ranges.at(-1);
        if (last && last[1] === start) last[1] = text.length;
        else ranges.push([start, text.length]);
      }
      const trimmed = text.replace(/ +$/, '');
      lines.push(trimmed);
      faint.push(
        ranges
          .map(([a, b]): [number, number] => [a, Math.min(b, trimmed.length)])
          .filter(([a, b]) => a < b),
      );
    }
    return {
      lines,
      faint,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      alternate: buffer.type === 'alternate',
      title: this.title,
    };
  }

  private plainScreen() {
    const buffer = this.terminal.buffer.active;
    const rows: string[] = [];
    for (let y = 0; y < this.terminal.rows; y++) {
      rows.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '');
    }
    const alternate = buffer.type === 'alternate' ? '\x1b[?1049h' : '';
    const cursor = `\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`;
    return `${alternate}\x1b[H\x1b[2J${rows.join('\r\n')}${cursor}`;
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

/** Bytes `text` takes as a JSON string; a cheap bound first, the exact size only near `budget`. */
function encodedSize(text: string, budget: number) {
  // At most 6 bytes per UTF-16 unit (\u001b); usually far below the budget.
  if (text.length * 6 <= budget) return text.length;
  return Buffer.byteLength(JSON.stringify(text));
}
