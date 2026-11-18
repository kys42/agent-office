import { HeadlessScreen } from './screen.js';
import type { ExitInfo, ScreenRestore, SessionSpec, SessionStats } from './protocol.js';

/** The part of node-pty a session uses (a fake in tests). */
export interface PtyProcess {
  readonly pid: number;
  onData(callback: (data: string | Uint8Array) => void): unknown;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type SpawnPty = (
  file: string,
  args: string[],
  options: {
    name: string;
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
  },
) => PtyProcess;

/** Sends a signal to a whole process group (a fake in tests). */
export type KillGroup = (pid: number, signal: NodeJS.Signals) => void;

export interface SessionTiming {
  killGraceMs: number;
  syncWaitMs: number;
  maxLagBytes: number;
}

/** What a session tells its host about. */
export interface SessionEvents {
  /** New output was queued on `attachment` (schedule a flush). */
  queued(attachment: Attachment): void;
  /** `attachment` fell too far behind; its queue was dropped and it needs a fresh snapshot. */
  lagged(attachment: Attachment): void;
  /** The program ended and the emulator is freed. */
  exited(session: Session): void;
}

/**
 * One client's view of one session. Output is queued per attachment, numbered by the session's
 * chunk sequence, so a snapshot taken at chunk N drops exactly the queued chunks it contains.
 */
export class Attachment {
  /** `capturing`: waiting for a snapshot; `live`: forwarding; `lagged`: needs a snapshot. */
  state: 'capturing' | 'live' | 'lagged' = 'capturing';
  /** No screen has reached the client yet (its attach answer is still being prepared). */
  initial = true;
  queue: { seq: number; data: Buffer }[] = [];
  queuedBytes = 0;
  constructor(
    readonly session: Session,
    readonly owner: object,
  ) {}

  /** Removes and returns the queued output as one buffer. */
  drain(): Buffer | null {
    if (this.queue.length === 0) return null;
    const data =
      this.queue.length === 1 ? this.queue[0].data : Buffer.concat(this.queue.map((q) => q.data));
    this.queue = [];
    this.queuedBytes = 0;
    return data;
  }

  dropThrough(seq: number) {
    while (this.queue.length > 0 && this.queue[0].seq <= seq) {
      this.queuedBytes -= this.queue.shift()!.data.length;
    }
  }
}

/** A program on a PTY, its headless screen, and who is watching it. */
export class Session {
  readonly createdAt = Date.now();
  readonly attachments = new Set<Attachment>();
  private screen: HeadlessScreen | null;
  /** The last screen, kept after the emulator is freed so a late attach still sees it. */
  private finalRestore: ScreenRestore | null = null;
  private finalWaiters: (() => void)[] = [];
  private seq = 0;
  private killTimer: NodeJS.Timeout | null = null;
  private killing = false;
  exit: ExitInfo | null = null;
  bytesIn = 0;
  bytesOut = 0;
  bytesWritten = 0;
  /** Kept from the emulator when it is freed. */
  private droppedBytes = 0;

  constructor(
    readonly id: string,
    readonly spec: Required<Pick<SessionSpec, 'argv' | 'cwd' | 'cols' | 'rows' | 'scrollback'>>,
    private readonly pty: PtyProcess,
    private readonly events: SessionEvents,
    private readonly timing: SessionTiming,
    private readonly killGroup: KillGroup | null,
  ) {
    this.screen = new HeadlessScreen(spec.cols, spec.rows, spec.scrollback, (reply) => {
      if (this.live) this.pty.write(reply);
    });
    pty.onData((data) => this.onOutput(data));
    pty.onExit((event) => this.onExit(event));
  }

  get live() {
    return this.exit === null;
  }

  /**
   * Every chunk goes to the emulator; attached views get it queued as well. Nothing here ever
   * pauses the PTY: with no view attached the output is only parsed, never held.
   */
  private onOutput(data: string | Uint8Array) {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    this.bytesIn += bytes.length;
    const seq = ++this.seq;
    let viewed = false;
    for (const attachment of this.attachments) {
      if (attachment.state === 'lagged') continue;
      attachment.queue.push({ seq, data: bytes });
      attachment.queuedBytes += bytes.length;
      if (attachment.queuedBytes > this.timing.maxLagBytes) {
        attachment.state = 'lagged';
        attachment.queue = [];
        attachment.queuedBytes = 0;
        this.events.lagged(attachment);
      } else {
        viewed = true;
        this.events.queued(attachment);
      }
    }
    // A query in output no view will see is answered by the emulator, or the program may wait
    // for it forever; a view that gets the chunk answers it instead (never both).
    this.screen?.write(bytes, seq, !viewed);
  }

