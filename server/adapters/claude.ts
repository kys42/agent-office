import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { cleanTitle, hash } from './normalize.js';
import type { CodexMeta } from './codex.js';
import { claudeSubagentPath } from './identity.js';
import type { Session } from '../../src/shared/types.js';
type Sidecar = { title: string | undefined; role: string | undefined } | null;
// Sidecars and project indexes rarely change: re-read one only when its mtime or size moves.
const sidecarCache = new Map<string, { fingerprint: string; value: Sidecar }>();
const indexCache = new Map<string, { fingerprint: string; entries: [string, CodexMeta][] }>();
const metadataCache = new Map<string, { fingerprint: string; map: Map<string, CodexMeta> }>();
const MAX_SIDECARS = 4000;
const teamCache = new Map<string, { fingerprint: string; lead: string | undefined }>();
const folderCache = new Map<string, { fingerprint: string; ids: string[] }>();
const MAX_TEAMS = 500;
export function resetClaudeMetadataCache() {
  sidecarCache.clear();
  indexCache.clear();
  metadataCache.clear();
  teamCache.clear();
  folderCache.clear();
}
const sessionId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** Claude Code's team folder name for a team (sanitizeName in 2.1.316's swarm code). */
const teamFolder = (team: string) => team.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
/** Bounded LRU insert, as for sidecars. */
function keep<V>(cache: Map<string, V>, key: string, value: V, max: number) {
  cache.delete(key);
  cache.set(key, value);
  for (const k of cache.keys()) {
    if (cache.size <= max) break;
    cache.delete(k);
  }
}
async function fingerprintOf(file: string): Promise<string | null> {
  try {
    const s = await stat(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : null;
  }
}
/** `leadSessionId` of a team's config (`<claude home>/teams/<team>/config.json`), if it names one. */
async function teamConfigLead(home: string, team: string): Promise<string | undefined> {
  const file = path.join(home, 'teams', teamFolder(team), 'config.json');
  const fingerprint = await fingerprintOf(file);
  if (fingerprint === null) return undefined;
  const cached = teamCache.get(file);
  if (cached?.fingerprint === fingerprint) return cached.lead;
  let lead: string | undefined;
  // An oversized file is no team config of Claude Code's: remembered as naming no lead.
  if (fingerprint !== 'missing' && Number(fingerprint.split(':')[1]) <= 256 * 1024) {
    try {
      const config = JSON.parse(await readFile(file, 'utf8'));
      lead = typeof config?.leadSessionId === 'string' ? config.leadSessionId : undefined;
      if (lead && !sessionId.test(lead)) lead = undefined;
    } catch {
      // Mid-write or unreadable: not remembered, read again next time.
      teamCache.delete(file);
      return undefined;
    }
  }
  keep(teamCache, file, { fingerprint, lead }, MAX_TEAMS);
  return lead;
}
/** The session ids of one project folder's transcripts (`<id>.jsonl`), by folder mtime. */
async function folderSessions(folder: string): Promise<string[]> {
  const fingerprint = await fingerprintOf(folder);
  if (fingerprint === null || fingerprint === 'missing') return [];
  const cached = folderCache.get(folder);
  if (cached?.fingerprint === fingerprint) return cached.ids;
  let ids: string[] = [];
  try {
    ids = (await readdir(folder))
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.slice(0, -'.jsonl'.length))
      .filter((id) => sessionId.test(id));
  } catch {
    return [];
  }
  keep(folderCache, folder, { fingerprint, ids }, MAX_TEAMS);
  return ids;
}
/**
 * The lead session of a pane teammate's team (see claudeTeammate). Claude Code 2.1.316 keeps
 * the lead in the team config (`leadSessionId`); a session's own team is named after the lead
 * (`session-<first 8 characters of its id>`), which still names it once the config is gone:
 * then the one transcript in the teammate's project folder whose id starts so is the lead.
 * Undefined when neither finds it (another folder, several matches, removed).
 */
export async function claudeTeamLead(
  root: string,
  sourcePath: string,
  team: string,
  self?: string,
): Promise<string | undefined> {
  const configured = await teamConfigLead(path.dirname(root), team);
  if (configured && configured !== self) return configured;
  const prefix = /^session-([0-9a-f]{8})$/i.exec(team)?.[1]?.toLowerCase();
  if (!prefix) return undefined;
  const matches = (await folderSessions(path.dirname(sourcePath))).filter(
    (id) => id.toLowerCase().startsWith(prefix) && id !== self,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
/**
 * An agent-team member with its lead found becomes the lead's helper: it sits at the lead's
 * desk like a subagent. Without the lead it stays a desk of its own (still tagged a teammate).
 */
export async function claudeTeammateLink(s: Session, root: string): Promise<Session> {
  const team = s.relation?.team;
  if (!team || s.relation?.kind === 'subagent') return s;
  const lead = await claudeTeamLead(root, s.sourcePath, team, s.nativeId);
  if (!lead) return s;
  return {
    ...s,
    parentId: lead,
    relation: { ...s.relation!, kind: 'subagent', parentNativeId: lead },
    revision: hash(`${s.revision}:team-lead:${lead}`),
  };
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
  } catch (e) {
    // Only a real absence is remembered (until one appears); other failures retry next time.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return null;
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
      // Unreadable or mid-write: not remembered, so the next pass reads it again.
      sidecarCache.delete(file);
      return null;
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
