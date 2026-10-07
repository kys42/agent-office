import { open } from 'node:fs/promises';
import {
  READ_BUDGET_BYTES,
  foldLines,
  headWindowBytes,
  readWindow,
  type RecordWindow,
  type SourceFile,
  type WindowRecord,
} from './files.js';

const GUARD_BYTES = 64;
const VERIFY_MS = 10 * 60_000;
const DEFAULT_BUDGET_BYTES = 32 * 1024 * 1024;

interface Entry {
  dev: number;
  ino: number;
  /** End of the last complete line read; appends resume here. */
  consumedThrough: number;
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
}

export interface WindowRead {
  records: Record<string, any>[];
  partial: boolean;
  mode: 'append' | 'full';
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
  /** Drop entries for paths no longer discovered (optionally only those under `root`). */
  prune(keepPaths: Set<string>, root?: string) {
    for (const key of [...this.entries.keys()])
      if (!keepPaths.has(key) && (!root || isUnder(key, root))) this.drop(key);
  }
  private drop(filePath: string) {
    const entry = this.entries.get(filePath);
    if (!entry) return;
    this.total -= entry.approxBytes;
    this.entries.delete(filePath);
  }
  private async full(filePath: string): Promise<WindowRead> {
    this.drop(filePath);
    const w = await readWindow(filePath, this.maxBytes);
    if (w.resumable) await this.store(filePath, w);
    return { records: w.records.map((r) => r.record), partial: w.partial, mode: 'full' };
  }
  private async store(filePath: string, w: RecordWindow) {
    // Reopens the path, so it also confirms the window still describes the same file.
    const guard = await readGuard(filePath, w);
    if (!guard) return;
    const split = w.size > this.maxBytes;
    const headSize = headWindowBytes(this.maxBytes);
    const head = split ? w.records.filter((r) => r.end <= headSize) : [];
    const tail = split ? w.records.slice(head.length) : w.records;
    const entry: Entry = {
      dev: w.dev,
      ino: w.ino,
      consumedThrough: w.consumedThrough,
      head,
      headEnd: w.headEnd,
      tail,
      tailFrom: 0,
      guard,
      split,
      malformed: w.malformed,
      trailing: w.consumedThrough < w.size,
      approxBytes: 0,
      lastUsed: this.now(),
      verifiedAt: this.now(),
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
      this.drop(key);
    }
  }
  private async append(filePath: string, entry: Entry): Promise<WindowRead | null> {
    const fh = await open(filePath, 'r').catch(() => null);
    if (!fh) return null;
    try {
      const { size, dev, ino } = await fh.stat();
      if (dev !== entry.dev || ino !== entry.ino || size < entry.consumedThrough) return null;
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
        headEnd,
        tail: entry.tail.slice(entry.tailFrom).concat(fresh),
        tailFrom: 0,
        malformed: entry.malformed || malformed,
        trailing: !!read.trailingPartialLine,
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
        records: next.head.concat(next.tail.slice(next.tailFrom)).map((r) => r.record),
        partial: next.split || next.malformed || next.trailing,
        mode: 'append',
      };
    } finally {
      await fh.close();
    }
  }
}

async function readGuard(filePath: string, w: RecordWindow) {
  const from = Math.max(0, w.consumedThrough - GUARD_BYTES);
  const guard = Buffer.alloc(w.consumedThrough - from);
  try {
    const fh = await open(filePath, 'r');
    try {
      const { dev, ino } = await fh.stat();
      if (dev !== w.dev || ino !== w.ino) return null;
      if (!guard.length) return guard;
      const { bytesRead } = await fh.read(guard, 0, guard.length, from);
      return bytesRead === guard.length ? guard : null;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
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
