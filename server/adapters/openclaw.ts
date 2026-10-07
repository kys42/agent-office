import { DatabaseSync } from 'node:sqlite';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Session } from '../../src/shared/types.js';
import { hash, num, parseRecords, redact, timestamp, deriveState } from './normalize.js';
import { runtimeObservation } from '../../src/shared/runtime.js';
import { canonical } from '../../src/shared/canonical.js';
export async function readOpenClawDatabases(
  root: string,
  limit: number,
  cache: Map<string, Session>,
): Promise<{ sessions: Session[]; errors: number }> {
  const agents = await readdir(root, { withFileTypes: true });
  const sessions: Session[] = [];
  let errors = 0;
  // Nodes not read this pass (removed, archived out of the query, a DB that failed) leave the
  // cache; a later read recomputes the same revision, so this only bounds memory.
  const seen = new Set<string>();
  for (const agent of agents.filter((x) => x.isDirectory())) {
    const file = path.join(root, agent.name, 'agent', 'openclaw-agent.sqlite');
    if (!existsSync(file)) continue;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      db.exec('PRAGMA busy_timeout=1500; PRAGMA query_only=ON');
      const columns = new Set(
        (db.prepare('PRAGMA table_info(session_nodes)').all() as { name: string }[]).map(
          (r) => r.name,
        ),
      );
      const parentIds = columns.has('session_key')
        ? new Map(
            (
              db.prepare('SELECT session_key,current_session_id FROM session_nodes').all() as {
                session_key: string;
                current_session_id: string;
              }[]
            ).map((r) => [r.session_key, r.current_session_id]),
          )
        : new Map<string, string>();
      const optional = ['session_key', 'created_via', 'created_actor_type'].filter((c) =>
        columns.has(c),
      );
      const nodes = db
        .prepare(
          `SELECT current_session_id, entry_json, updated_at, status, label, display_name, parent_session_key, archived_at${optional.length ? ',' + optional.join(',') : ''} FROM session_nodes ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(limit) as Record<string, any>[];
      const tail = db.prepare(
        'SELECT seq, event_json FROM transcript_events WHERE session_id=? ORDER BY seq DESC LIMIT 180',
      );
      const head = db.prepare(
        'SELECT seq, event_json FROM transcript_events WHERE session_id=? ORDER BY seq ASC LIMIT 12',
      );
      const tip = db.prepare('SELECT max(seq) AS seq FROM transcript_events WHERE session_id=?');
      const tables = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
            name: string;
          }[]
        ).map((r) => r.name),
      );
      const rewrite = tables.has('transcript_rewrite_watermarks')
        ? db.prepare(
            'SELECT generation, updated_at FROM transcript_rewrite_watermarks WHERE session_id=?',
          )
        : null;
      for (const n of nodes) {
        try {
          const nativeId = n.current_session_id;
          const last = (tip.get(nativeId) as any)?.seq ?? 0;
          const watermark = rewrite?.get(nativeId);
          const revision = hash(
            `office-v10:${n.updated_at}:${last}:${JSON.stringify(watermark ?? null)}:${n.status}:${n.label}:${n.display_name}:${n.archived_at}:${parentIds.get(n.parent_session_key)}:${n.session_key}:${n.created_via}:${n.created_actor_type}`,
          );
          const key = `${file}:${nativeId}`;
          seen.add(key);
          const prior = cache.get(key);
          if (prior?.revision === revision) {
            sessions.push(prior);
            continue;
          }
          const meta = JSON.parse(n.entry_json);
          const rows = [...head.all(nativeId), ...tail.all(nativeId).reverse()] as {
            seq: number;
            event_json: string;
          }[];
          const uniq = [...new Map(rows.map((r) => [r.seq, r])).values()];
          let broken = false;
          const records = uniq.flatMap((r) => {
            try {
              return [JSON.parse(r.event_json)];
            } catch {
              broken = true;
              return [];
            }
          });
          const s = parseRecords(records, {
            provider: 'openclaw',
            sourcePath: file,
            sourceKind: 'sqlite',
            nativeId,
            agentName: agent.name,
            mtime: timestamp(n.updated_at, Date.now()),
            partial: last > uniq.length || broken,
            title: n.label ?? n.display_name ?? meta.displayName ?? meta.subject,
            cwd: meta.cwd ?? meta.workspaceDir,
            model: meta.model,
          });
          s.updatedAt = Math.max(
            s.updatedAt,
            timestamp(meta.lastInteractionAt ?? meta.updatedAt, n.updated_at),
          );
          s.parentId = parentIds.get(n.parent_session_key) ?? null;
          s.sessionKey = typeof n.session_key === 'string' ? n.session_key : undefined;
          const scheduled =
            n.created_via === 'cron' ||
            (typeof n.session_key === 'string' && /^agent:[^:]+:cron:/.test(n.session_key));
          s.origin = {
            kind: scheduled
              ? 'scheduled'
              : n.created_actor_type === 'user'
                ? 'interactive'
                : 'unknown',
            source: n.created_via ? 'session_nodes.created_via' : 'session_nodes.session_key',
            role: typeof n.created_via === 'string' ? n.created_via : undefined,
          };
          s.relation = {
            kind: s.parentId || n.parent_session_key ? 'child' : 'root',
            parentNativeId: s.parentId,
            parentSessionKey: n.parent_session_key ?? undefined,
            source: n.parent_session_key ? 'session_nodes.parent_session_key' : 'session_nodes',
          };
          s.sourceVersion = 'sqlite/session_nodes+transcript_events';
          if (meta.totalTokensFresh === true && num(meta.totalTokens) !== null) {
            s.usage = {
              ...s.usage,
              total: num(meta.totalTokens),
              input: num(meta.inputTokens),
              output: num(meta.outputTokens),
              cached: num(meta.cacheRead),
              scope: 'session',
              source: 'OpenClaw session_nodes · totalTokensFresh',
            };
          }
          s.usage.contextWindow = num(meta.contextTokens) ?? s.usage.contextWindow;
          // Context capacity is not current context usage. Only record an explicit usage measurement.
          s.usage.contextUsed = null;
          if (['running', 'active'].includes(n.status) && Date.now() - s.updatedAt < 120_000) {
            s.status = 'work';
            s.observedStatus = 'work';
            s.statusReason = `OpenClaw session status: ${n.status}`;
            s.statusEvidence = 'observed';
          }
          if (n.status === 'done' && Date.now() - s.updatedAt < 120_000) {
            s.status = 'done';
            s.observedStatus = 'done';
            s.statusReason = 'OpenClaw session status: done';
            s.statusEvidence = 'observed';
          }
          if (n.archived_at) {
            s.status = 'leave';
            s.archived = true;
            s.statusReason = canonical().server.session.openclawArchived;
          }
          s.runtime = runtimeObservation(s.observedStatus ?? s.status, s.updatedAt, s.statusReason);
          s.title = redact(s.title);
          s.revision = revision;
          cache.set(key, s);
          sessions.push(s);
        } catch {
          errors++;
        }
      }
    } catch {
      errors++;
    } finally {
      db?.close();
    }
  }
  for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key);
  return { sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit), errors };
}