  private onExit(event: { exitCode: number; signal?: number }) {
    if (this.exit) return;
    this.exit = {
      code: event.signal && !event.exitCode ? null : event.exitCode,
      signal: event.signal || null,
      at: Date.now(),
    };
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
    // A kill sweeps the whole group: helpers the program left in it must not outlive it.
    if (this.killing) this.signalGroup('SIGKILL');
    // Let output that raced the exit reach the parser, keep the last screen, then free it.
    setTimeout(() => {
      const screen = this.screen;
      if (!screen) return;
      screen.whenParsed(() => {
        this.finalRestore = screen.snapshot(0);
        this.droppedBytes = screen.droppedBytes;
        screen.dispose();
        this.screen = null;
        this.events.exited(this);
        for (const waiter of this.finalWaiters.splice(0)) waiter();
      });
    }, 20);
  }

  /**
   * Snapshot for `attachment`, aligned with its queue: taken once everything before the request
   * is parsed, then queued chunks the snapshot already shows are dropped. A program in the middle
   * of a synchronized update (mode 2026) is given up to `syncWaitMs` to finish its frame, so the
   * view does not open on half of one.
   */
  capture(
    attachment: Attachment,
    scrollback: number | undefined,
    done: (r: ScreenRestore) => void,
  ) {
    attachment.state = 'capturing';
    const deadline = Date.now() + this.timing.syncWaitMs;
    const take = () => {
      const screen = this.screen;
      if (!screen) return done(this.lastScreen());
      if (screen.modes().synchronizedOutput && Date.now() < deadline) {
        setTimeout(() => (this.screen ? this.screen.whenParsed(take) : take()), 5);
        return;
      }
      const restore = screen.snapshot(scrollback);
      attachment.dropThrough(screen.parsedSeq);
      // Half a sequence at the snapshot point goes first, so the next chunk completes it.
      const tail = screen.pendingTail();
      if (tail.length > 0 && attachment.state !== 'lagged') {
        attachment.queue.unshift({ seq: screen.parsedSeq, data: tail });
        attachment.queuedBytes += tail.length;
      }
      done(restore);
    };
    if (this.screen) this.screen.whenParsed(take);
    else queueMicrotask(take);
  }

  /** Runs `callback` once an ended session's last screen is kept (at once if it already is). */
  afterFinal(callback: () => void) {
    if (this.screen) this.finalWaiters.push(callback);
    else queueMicrotask(callback);
  }

  /** The screen of a session that has ended (empty until the emulator has been read). */
  lastScreen(): ScreenRestore {
    return (
      this.finalRestore ?? { snapshot: '', modes: '', cols: this.spec.cols, rows: this.spec.rows }
    );
  }

  write(data: Buffer) {
    if (!this.live) return false;
    this.bytesWritten += data.length;
    this.pty.write(data);
    return true;
  }

  resize(cols: number, rows: number) {
    if (!this.live) return false;
    this.spec.cols = cols;
    this.spec.rows = rows;
    this.pty.resize(cols, rows);
    this.screen?.resize(cols, rows);
    return true;
  }

  /**
   * Ends the program and everything in its process group (node-pty makes the child a session
   * and group leader). Escalates to SIGKILL after the grace period; also sweeps the group with
   * SIGKILL once the leader has exited, so nothing it started in the group is left behind.
   */
  kill(signal: NodeJS.Signals = 'SIGHUP') {
    if (!this.live) return false;
    this.killing = true;
    this.signalGroup(signal);
    if (!this.killTimer && signal !== 'SIGKILL') {
      this.killTimer = setTimeout(() => {
        this.killTimer = null;
        if (this.live) this.signalGroup('SIGKILL');
      }, this.timing.killGraceMs).unref();
    }
    return true;
  }

  private signalGroup(signal: NodeJS.Signals) {
    if (this.killGroup) {
      try {
        this.killGroup(this.pty.pid, signal);
        return;
      } catch {
        // Gone already, or not a group leader: fall back to the process itself.
      }
    }
    if (!this.live) return;
    try {
      this.pty.kill(this.killGroup ? signal : undefined);
    } catch {
      // Already exited.
    }
  }

  stats(): SessionStats {
    const screen = this.screen;
    return {
      id: this.id,
      pid: this.pty.pid,
      argv: this.spec.argv,
      cwd: this.spec.cwd,
      cols: this.spec.cols,
      rows: this.spec.rows,
      createdAt: this.createdAt,
      scrollbackLines: screen?.scrollbackLines ?? 0,
      approxBytes: screen?.approxBytes ?? 0,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      bytesWritten: this.bytesWritten,
      droppedBytes: screen?.droppedBytes ?? this.droppedBytes,
      attached: this.attachments.size,
      ...(this.exit ? { exit: this.exit } : {}),
    };
  }
}
