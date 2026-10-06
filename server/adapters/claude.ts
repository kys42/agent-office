import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { cleanTitle } from './normalize.js';
import type { CodexMeta } from './codex.js';
import { claudeSubagentPath } from './identity.js';
// Sidecar location/role: Agent Sessions detectSubagentInfo; description: Orca
// readSubagentMeta. See vendor notices. No hooks or source writes are installed.
export async function claudeSubagentMetadata(sourcePath: string) {
  if (!claudeSubagentPath(sourcePath)) return null;
  const file = sourcePath.replace(/\.jsonl$/, '.meta.json');
  try {
    if ((await stat(file)).size > 64 * 1024) return null;
    const value = JSON.parse(await readFile(file, 'utf8'));
    return { title: cleanTitle(value.description), role: cleanTitle(value.agentType) };
  } catch {
    return null;
  }
}
export async function claudeMetadata(root: string): Promise<Map<string, CodexMeta>> {
  const map = new Map<string, CodexMeta>();
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    try {
      const index = JSON.parse(
        await readFile(path.join(root, dir.name, 'sessions-index.json'), 'utf8'),
      );
      for (const entry of index.entries ?? []) {
        const title = entry.customTitle || entry.displayName || entry.summary;
        if (entry.sessionId && title) map.set(entry.sessionId, { title: cleanTitle(title) });
      }
    } catch {
      /* Session indexes are optional and may be rewritten while reading. */
    }
  }
  return map;
}
