import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { cleanTitle } from './normalize.js';
import type { CodexMeta } from './codex.js';
import { claudeSubagentPath } from './identity.js';
type Sidecar = { title: string | undefined; role: string | undefined } | null;
// Sidecars and project indexes rarely change: re-read one only when its mtime or size moves.
const sidecarCache = new Map<string, { fingerprint: string; value: Sidecar }>();
const indexCache = new Map<string, { fingerprint: string; entries: [string, CodexMeta][] }>();
const metadataCache = new Map<string, { fingerprint: string; map: Map<string, CodexMeta> }>();
const MAX_SIDECARS = 4000;
export function resetClaudeMetadataCache() {
  sidecarCache.clear();
  indexCache.clear();
  metadataCache.clear();
}
// Sidecar location/role: Agent Sessions detectSubagentInfo; description: Orca
// readSubagentMeta. See vendor notices. No hooks or source writes are installed.
export async function claudeSubagentMetadata(sourcePath: string): Promise<Sidecar> {
  if (!claudeSubagentPath(sourcePath)) return null;
  const file = sourcePath.replace(/\.jsonl$/, '.meta.json');
  let fingerprint = 'missing';
  let size = 0;
  try {
    const s = await stat(file);
    fingerprint = `${s.mtimeMs}:${s.size}`;
    size = s.size;
  } catch {
    /* no sidecar: remembered as missing until one appears */
  }
  const cached = sidecarCache.get(file);
  if (cached?.fingerprint === fingerprint) {
    // Refresh recency so the cap drops the least recently used sidecars.
    sidecarCache.delete(file);
    sidecarCache.set(file, cached);
    return cached.value;
  }
  let value: Sidecar = null;
  if (fingerprint !== 'missing' && size <= 64 * 1024) {
    try {
      const meta = JSON.parse(await readFile(file, 'utf8'));
      value = { title: cleanTitle(meta.description), role: cleanTitle(meta.agentType) };
    } catch {
      value = null;
    }
  }
  sidecarCache.delete(file);
  sidecarCache.set(file, { fingerprint, value });
  for (const key of sidecarCache.keys()) {
    if (sidecarCache.size <= MAX_SIDECARS) break;
    sidecarCache.delete(key);
  }
  return value;
}
export async function claudeMetadata(root: string): Promise<Map<string, CodexMeta>> {
  const files: { file: string; fingerprint: string }[] = [];
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(root, dir.name, 'sessions-index.json');
    try {
      const s = await stat(file);
      files.push({ file, fingerprint: `${s.mtimeMs}:${s.size}` });
    } catch {
      /* Session indexes are optional. */
    }
  }
  const fingerprint = files.map((f) => `${f.file}:${f.fingerprint}`).join('|');
  const cached = metadataCache.get(root);
  if (cached?.fingerprint === fingerprint) return cached.map;
  const map = new Map<string, CodexMeta>();
  let complete = true;
  const seen = new Set<string>();
  for (const { file, fingerprint } of files) {
    seen.add(file);
    let entries = indexCache.get(file);
    if (entries?.fingerprint !== fingerprint) {
      try {
        const index = JSON.parse(await readFile(file, 'utf8'));
        entries = { fingerprint, entries: [] };
        for (const entry of index.entries ?? []) {
          const title = entry.customTitle || entry.displayName || entry.summary;
          if (entry.sessionId && title)
            entries.entries.push([entry.sessionId, { title: cleanTitle(title) }]);
        }
        indexCache.set(file, entries);
      } catch {
        /* Session indexes may be rewritten while reading: read again next time. */
        indexCache.delete(file);
        complete = false;
        continue;
      }
    }
    for (const [id, meta] of entries.entries) map.set(id, meta);
  }
  for (const file of indexCache.keys())
    if (file.startsWith(root + path.sep) && !seen.has(file)) indexCache.delete(file);
  if (complete) metadataCache.set(root, { fingerprint, map });
  else metadataCache.delete(root);
  return map;
}
