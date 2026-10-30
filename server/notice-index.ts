import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { OfficeNotice, Session } from '../src/shared/types.js';
import { isBackground, isHelper } from '../src/shared/residents.js';
import { isAttentionNotice, isFinalNotice, isInboxNotice } from '../src/shared/notices.js';
import {
  noticeOrder,
  RECENT_NOTICES,
  UNREAD_FINALS,
  residentNotices,
} from '../src/shared/notice-pages.js';
import { ARRIVAL_MS, ARRIVAL_LAG_MS } from '../src/shared/speech.js';

/** Derived, indexed metadata only. The original JSON/receipts remain the source of truth.
 * Triggers also cover legacy writers and imports. Migration never loads history into JS. */
export function prepareNoticeIndex(db: DatabaseSync, readOnly: boolean): boolean {
  const exists = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='notice_meta'").get();
  if (readOnly) return exists;
  const projection = (prefix: string) => `${prefix}id,${prefix}session_id,${prefix}at,
    NULLIF(json_extract(${prefix}data,'$.seenAt'),0),
    COALESCE(json_extract(${prefix}data,'$.receivedAt'),${prefix}at),
    json_extract(${prefix}data,'$.eventId'),
    COALESCE(json_extract(${prefix}data,'$.kind')='reply' AND json_extract(${prefix}data,'$.phase')='final',0),
    COALESCE(json_extract(${prefix}data,'$.kind') IN ('attention','error') AND COALESCE(json_extract(${prefix}data,'$.resolvedAt'),0)=0,0),
    COALESCE(json_extract(${prefix}data,'$.kind')='request',0),
    COALESCE(json_extract(${prefix}data,'$.kind') IN ('request','attention','error') OR (json_extract(${prefix}data,'$.kind')='reply' AND json_extract(${prefix}data,'$.phase')='final'),0)`;
  db.exec('SAVEPOINT notice_index_migration');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS notice_meta(
      id TEXT PRIMARY KEY,session_id TEXT NOT NULL,at INTEGER NOT NULL,seen_at INTEGER,
      received_at INTEGER NOT NULL,event_id TEXT,final INTEGER NOT NULL,attention INTEGER NOT NULL,
      request INTEGER NOT NULL,conversation INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS notice_meta_order ON notice_meta(at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS notice_meta_session ON notice_meta(session_id,at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS notice_meta_event ON notice_meta(session_id,event_id);
      CREATE INDEX IF NOT EXISTS notice_meta_unread ON notice_meta(session_id,at DESC,id DESC) WHERE seen_at IS NULL;
      CREATE INDEX IF NOT EXISTS notice_meta_final ON notice_meta(at DESC,id DESC) WHERE final=1 AND seen_at IS NULL;
      CREATE INDEX IF NOT EXISTS notice_meta_attention ON notice_meta(at DESC,id DESC) WHERE attention=1;
      CREATE INDEX IF NOT EXISTS notice_meta_session_attention ON notice_meta(session_id,at DESC,id DESC) WHERE attention=1;
      CREATE INDEX IF NOT EXISTS notice_meta_request ON notice_meta(session_id,at DESC,id DESC) WHERE request=1;
      CREATE INDEX IF NOT EXISTS notice_meta_conversation ON notice_meta(session_id,at DESC,id DESC) WHERE conversation=1;
      CREATE TRIGGER IF NOT EXISTS notice_meta_insert AFTER INSERT ON notices BEGIN
        INSERT OR REPLACE INTO notice_meta SELECT ${projection('new.')}; END;
      CREATE TRIGGER IF NOT EXISTS notice_meta_update AFTER UPDATE ON notices BEGIN
        DELETE FROM notice_meta WHERE id=old.id;
        INSERT OR REPLACE INTO notice_meta SELECT ${projection('new.')}; END;
      CREATE TRIGGER IF NOT EXISTS notice_meta_delete AFTER DELETE ON notices BEGIN
        DELETE FROM notice_meta WHERE id=old.id; END;`);
    db.exec(`CREATE TABLE IF NOT EXISTS notice_generation(session_id TEXT PRIMARY KEY,version INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS notice_generation_insert AFTER INSERT ON notices BEGIN
        INSERT INTO notice_generation VALUES(new.session_id,1) ON CONFLICT(session_id) DO UPDATE SET version=version+1; END;
      CREATE TRIGGER IF NOT EXISTS notice_generation_update AFTER UPDATE ON notices BEGIN
        INSERT INTO notice_generation VALUES(old.session_id,1) ON CONFLICT(session_id) DO UPDATE SET version=version+1;
        INSERT INTO notice_generation VALUES(new.session_id,1) ON CONFLICT(session_id) DO UPDATE SET version=version+1; END;
      CREATE TRIGGER IF NOT EXISTS notice_generation_delete AFTER DELETE ON notices BEGIN
        INSERT INTO notice_generation VALUES(old.session_id,1) ON CONFLICT(session_id) DO UPDATE SET version=version+1; END;`);
    if (!exists)
      db.exec(`INSERT OR REPLACE INTO notice_meta SELECT ${projection('')} FROM notices`);
    db.exec('RELEASE notice_index_migration');
    return true;
  } catch (error) {
    db.exec('ROLLBACK TO notice_index_migration; RELEASE notice_index_migration');
    throw error;
  }
}
const fresh = (n: OfficeNotice) => !n.seenAt || n.seenAt > Date.now() - 30 * 86400_000;
/** Calls/arrivals also have a transport budget; all remain queryable and counted on disk. */
export const LIVE_NOTICE_LIMIT = 1000;
const TIED_LATEST = 32;

/** A query working set: only staged changes and rows actually selected, never all history. */
export type NoticeLatestCache = Map<
  string,
  { stamp: string; expires: number; notices: OfficeNotice[] }
>;
export class NoticeIndex {
  private scope: Set<string>;
  private background: Set<string>;
  private overrides: Map<string, OfficeNotice | null>;
  private staged: OfficeNotice[];
  private base: string;
  private args: SQLInputValue[];
  constructor(
    private db: DatabaseSync,
    sessions: Session[],
    overrides: Map<string, OfficeNotice | null>,
    private latestCache: NoticeLatestCache = new Map(),
  ) {
    this.scope = new Set(sessions.map((s) => s.id));
    this.background = new Set(
      sessions.filter((s) => isBackground(s) || isHelper(s)).map((s) => s.id),
    );
    this.overrides = overrides;
    this.staged = [...overrides.values()]
      .filter((n): n is OfficeNotice => !!n && this.scope.has(n.sessionId) && fresh(n))
      .map((n) => ({ ...n, background: this.background.has(n.sessionId) }));
    this.base = `n.session_id IN (SELECT value FROM json_each(?)) AND (n.seen_at IS NULL OR n.seen_at>?)`;
    this.args = [JSON.stringify([...this.scope]), Date.now() - 30 * 86400_000];
    if (overrides.size) {
      this.base += ' AND n.id NOT IN (SELECT value FROM json_each(?))';
      this.args.push(JSON.stringify([...overrides.keys()]));
    }
  }
  private read(
    where: string,
    args: SQLInputValue[],
    matches: (n: OfficeNotice) => boolean,
    limit: number,
  ): OfficeNotice[] {
    const rows = this.db
      .prepare(
        `SELECT data FROM notices WHERE id IN (
      SELECT n.id FROM notice_meta n WHERE ${this.base} AND (${where}) ORDER BY n.at DESC,n.id DESC LIMIT ?
    )`,
      )
      .all(...this.args, ...args, limit) as { data: string }[];
    return rows
      .map((r): OfficeNotice => {
        const n = JSON.parse(r.data) as OfficeNotice;
        return { ...n, background: this.background.has(n.sessionId) };
      })
      .concat(this.staged.filter(matches))
      .sort(noticeOrder)
      .slice(0, limit);
  }
  /** Exact counts over every visible notice (stored and staged), not only the carried ones. */
  counts() {
    const background = JSON.stringify([...this.background]);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) total,
      COALESCE(SUM(n.seen_at IS NULL AND (n.attention=1 OR (n.final=1 AND n.session_id NOT IN (SELECT value FROM json_each(?))))),0) inbox
      FROM notice_meta n WHERE ${this.base}`,
      )
      .get(background, ...this.args) as { total: number; inbox: number };
    for (const n of this.staged) {
      row.total++;
      if (!n.seenAt && (isAttentionNotice(n) || (isFinalNotice(n) && !n.background))) row.inbox++;
    }
    return { total: row.total, inbox: row.inbox };
  }
  /** Same product choices as residentNotices, with explicit bounds on calls/timestamp ties. */
  resident() {
    const rows = this.read('1', [], () => true, RECENT_NOTICES);
    rows.push(...this.read('n.attention=1', [], isAttentionNotice, LIVE_NOTICE_LIMIT));
    const since = Date.now() - ARRIVAL_MS - ARRIVAL_LAG_MS;
    rows.push(
      ...this.read(
        'n.request=1 AND n.at>?',
        [since],
        (n) => n.kind === 'request' && n.at > since,
        LIVE_NOTICE_LIMIT,
      ),
    );
    rows.push(
      ...this.read(
        'n.seen_at IS NULL AND n.final=1 AND n.session_id NOT IN (SELECT value FROM json_each(?))',
        [JSON.stringify([...this.background])],
        (n) => !n.seenAt && !n.background && isFinalNotice(n),
        UNREAD_FINALS,
      ),
    );
    const versions = new Map(
      (
        this.db
          .prepare(
            'SELECT session_id,version FROM notice_generation WHERE session_id IN (SELECT value FROM json_each(?))',
          )
          .all(JSON.stringify([...this.scope])) as { session_id: string; version: number }[]
      ).map((r) => [r.session_id, r.version]),
    );
    for (const id of this.scope) {
      const stamp =
        `${versions.get(id) ?? 0}:${this.background.has(id)}:` +
        JSON.stringify(
          [...this.overrides]
            .filter(([, n]) => !n || n.sessionId === id)
            .map(([key, n]) => [
              key,
              n && [
                n.version,
                n.at,
                n.seenAt,
                n.viewedAt,
                n.dismissedAt,
                n.resolvedAt,
                n.receivedAt,
              ],
            ]),
        );
      const cached = this.latestCache.get(id);
      if (cached?.stamp === stamp && cached.expires > Date.now()) {
        rows.push(...cached.notices);
        continue;
      }
      const start = rows.length;
      const top = this.read('n.session_id=?', [id], (n) => n.sessionId === id, 1)[0];
      if (top)
        rows.push(
          ...this.read(
            'n.session_id=? AND n.at=?',
            [id, top.at],
            (n) => n.sessionId === id && n.at === top.at,
            TIED_LATEST,
          ),
        );
      for (const [sql, test] of [
        ['n.request=1', (n: OfficeNotice) => n.kind === 'request'],
        [
          'n.conversation=1',
          (n: OfficeNotice) =>
            n.kind === 'request' || isFinalNotice(n) || ['attention', 'error'].includes(n.kind),
        ],
        [
          `n.seen_at IS NULL AND (n.attention=1${this.background.has(id) ? '' : ' OR n.final=1'})`,
          (n: OfficeNotice) => !n.seenAt && isInboxNotice(n),
        ],
      ] as const)
        rows.push(
          ...this.read(
            `n.session_id=? AND (${sql})`,
            [id],
            (n) => n.sessionId === id && test(n),
            1,
          ),
        );
      this.latestCache.set(id, { stamp, expires: Date.now() + 60_000, notices: rows.slice(start) });
    }
    return residentNotices([...new Map(rows.map((n) => [n.id, n])).values()].sort(noticeOrder));
  }
  /** Locate an excerpt cursor without loading that session's history. */
  cursor(id: string, eventId: string) {
    const staged = this.staged.find((n) => n.sessionId === id && n.eventId === eventId);
    if (staged) return { at: staged.at, id: staged.id };
    const row = this.db
      .prepare(
        'SELECT id,at FROM notice_meta WHERE session_id=? AND event_id=? ORDER BY at DESC,id DESC LIMIT 1',
      )
      .get(id, eventId) as { id: string; at: number } | undefined;
    return row && !this.overrides.has(row.id) ? row : undefined;
  }
  through(id: string, cursor: { at: number; id: string }, limit: number) {
    return this.read(
      'n.session_id=? AND (n.at<? OR (n.at=? AND n.id<=?))',
      [id, cursor.at, cursor.at, cursor.id],
      (n) => n.sessionId === id && (n.at < cursor.at || (n.at === cursor.at && n.id <= cursor.id)),
      limit,
    );
  }
  /** Bounded excerpt source in the same total order as the snapshot's notices. */
  excerpts(id: string, cursor: { at: number; id?: string } | undefined, limit: number) {
    const where = cursor
      ? cursor.id
        ? ' AND (n.at<? OR (n.at=? AND n.id<?))'
        : ' AND n.at<?'
      : '';
    const args = cursor ? (cursor.id ? [cursor.at, cursor.at, cursor.id] : [cursor.at]) : [];
    return this.read(
      'n.session_id=?' + where,
      [id, ...args],
      (n) =>
        n.sessionId === id &&
        (!cursor || n.at < cursor.at || (!!cursor.id && n.at === cursor.at && n.id < cursor.id)),
      limit,
    );
  }
}
