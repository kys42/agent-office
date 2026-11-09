import { statSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  OutputPreview,
  OutputVia,
  Provider,
  Session,
  SessionOutput,
} from '../src/shared/types.js';
import {
  OUTPUT_KEEP,
  OUTPUT_PREVIEW_BYTES,
  extensionOf,
  previewFormat,
} from '../src/shared/outputs.js';
import { hash, redact } from './adapters/normalize.js';

// The outputs sessions made (#350), kept per session in the office's own database. The adapters
// name candidates in each parse of a record (server/adapters/outputs.ts); this keeps what they
// found across record windows and restarts. Only paths the records named are ever looked at: a
// mention is checked with one stat (was the file born during the conversation?), a list stats
// the rows it shows, and a file is read only for the reader window, on the person's click.

export const OUTPUTS_SCHEMA = `CREATE TABLE IF NOT EXISTS session_outputs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, key TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(session_id,key)); CREATE INDEX IF NOT EXISTS session_outputs_created ON session_outputs(created_at);`;

/** One recorded output as stored: the real path (never shown as is) and whose it was. */
export interface StoredOutput {
  id: string;
  sessionId: string;
  /** The absolute path, or the link. */
  key: string;
  kind: 'file' | 'link';
  via: OutputVia;
  createdAt: number;
  /** A link's own name in the reply. */
  title?: string;
  source: { provider: Provider; project: string; title: string; alias: string };
}

/** When a file came into being (ms), or null when it is not a file there now. NaN: unknown. */
export type FileBirth = (file: string) => number | null;
export const fileBirth: FileBirth = (file) => {
  try {
    const s = statSync(file);
    if (!s.isFile()) return null;
    return s.birthtimeMs > 0 ? s.birthtimeMs : NaN;
  } catch {
    return null;
  }
};
/** Clock and turn slack around a conversation for a mentioned file's birth. */
const GRACE_MS = 2 * 60_000;
/** Mentions found not to be outputs, remembered so a busy session isn't stat'ed again. */
const REJECTED_MAX = 5000;

/** Whether a file is there now, as a list shows it. */
export function fileExists(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** A stored output as the screens get it: redacted, and never the real path itself. */
export function shownOutput(o: StoredOutput, exists?: boolean): SessionOutput {
  const file = o.kind === 'file';
  const shown = redact(o.key, 4096);
  return {
    id: o.id,
    sessionId: o.sessionId,
    kind: o.kind,
    via: o.via,
    name: file ? path.basename(shown) : redact(o.title || 'Claude Artifact', 200),
    dir: file ? path.dirname(shown) : '',
    path: shown,
    ext: file ? extensionOf(o.key) : '',
    createdAt: o.createdAt,
    source: o.source,
    ...(file && exists !== undefined ? { exists } : {}),
  };
}

/** Recorded outputs on the office's database (the store owns the connection and transactions). */
export class OutputLog {
  private rejected = new Set<string>();
  constructor(
    private db: DatabaseSync,
    private birth: FileBirth = fileBirth,
  ) {}
  /**
   * Keeps the outputs a collected session names that are not kept yet. A file it created with
   * its tool counts as found; a mentioned one only when it was born during the conversation
   * (a file that is not there yet is asked about again next time). True when any was added.
   */
  record(s: Session): boolean {
    const found = s.outputs ?? [];
    if (!found.length) return false;
    const held = this.db.prepare('SELECT 1 FROM session_outputs WHERE session_id=? AND key=?');
    const put = this.db.prepare('INSERT OR IGNORE INTO session_outputs VALUES (?,?,?,?,?)');
    let added = 0;
    for (const c of found) {
      if (held.get(s.id, c.key)) continue;
      let createdAt = c.at;
      if (c.via === 'mention') {
        const seen = `${s.id}\n${c.key}`;
        if (this.rejected.has(seen)) continue;
        const born = this.birth(c.key);
        if (born === null) continue;
        if (!Number.isFinite(born) || born < s.startedAt - GRACE_MS || born > c.at + GRACE_MS) {
          if (this.rejected.size >= REJECTED_MAX) this.rejected.clear();
          this.rejected.add(seen);
          continue;
        }
        createdAt = Math.round(born);
      }
      const o: StoredOutput = {
        id: hash(`${s.id}\n${c.key}`),
        sessionId: s.id,
        key: c.key,
        kind: c.kind,
        via: c.via,
        createdAt,
        ...(c.title ? { title: c.title } : {}),
        source: { provider: s.provider, project: s.project, title: s.title, alias: s.alias },
      };
      added += Number(
        put.run(o.id, o.sessionId, o.key, o.createdAt, JSON.stringify(o)).changes ?? 0,
      );
    }
    if (!added) return false;
    // Only the newest are kept.
    this.db
      .prepare(
        'DELETE FROM session_outputs WHERE id IN (SELECT id FROM session_outputs ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)',
      )
      .run(OUTPUT_KEEP);
    this.db
      .prepare(
        "INSERT INTO settings VALUES ('outputs_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
      )
      .run();
    return true;
  }
  /** Every recorded output, newest first; none on a database from before outputs. */
  all(sessionIds?: string[]): StoredOutput[] {
    let rows: { data: string }[];
    try {
      rows = (
        sessionIds
          ? this.db
              .prepare(
                'SELECT data FROM session_outputs WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC, id DESC',
              )
              .all(JSON.stringify(sessionIds))
          : this.db
              .prepare('SELECT data FROM session_outputs ORDER BY created_at DESC, id DESC')
              .all()
      ) as typeof rows;
    } catch (e) {
      if (/no such table/.test(String(e))) return [];
      throw e;
    }
    return rows.flatMap((r) => {
      try {
        return [JSON.parse(r.data) as StoredOutput];
      } catch {
        return [];
      }
    });
  }
  byId(id: string): StoredOutput | null {
    try {
      const row = this.db.prepare('SELECT data FROM session_outputs WHERE id=?').get(id) as
        { data: string } | undefined;
      return row ? (JSON.parse(row.data) as StoredOutput) : null;
    } catch (e) {
      if (/no such table/.test(String(e))) return null;
      return null;
    }
  }
  /** Changes whenever an output is recorded, so lists read again. */
  stamp(): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='outputs_revision'").get() as
      { value: string } | undefined;
    return row?.value ?? '0';
  }
}

/**
 * The reader window's content of one recorded output, read now: a markdown or HTML file (judged
 * by where it really is, so a link named like a document reads nothing else), at most
 * `OUTPUT_PREVIEW_BYTES`, redacted like everything shown. Null when it is not there.
 */
export async function readPreview(o: StoredOutput): Promise<OutputPreview | null> {
  if (o.kind !== 'file') return null;
  const file = await realpath(o.key).catch(() => null);
  if (!file) return null;
  const format = previewFormat(extensionOf(file));
  const found = await stat(file).catch(() => null);
  if (!format || !found?.isFile()) return null;
  const handle = await open(file, 'r');
  try {
    const size = Math.min(found.size, OUTPUT_PREVIEW_BYTES);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    // A cut in the middle of a character leaves a replacement mark at most.
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return {
      id: o.id,
      name: path.basename(redact(o.key, 4096)),
      format,
      text: redact(text, OUTPUT_PREVIEW_BYTES * 2),
      truncated: found.size > OUTPUT_PREVIEW_BYTES,
    };
  } finally {
    await handle.close();
  }
}
