import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { cleanTitle } from './normalize.js';
export interface CodexMeta {
  title?: string;
  cwd?: string;
  branch?: string;
  gitCommit?: string;
  model?: string;
}
// The index and threads DB change rarely; reuse the last read while their files are unchanged.
const metadataCache = new Map<string, { fingerprint: string; map: Map<string, CodexMeta> }>();
export function resetCodexMetadataCache() {
  metadataCache.clear();
}
const fingerprintOf = async (file: string) => {
  try {
    const s = await stat(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '-';
  }
};
export async function codexMetadata(root: string): Promise<Map<string, CodexMeta>> {
  let stateFiles: string[] = [];
  let listed = true;
  try {
    stateFiles = (await readdir(root))
      .filter((n) => /^state_\d+\.sqlite$/.test(n))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
  } catch {
    listed = false;
  }
  const state = stateFiles[0];
  const fingerprint = [
    await fingerprintOf(path.join(root, 'session_index.jsonl')),
    state ?? '-',
    ...(state
      ? [
          await fingerprintOf(path.join(root, state)),
          await fingerprintOf(path.join(root, `${state}-wal`)),
        ]
      : []),
  ].join('|');
  const cached = metadataCache.get(root);
  if (listed && cached?.fingerprint === fingerprint) return cached.map;
  const map = new Map<string, CodexMeta>();
  let complete = listed;
  try {
    for (const line of (await readFile(path.join(root, 'session_index.jsonl'), 'utf8')).split(
      '\n',
    )) {
      try {
        const r = JSON.parse(line);
        if (r.id) map.set(r.id, { title: cleanTitle(r.thread_name ?? r.title) });
      } catch {
        /* partial */
      }
    }
  } catch {
    /* optional */
  }
  try {
    if (state) {
      const db = new DatabaseSync(path.join(root, state), { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout=1000; PRAGMA query_only=ON');
        const cols = new Set(
          (db.prepare('PRAGMA table_info(threads)').all() as any[]).map((x) => x.name),
        );
        if (cols.has('id') && cols.has('title')) {
          const fields = ['id', 'title', 'name', 'cwd', 'git_branch', 'git_sha', 'model'].filter(
            (x) => cols.has(x),
          );
          for (const row of db
            .prepare(`SELECT ${fields.join(',')} FROM threads ORDER BY updated_at DESC LIMIT 1500`)
            .all() as any[])
            map.set(row.id, {
              title:
                cleanTitle(row.name) || cleanTitle(map.get(row.id)?.title) || cleanTitle(row.title),
              cwd: row.cwd,
              branch: row.git_branch,
              gitCommit: row.git_sha,
              model: row.model,
            });
        }
      } finally {
        db.close();
      }
    }
  } catch {
    /* JSONL index still usable when schema differs */
    // A locked or failing DB read is retried next time rather than remembered.
    complete = false;
  }
  if (complete) metadataCache.set(root, { fingerprint, map });
  else metadataCache.delete(root);
  return map;
}
