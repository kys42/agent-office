import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { consumeCompleteJsonlLines } from '../../vendor/orca/runtime/session-scanner-jsonl-reader.js';
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from '../../vendor/orca/runtime/session-transcript-record-budget.js';
export interface SourceFile {
  path: string;
  mtime: number;
  size: number;
}
export async function discover(root: string, depth = 5): Promise<SourceFile[]> {
  const result: SourceFile[] = [];
  async function walk(dir: string, d: number) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (dir === root) throw e;
      return;
    }
    for (const ent of entries) {
      const file = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (
        ent.isDirectory() &&
        d > 0 &&
        !['node_modules', '.git', 'archive', 'session-sqlite-import-archive', 'agent'].includes(
          ent.name,
        )
      )
        await walk(file, d - 1);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        try {
          const s = await stat(file);
          result.push({ path: file, mtime: s.mtimeMs, size: s.size });
        } catch {
          /* rotating file */
        }
      }
    }
  }
  await walk(root, depth);
  return result.sort((a, b) => b.mtime - a.mtime);
}
export const READ_BUDGET_BYTES = 3 * 1024 * 1024;
/** Bytes of the bounded head window once a file outgrows the read budget. */
export const headWindowBytes = (maxBytes: number) => Math.min(768 * 1024, Math.floor(maxBytes / 2));
export interface WindowRecord {
  record: Record<string, any>;
  /** Byte offset of the line start and just past its newline. */
  start: number;
  end: number;
}
export interface RecordWindow {
  records: WindowRecord[];
  partial: boolean;
  size: number;
  dev: number;
  ino: number;
  /** End of the last complete line within the head window (`headWindowBytes`). */
  headEnd: number;
  /** End of the last complete line read; the next append starts here. */
  consumedThrough: number;
  /** A complete kept line was unparseable or not an object. */
  malformed: boolean;
  /** Offsets and line boundaries are exact, so appends may resume from `consumedThrough`. */
  resumable: boolean;
}
// Read bounded beginning + end. Preserve complete lines; never parse a half-written tail.
export async function readRecords(
  file: SourceFile,
  maxBytes = READ_BUDGET_BYTES,
): Promise<{ records: Record<string, any>[]; partial: boolean }> {
  const { records, partial } = await readWindow(file.path, maxBytes);
  return { records: records.map((r) => r.record), partial };
}
/** The bounded reader behind `readRecords`, also reporting where each kept record sits. */
export async function readWindow(
  filePath: string,
  maxBytes = READ_BUDGET_BYTES,
): Promise<RecordWindow> {
  const fh = await open(filePath, 'r');
  try {
    // Snapshot the opened file, not the earlier directory entry (rotation/append).
    const { size, dev, ino } = await fh.stat();
    const records: WindowRecord[] = [];
    let partial = size > maxBytes;
    let malformed = false;
    let resumable = true;
    const window = (consumedThrough: number, headEnd: number): RecordWindow => ({
      records,
      partial,
      size,
      dev,
      ino,
      headEnd,
      consumedThrough,
      malformed,
      resumable,
    });
    if (!size) return window(0, 0);
    const parseLine = (line: string, start: number, end: number) => {
      if (!line.trim()) return;
      try {
        const value = JSON.parse(line);
        if (value && typeof value === 'object' && !Array.isArray(value))
          records.push({ record: value, start, end });
        else partial = malformed = true;
      } catch {
        partial = malformed = true;
      }
    };
    // Own the descriptor here. Breaking a Node ReadStream iterator destroys it,
    // even with autoClose:false, which would close the handle before the tail read.
    async function* range(start: number, end: number) {
      for (let offset = start; offset < end;) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, end - offset));
        const { bytesRead } = await fh.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    }
    const headSize = partial ? headWindowBytes(maxBytes) : size;
    const fold = (
      start: number,
      end: number,
      onLine: (line: string, lineStart: number, lineEnd: number) => void = parseLine,
      shouldStop?: () => boolean,
    ) => foldLines(range(start, end), start, onLine, shouldStop);
    let headEnd = 0;
    let head = await fold(0, headSize, (line, start, end) => {
      if (end <= headWindowBytes(maxBytes)) headEnd = end;
      parseLine(line, start, end);
    });
    // Instructions can make the first metadata record larger than the head window.
    // Recover that ONE record up to Orca's 10 MiB record budget; never substitute
    // the transport filename for a known-but-truncated native identity.
    if (!head.consumedThrough && size > headSize) {
      let firstLineRead = false;
      resumable = false;
      head = await fold(
        0,
        Math.min(size, MAX_SESSION_TRANSCRIPT_RECORD_BYTES + 64 * 1024),
        (line, start, end) => {
          parseLine(line, start, end);
          firstLineRead = true;
        },
        () => firstLineRead,
      );
    }
    partial ||= !!head.trailingPartialLine || head.skippedRecords.length > 0;
    if (head.skippedRecords.length) resumable = false;
    let consumedThrough = head.consumedThrough;
    if (size > head.consumedThrough && size > maxBytes) {
      const start = Math.max(head.consumedThrough, size - (maxBytes - headSize));
      // Drop only a genuinely partial leading line, including UTF-8 boundary splits.
      const prev = Buffer.alloc(1);
      if (start) await fh.read(prev, 0, 1, start - 1);
      let skip = start > 0 && prev[0] !== 10;
      const tail = await fold(start, size, (line, lineStart, lineEnd) => {
        if (skip) {
          skip = false;
          return;
        }
        parseLine(line, lineStart, lineEnd);
      });
      partial ||= !!tail.trailingPartialLine || tail.skippedRecords.length > 0;
      // Still inside the dropped leading line: no line boundary to resume from.
      if (skip || tail.skippedRecords.length) resumable = false;
      consumedThrough = tail.consumedThrough;
    }
    return window(consumedThrough, headEnd);
  } finally {
    await fh.close();
  }
}
/**
 * Orca's byte fold plus each line's byte span. Every line ends in the chunk the fold is
 * currently splitting, so the span is the next newline at or after the running cursor.
 * Spans are exact only while no oversized record is skipped (callers check `skippedRecords`).
 */
export function foldLines(
  chunks: AsyncIterable<Buffer>,
  start: number,
  onLine: (line: string, lineStart: number, lineEnd: number) => void,
  shouldStop?: () => boolean,
) {
  let chunk: Buffer = Buffer.alloc(0);
  let chunkStart = start;
  let next = start;
  let cursor = start;
  async function* tap() {
    for await (const c of chunks) {
      chunk = c;
      chunkStart = next;
      next += c.length;
      yield c;
    }
  }
  return consumeCompleteJsonlLines({
    stream: tap(),
    start,
    onLine: (line) => {
      const lineStart = cursor;
      cursor = chunkStart + chunk.indexOf(10, Math.max(0, cursor - chunkStart)) + 1;
      onLine(line, lineStart, cursor);
    },
    shouldStop,
  });
}
