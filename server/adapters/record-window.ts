import { open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  GUARD_BYTES,
  READ_BUDGET_BYTES,
  foldLines,
  headWindowBytes,
  readWindow,
  type RecordWindow,
  type SourceFile,
  type WindowRecord,
} from './files.js';

const VERIFY_MS = 10 * 60_000;
const DEFAULT_BUDGET_BYTES = 32 * 1024 * 1024;

interface Entry {
  dev: number;
  ino: number;
  /** End of the last complete line read; appends resume here. */
  consumedThrough: number;
  /** File size at the last read: any shrink, even of an unfinished tail, is not an append. */
  size: number;
  /** Records within the head window, fixed once the file outgrows the budget. */
  head: WindowRecord[];
  /** End of the last complete line within the head window. */
  headEnd: number;
  /** Every record while the file fits the budget; afterwards the recent window. */
  tail: WindowRecord[];
  /** Index of the first live record in `tail` (a cheap deque). */
  tailFrom: number;
  /** The last bytes before `consumedThrough`, re-read to confirm the prefix is unchanged. */
  guard: Buffer;
  /** The file has outgrown the budget: head/tail windows apply. */
  split: boolean;
  malformed: boolean;
  /** The bytes after `consumedThrough` are an unfinished line. */
  trailing: boolean;
  approxBytes: number;
  lastUsed: number;
  verifiedAt: number;
  /** Took the append path since its last full read, so it relies on the guard alone. */
  appended: boolean;
}

export interface WindowRead {
  records: Record<string, any>[];
  partial: boolean;
  mode: 'append' | 'full';
  /** Set by `verify` only: the full read found other records than the append path had kept. */
  drifted?: boolean;
}

/**
 * Keeps each JSONL file's bounded `readRecords` window in memory and, while the file only
 * grows, reads just the bytes appended since the last complete line. The result is always
 * what `readRecords` would return for the same bytes. Anything that is not a verified append
 * (another file at the path, shrink, rewritten prefix, a stale entry, an entry evicted for the
 * memory budget) goes through the bounded reader again.
 */
