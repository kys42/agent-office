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
// Read bounded beginning + end. Preserve complete lines; never parse a half-written tail.
export async function readRecords(
  file: SourceFile,
  maxBytes = 3 * 1024 * 1024,
): Promise<{ records: Record<string, any>[]; partial: boolean }> {
  const fh = await open(file.path, 'r');
  try {
    // Snapshot the opened file, not the earlier directory entry (rotation/append).
    const { size } = await fh.stat();
    const records: Record<string, any>[] = [];
    let partial = size > maxBytes;
    if (!size) return { records, partial: false };
    const parseLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const value = JSON.parse(line);
        if (value && typeof value === 'object' && !Array.isArray(value)) records.push(value);
        else partial = true;
      } catch {
        partial = true;
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
    const fold = (start: number, end: number, onLine = parseLine, shouldStop?: () => boolean) =>
      consumeCompleteJsonlLines({
        stream: range(start, end),
        start,
        onLine,
        shouldStop,
      });
    const headSize = partial ? Math.min(768 * 1024, Math.floor(maxBytes / 2)) : size;
    let head = await fold(0, headSize);
    // Instructions can make the first metadata record larger than the head window.
    // Recover that ONE record up to Orca's 10 MiB record budget; never substitute
    // the transport filename for a known-but-truncated native identity.
    if (!head.consumedThrough && size > headSize) {
      let firstLineRead = false;
      head = await fold(
        0,
        Math.min(size, MAX_SESSION_TRANSCRIPT_RECORD_BYTES + 64 * 1024),
        (line) => {
          parseLine(line);
          firstLineRead = true;
        },
        () => firstLineRead,
      );
    }
    partial ||= !!head.trailingPartialLine || head.skippedRecords.length > 0;
    if (size > head.consumedThrough && size > maxBytes) {
      const start = Math.max(head.consumedThrough, size - (maxBytes - headSize));
      // Drop only a genuinely partial leading line, including UTF-8 boundary splits.
      const prev = Buffer.alloc(1);
      if (start) await fh.read(prev, 0, 1, start - 1);
      let skip = start > 0 && prev[0] !== 10;
      const tail = await fold(start, size, (line) => {
        if (skip) {
          skip = false;
          return;
        }
        parseLine(line);
      });
      partial ||= !!tail.trailingPartialLine || tail.skippedRecords.length > 0;
    }
    return { records, partial };
  } finally {
    await fh.close();
  }
}