export class RecordWindowCache {
  private entries = new Map<string, Entry>();
  /** Appended entries evicted before their full re-verification: path → last full read. */
  private due = new Map<string, number>();
  private total = 0;
  readonly maxBytes: number;
  readonly budgetBytes: number;
  private verifyMs: number;
  private now: () => number;
  constructor(
    opts: { budgetBytes?: number; maxBytes?: number; verifyMs?: number; now?: () => number } = {},
  ) {
    this.budgetBytes = opts.budgetBytes ?? DEFAULT_BUDGET_BYTES;
    this.maxBytes = opts.maxBytes ?? READ_BUDGET_BYTES;
    this.verifyMs = opts.verifyMs ?? VERIFY_MS;
    this.now = opts.now ?? Date.now;
  }
  get size() {
    return this.entries.size;
  }
  get bytes() {
    return this.total;
  }
  has(filePath: string) {
    return this.entries.has(filePath);
  }
  async read(file: SourceFile): Promise<WindowRead> {
    const entry = this.entries.get(file.path);
    if (entry && this.now() - entry.verifiedAt < this.verifyMs) {
      const appended = await this.append(file.path, entry);
      if (appended) return appended;
    }
    return this.full(file.path);
  }
  /**
   * The scheduled full re-verification of a `stale` window. Only this path compares the old
   * window with the fresh read; ordinary fallbacks re-parse anyway and skip that cost.
   */
  async verify(file: SourceFile): Promise<WindowRead> {
    return this.full(file.path, this.entries.get(file.path) ?? null);
  }
  /**
   * Appended windows rely on the guard alone; once their last full read is older than the
   * verification interval they are due for one, even if the file has gone quiet since.
   */
  stale(filePath: string) {
    const entry = this.entries.get(filePath);
    const verifiedAt = entry
      ? entry.appended
        ? entry.verifiedAt
        : undefined
      : this.due.get(filePath);
    return verifiedAt !== undefined && this.now() - verifiedAt >= this.verifyMs;
  }
  /** Drop entries for paths no longer discovered (optionally only those under `root`). */
  prune(keepPaths: Set<string>, root?: string) {
    for (const key of [...this.entries.keys(), ...this.due.keys()])
      if (!keepPaths.has(key) && (!root || isUnder(key, root))) {
        this.drop(key);
        this.due.delete(key);
      }
  }
  private drop(filePath: string) {
    const entry = this.entries.get(filePath);
    if (!entry) return;
    this.total -= entry.approxBytes;
    this.entries.delete(filePath);
  }
  /** `previous` (verify only): the entry to compare with; null when there is none. */
  private async full(filePath: string, previous?: Entry | null): Promise<WindowRead> {
    this.drop(filePath);
    // Evicted before its verification: what it had kept is gone, so report a drift to be safe.
    const evicted = previous === null && this.due.has(filePath);
    this.due.delete(filePath);
    const w = await readWindow(filePath, this.maxBytes);
    if (w.resumable) this.store(filePath, w);
    const records = w.records.map((r) => r.record);
    const read: WindowRead = { records, partial: w.partial, mode: 'full' };
    if (evicted) read.drifted = true;
    else if (previous?.appended)
      read.drifted = !(
        w.partial === (previous.split || previous.malformed || previous.trailing) &&
        isDeepStrictEqual(records, windowRecords(previous))
      );
    return read;
  }
  private store(filePath: string, w: RecordWindow) {
    const split = w.size > this.maxBytes;
    const headSize = headWindowBytes(this.maxBytes);
    const head = split ? w.records.filter((r) => r.end <= headSize) : [];
    const tail = split ? w.records.slice(head.length) : w.records;
    const entry: Entry = {
      dev: w.dev,
      ino: w.ino,
      consumedThrough: w.consumedThrough,
      size: w.size,
      head,
      headEnd: w.headEnd,
      tail,
      tailFrom: 0,
      guard: w.guard,
      split,
      malformed: w.malformed,
      trailing: w.consumedThrough < w.size,
      approxBytes: 0,
      lastUsed: this.now(),
      verifiedAt: this.now(),
      appended: false,
    };
    this.remember(filePath, entry);
  }
  private remember(filePath: string, entry: Entry) {
    this.drop(filePath);
    entry.approxBytes = span(entry.head) + span(entry.tail, entry.tailFrom) + entry.guard.length;
    entry.lastUsed = this.now();
    this.entries.set(filePath, entry);
    this.total += entry.approxBytes;
    // Map order is recency order: evict from the least recently read.
    for (const key of this.entries.keys()) {
      if (this.total <= this.budgetBytes) break;
      const evicted = this.entries.get(key)!;
      if (evicted.appended) this.due.set(key, evicted.verifiedAt);
      this.drop(key);
    }
  }
  private async append(filePath: string, entry: Entry): Promise<WindowRead | null> {
    const fh = await open(filePath, 'r').catch(() => null);
    if (!fh) return null;
    try {
      const { size, dev, ino } = await fh.stat();
      // Shrinking only an unfinished tail keeps size ≥ consumedThrough, but readRecords' tail
      // window would move back over records this entry already dropped.
      if (dev !== entry.dev || ino !== entry.ino || size < entry.size) return null;
      const headSize = headWindowBytes(this.maxBytes);
      // A large jump costs no more through the bounded reader, which reads ≤ maxBytes.
      if (size - entry.consumedThrough > this.maxBytes - headSize) return null;
      // Crossing the budget with no complete line in the head window is the large first
      // metadata record case; only the bounded reader recovers it.
      if (size > this.maxBytes && !entry.split && !entry.headEnd) return null;
      const guard = Buffer.alloc(entry.guard.length);
      if (guard.length) {
        const { bytesRead } = await fh.read(
          guard,
          0,
          guard.length,
          entry.consumedThrough - guard.length,
        );
        if (bytesRead !== guard.length || !guard.equals(entry.guard)) return null;
      }
      const fresh: WindowRecord[] = [];
      let malformed = false;
      let headEnd = entry.headEnd;
      const read = await foldLines(
        range(fh, entry.consumedThrough, size),
        entry.consumedThrough,
        (line, start, end) => {
          if (end <= headSize) headEnd = end;
          if (!line.trim()) return;
          try {
            const value = JSON.parse(line);
            if (value && typeof value === 'object' && !Array.isArray(value))
              fresh.push({ record: value, start, end });
            else malformed = true;
          } catch {
            malformed = true;
          }
        },
      );
      if (read.skippedRecords.length) return null;
      const next: Entry = {
        ...entry,
        consumedThrough: read.consumedThrough,
        size,
        headEnd,
        tail: entry.tail.slice(entry.tailFrom).concat(fresh),
        tailFrom: 0,
        malformed: entry.malformed || malformed,
        trailing: !!read.trailingPartialLine,
        appended: true,
      };
      if (size > this.maxBytes) {
        if (!next.split) {
          // Same cut as readRecords: the head keeps lines that end inside the head window.
          let n = 0;
          while (n < next.tail.length && next.tail[n].end <= headSize) n++;
          next.head = next.tail.slice(0, n);
          next.tail = next.tail.slice(n);
          next.split = true;
        }
        // readRecords' tail drops the line cut by its window start: keep records starting there.
        const tailStart = Math.max(next.headEnd, size - (this.maxBytes - headSize));
        while (next.tailFrom < next.tail.length && next.tail[next.tailFrom].start < tailStart)
          next.tailFrom++;
      }
      if (read.consumedThrough !== entry.consumedThrough) {
        const guardFrom = Math.max(0, read.consumedThrough - GUARD_BYTES);
        next.guard = Buffer.alloc(read.consumedThrough - guardFrom);
        const { bytesRead } = await fh.read(next.guard, 0, next.guard.length, guardFrom);
        if (bytesRead !== next.guard.length) return null;
      }
      this.remember(filePath, next);
      return {
        records: windowRecords(next),
        partial: next.split || next.malformed || next.trailing,
        mode: 'append',
      };
    } finally {
      await fh.close();
    }
  }
}

function windowRecords(entry: Entry) {
  return entry.head.concat(entry.tail.slice(entry.tailFrom)).map((r) => r.record);
}

async function* range(fh: import('node:fs/promises').FileHandle, start: number, end: number) {
  for (let offset = start; offset < end;) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, end - offset));
    const { bytesRead } = await fh.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    offset += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

function span(records: WindowRecord[], from = 0) {
  let bytes = 0;
  for (let i = from; i < records.length; i++) bytes += records[i].end - records[i].start;
  return bytes;
}

function isUnder(file: string, root: string) {
  const rel = file.startsWith(root) ? file.slice(root.length) : null;
  return rel !== null && (rel === '' || rel.startsWith('/') || rel.startsWith('\\'));
}
