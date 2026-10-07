import { summarizeCost } from './pricing.js';
import { validOfficeSchedule } from '../src/shared/lifecycle.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  Handoff,
  Preferences,
  Provider,
  SearchHit,
  Session,
  SessionIdentity,
  SessionPatch,
  OfficeNotice,
  NoticeReceipt,
  UsageEntry,
} from '../src/shared/types.js';
import { redact } from './adapters/normalize.js';
import { deriveState } from '../src/shared/runtime.js';
import { allocateSeats, officeZone, attachSessions, seatKey } from '../src/shared/office.js';
import { officeResidents, isBackground, isHelper } from '../src/shared/residents.js';
import {
  localizeNotice,
  noticeCandidates,
  noticeContentVersion,
  requestClosedAt,
} from '../src/shared/notices.js';
import { applyZone } from '../src/shared/zones.js';
import { snapshotEvents } from '../src/shared/speech.js';
import { getLocale, m, messagesFor, type Locale } from '../src/shared/i18n/index.js';
import { CANONICAL, canonicalProject, localizeSession } from '../src/shared/canonical.js';
import { mergePetCustomization, normalizePetCustomization } from '../src/shared/pets.js';

/** A session first seen this soon after its start is a live one, not history. */
export const NEW_SESSION_MS = 2 * 60_000;
export const defaultDataDir = () =>
  process.env.AGENT_OFFICE_DATA_DIR ??
  path.join(os.homedir(), 'Library', 'Application Support', 'Agent Office');
export const DEFAULT_PREFS: Preferences = {
  paused: false,
  reducedMotion: false,
  privacy: false,
  excludedProjects: [],
  enabledProviders: ['claude', 'codex', 'openclaw'],
  maxSessions: 120,
  standbyHours: 4,
  archiveDays: 7,
  autoArchive: true,
  bubbleHours: 3,
  readyMinutes: 30,
};
const SCHEMA = `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, provider TEXT NOT NULL, project TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS personal(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING fts5(id UNINDEXED,title,body,tokenize='unicode61'); CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS notices_session ON notices(session_id,at); CREATE TABLE IF NOT EXISTS notice_cursors(session_id TEXT PRIMARY KEY, at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS notice_observed(session_id TEXT NOT NULL,event_id TEXT NOT NULL,version TEXT NOT NULL,PRIMARY KEY(session_id,event_id)); CREATE TABLE IF NOT EXISTS usage_ledger(session_id TEXT NOT NULL, entry_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,entry_id)); PRAGMA user_version=3;`;
const isBusy = (e: unknown) =>
  /database is locked|SQLITE_BUSY/i.test(e instanceof Error ? e.message : String(e));
/** Startup only: block this thread briefly (the collector runs in its own worker). */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export class OfficeStore {
  db: DatabaseSync;
  /**
   * Writer only: stored sessions already parsed, by id. Our own writes drop their ids (upsert),
   * a commit from another connection (a dev server or second app on the same data) drops all of
   * them (`PRAGMA data_version`, compared on this one connection). A read-only store (MCP) has
   * no cache and always reads what is on disk.
   */
  private cached: Map<string, Session> | null = null;
  private dataVersion = -1;
  /**
   * Sessions whose notices this run already took in, by revision and event ids. Each collector
   * run takes every session in once (a newer collector may classify notices differently), then
   * an unchanged session costs nothing.
   */
  private ingested = new Map<string, string>();
  constructor(dir = defaultDataDir(), readOnly = false) {
    if (!readOnly) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'office.sqlite');
    this.db = new DatabaseSync(file, { readOnly });
    this.db.exec('PRAGMA busy_timeout=3000');
    if (!readOnly) {
      // Another Agent Office on the same data (a second window, a dev server) can hold the write
      // lock for a while. Wait it out at startup instead of leaving the collector dead.
      for (let attempt = 0; ; attempt++) {
        try {
          this.db.exec(SCHEMA);
          break;
        } catch (e) {
          if (!isBusy(e) || attempt >= 8) throw e;
          pause(500);
        }
      }
      chmodSync(file, 0o600);
      this.cached = new Map();
    } else this.db.exec('PRAGMA query_only=ON');
  }
  close() {
    this.db.close();
  }
  preferences(patch?: Partial<Preferences>): Preferences {
    const value = this.db.prepare("SELECT value FROM settings WHERE key='preferences'").get() as
      { value: string } | undefined;
    const prefs = { ...DEFAULT_PREFS, ...(value ? JSON.parse(value.value) : {}) };
    if (patch) {
      const petAppearance = patch.petAppearance
        ? mergePetCustomization(prefs.petAppearance, patch.petAppearance)
        : prefs.petAppearance;
      Object.assign(prefs, patch, { petAppearance });
      if (patch.excludedProjects)
        prefs.excludedProjects = [...new Set(patch.excludedProjects.map(canonicalProject))];
      if (!validOfficeSchedule(prefs)) throw new Error(m().server.prefs.scheduleOrder);
      this.db
        .prepare("INSERT OR REPLACE INTO settings VALUES ('preferences',?)")
        .run(JSON.stringify(prefs));
    }
    if (prefs.petAppearance) prefs.petAppearance = normalizePetCustomization(prefs.petAppearance);
    return prefs;
  }
  upsert(sessions: Session[], provider: Provider) {
    const put = this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?)');
    const get = this.db.prepare('SELECT data FROM sessions WHERE id=?');
    const remove = this.db.prepare('DELETE FROM session_search WHERE id=?');
    const index = this.db.prepare('INSERT INTO session_search(id,title,body) VALUES (?,?,?)');
    const ledgerPut = this.db.prepare('INSERT OR REPLACE INTO usage_ledger VALUES(?,?,?)');
    const ledgerGet = this.db.prepare(
      'SELECT data FROM usage_ledger WHERE session_id=? AND entry_id=?',
    );
    const ledgerAll = this.db.prepare('SELECT data FROM usage_ledger WHERE session_id=?');
    const ledgerNative = this.db.prepare(
      "SELECT 1 FROM usage_ledger WHERE session_id=? AND entry_id LIKE 'response:%' LIMIT 1",
    );
    const ledgerDropFallback = this.db.prepare(
      "DELETE FROM usage_ledger WHERE session_id=? AND entry_id LIKE 'codex:%'",
    );
    const standbyHours = this.preferences().standbyHours ?? DEFAULT_PREFS.standbyHours!;
    this.db.exec('BEGIN');
    try {
      for (const s of sessions) {
        const prior = get.get(s.id) as { data: string } | undefined;
        const previous: Session | undefined = prior ? JSON.parse(prior.data) : undefined;
        // Unchanged since this run took it in: nothing about its notices can become new with time
        // alone (time only retires old requests), so a quiet cycle writes nothing.
        const seen = `${s.revision}\n${s.events.map((e) => e.id).join('\n')}`;
        if (previous?.revision === s.revision && this.ingested.get(s.id) === seen) continue;
        this.ingestNotices(s, standbyHours);
        this.ingested.set(s.id, seen);
        if (previous?.revision === s.revision) continue;
        this.cached?.delete(s.id);
        const taskStartedAt =
          Math.max(s.taskStartedAt ?? 0, previous?.taskStartedAt ?? 0) || undefined;
        const hasNative =
          (s.usageEntries ?? []).some((e) => e.id.startsWith('response:')) ||
          !!ledgerNative.get(s.id);
        if (hasNative) ledgerDropFallback.run(s.id);
        for (const entry of s.usageEntries ?? []) {
          if (hasNative && entry.id.startsWith('codex:')) continue;
          const old = ledgerGet.get(s.id, entry.id) as { data: string } | undefined;
          const prev: UsageEntry | undefined = old ? JSON.parse(old.data) : undefined;
          // Streaming snapshots sometimes regress; preserve the fullest message.
          if (!prev || entry.output >= prev.output)
            ledgerPut.run(
              s.id,
              entry.id,
              JSON.stringify({ ...entry, model: entry.model ?? prev?.model ?? null }),
            );
        }
        const entries = (ledgerAll.all(s.id) as { data: string }[]).map(
          (r) => JSON.parse(r.data) as UsageEntry,
        );
        const { usageEntries: _transient, ...stored } = s;
        const retainLocation = !s.workingLocation && s.partial && previous?.workingLocation;
        const location =
          s.workingLocation ?? (retainLocation ? previous?.workingLocation : undefined);
        const workspace = retainLocation ? previous?.workspace : s.workspace;
        const project = retainLocation ? previous!.project : s.project;
        put.run(
          s.id,
          provider,
          project,
          s.updatedAt,
          JSON.stringify({
            ...stored,
            workingLocation: location,
            workspace,
            project,
            cost: summarizeCost(entries),
            taskStartedAt,
          }),
        );
        remove.run(s.id);
        index.run(
          s.id,
          s.title,
          [s.project, s.cwd, s.model, ...s.events.map((e) => e.text)].filter(Boolean).join('\n'),
        );
      }
      const present = new Set(sessions.map((s) => s.id));
      for (const row of this.db
        .prepare('SELECT id FROM sessions WHERE provider=?')
        .all(provider) as { id: string }[]) {
        if (!present.has(row.id)) {
          this.db.prepare('DELETE FROM sessions WHERE id=?').run(row.id);
          remove.run(row.id);
          this.cached?.delete(row.id);
          this.ingested.delete(row.id);
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      // Nothing of this pass was kept: take everything in again next time.
      this.ingested.clear();
      this.cached?.clear();
      throw e;
    }
  }
  private ingestNotices(s: Session, standbyHours = DEFAULT_PREFS.standbyHours!) {
    const now = Date.now();
    const cursor = this.db.prepare('SELECT at FROM notice_cursors WHERE session_id=?').get(s.id) as
      { at: number } | undefined;
    // A conversation first seen within minutes of its start is live, not history: its first
    // request and replies are news (the arrival plays), unlike an old session found on scan.
    const born = !cursor && now - s.startedAt < NEW_SESSION_MS;
    const all = noticeCandidates(s, now, !cursor && !born);
    const get = this.db.prepare('SELECT data FROM notices WHERE id=?');
    const observed = this.db.prepare(
      'SELECT version FROM notice_observed WHERE session_id=? AND event_id=?',
    );
    const remember = this.db.prepare('INSERT OR REPLACE INTO notice_observed VALUES(?,?,?)');
    // Parser upgrades must not turn already-read messages into fresh notices.
    // Transfer ONLY when the old ordinal key has exactly the same content version.
    const legacyIds = new Map(s.events.filter((e) => e.legacyId).map((e) => [e.id, e.legacyId!]));
    for (const n of all) {
      const legacy = legacyIds.get(n.eventId);
      if (!legacy) continue;
      const prior = observed.get(s.id, legacy) as { version: string } | undefined;
      if (prior?.version === n.version) remember.run(s.id, n.eventId, n.version);
      const oldId = `${s.id}::${legacy}`;
      const row = get.get(oldId) as { data: string } | undefined;
      if (!row || get.get(n.id)) continue;
      const old: OfficeNotice = JSON.parse(row.data);
      if (old.version !== n.version) continue;
      const next = { ...old, id: n.id, eventId: n.eventId };
      this.db
        .prepare('INSERT OR REPLACE INTO notices VALUES(?,?,?,?)')
        .run(next.id, next.sessionId, next.at, JSON.stringify(next));
      this.db.prepare('DELETE FROM notices WHERE id=?').run(oldId);
    }
    // Classify legacy replies without turning a parser upgrade into a fresh notification.
    // Old rows outside the retained source window stay available in All, but never count as finals.
    for (const n of all) {
      const row = get.get(n.id) as { data: string } | undefined;
      const old: OfficeNotice | undefined = row ? JSON.parse(row.data) : undefined;
      const prior = observed.get(s.id, n.eventId) as { version: string } | undefined;
      // Legacy unphased assistants used the reply kind, even when bootstrap suppressed
      // their notice rows. Advance that cursor too, rather than backfilling old progress.
      if (
        (!old || !old.phase) &&
        n.kind !== 'reply' &&
        prior?.version === noticeContentVersion('reply', n.text, n.at)
      )
        remember.run(s.id, n.eventId, n.version);
      if (!old) continue;
      if (
        !old.phase &&
        ['reply', 'progress'].includes(old.kind) &&
        old.text === n.text &&
        old.at === n.at
      ) {
        this.db
          .prepare('UPDATE notices SET data=? WHERE id=?')
          .run(JSON.stringify({ ...old, kind: n.kind, phase: n.phase, version: n.version }), n.id);
      }
    }
    // An unanswered request older than the off-duty time belongs to a colleague who has gone
    // home (STATUS-POLICY §3): history, not news. E.g. a plan approval abandoned days ago that a
    // newer collector recognizes for the first time. It is remembered below, never notified.
    const news = all.filter((n) => n.kind !== 'attention' || now - n.at < standbyHours * 3600_000);
    const recent =
      cursor || born
        ? news.filter((n) => {
            const prior = observed.get(s.id, n.eventId) as { version: string } | undefined;
            return !prior || prior.version !== n.version;
          })
        : news.filter((n) => now - n.at <= 3 * 3600_000).slice(-1);
    for (const n of all) remember.run(s.id, n.eventId, n.version);
    const put = this.db.prepare('INSERT OR REPLACE INTO notices VALUES(?,?,?,?)');
    for (const n of recent) {
      const row = get.get(n.id) as { data: string } | undefined;
      const old: OfficeNotice | undefined = row ? JSON.parse(row.data) : undefined;
      if (old?.version === n.version) continue;
      if (
        old &&
        !s.events.some((e) => e.id === n.eventId) &&
        old.text.startsWith(n.text.replace(/…$/, ''))
      )
        continue;
      const next = old
        ? {
            ...n,
            receivedAt: now,
            bootstrap: old.bootstrap,
            seenAt: null,
            viewedAt: null,
            dismissedAt: null,
            resolvedAt: old.resolvedAt,
          }
        : n;
      put.run(next.id, next.sessionId, next.at, JSON.stringify(next));
    }
    // A later human request or resumed work resolves a prior attention cue, not its unread record.
    const resumed = s.events
      .filter(
        (e) =>
          e.kind === 'user' ||
          (e.kind === 'tool' && e.intent !== 'request-input') ||
          e.lifecycle === 'completed' ||
          e.lifecycle === 'aborted',
      )
      .at(-1)?.at;
    if (resumed)
      for (const row of this.db
        .prepare('SELECT data FROM notices WHERE session_id=? AND at<?')
        .all(s.id, resumed) as { data: string }[]) {
        const n: OfficeNotice = JSON.parse(row.data);
        if (!n.resolvedAt && ['attention', 'error'].includes(n.kind))
          put.run(n.id, n.sessionId, n.at, JSON.stringify({ ...n, resolvedAt: resumed }));
      }
    // A request that is no longer open resolves its own cue: answered (its result), moved past,
    // or no longer waiting live (a permission prompt that was approved). Requests outside the
    // read window are left to the rule above.
    const open = new Set(all.filter((n) => n.kind === 'attention').map((n) => n.eventId));
    for (const row of this.db
      .prepare(
        "SELECT data FROM notices WHERE session_id=? AND json_extract(data,'$.kind')='attention' AND json_extract(data,'$.resolvedAt') IS NULL",
      )
      .all(s.id) as { data: string }[]) {
      const n: OfficeNotice = JSON.parse(row.data);
      const request = s.events.find((e) => e.id === n.eventId);
      if (!request || open.has(n.eventId)) continue;
      const resolvedAt = requestClosedAt(s.events, request) ?? now;
      put.run(n.id, n.sessionId, n.at, JSON.stringify({ ...n, resolvedAt }));
    }
    this.db
      .prepare('INSERT OR REPLACE INTO notice_cursors VALUES(?,?)')
      .run(s.id, Math.max(cursor?.at ?? 0, s.updatedAt));
  }
  /** Notices in `locale`; stored rows stay canonical. */
  noticeList(
    locale: Locale = getLocale(),
    sessions: Session[] = this.list(false, CANONICAL),
  ): OfficeNotice[] {
    const visible = new Set(sessions.map((s) => s.id));
    const background = new Set(
      sessions.filter((s) => isBackground(s) || isHelper(s)).map((s) => s.id),
    );
    const rows = this.db.prepare('SELECT data FROM notices ORDER BY at DESC').all() as {
      data: string;
    }[];
    return rows
      .map((r) => JSON.parse(r.data) as OfficeNotice)
      .filter(
        (n) => visible.has(n.sessionId) && (!n.seenAt || Date.now() - n.seenAt < 30 * 86400_000),
      )
      .map((n) => ({ ...localizeNotice(n, locale), background: background.has(n.sessionId) }));
  }
  noticeReceipt(receipts: NoticeReceipt[], action: 'read' | 'dismiss' | 'unread' | 'view') {
    const get = this.db.prepare('SELECT data FROM notices WHERE id=?');
    const put = this.db.prepare('UPDATE notices SET data=? WHERE id=?');
    for (const receipt of receipts) {
      const row = get.get(receipt.id) as { data: string } | undefined;
      if (!row) continue;
      const n: OfficeNotice = JSON.parse(row.data);
      this.get(n.sessionId); // same exclusion policy as detail/search/MCP
      if (n.version !== receipt.version) continue;
      const next = {
        ...n,
        ...(action === 'view'
          ? { viewedAt: n.viewedAt ?? Date.now() }
          : action === 'read'
            ? { seenAt: Date.now() }
            : action === 'unread'
              ? { seenAt: null }
              : { dismissedAt: Date.now() }),
      };
      put.run(JSON.stringify(next), n.id);
    }
  }
  visible(s: Pick<Session, 'provider' | 'project'>, prefs = this.preferences()): boolean {
    // Canonical on both sides: an exclusion made in any language keeps matching after a switch.
    const project = canonicalProject(s.project);
    return (
      prefs.enabledProviders.includes(s.provider) &&
      !prefs.excludedProjects.some((x) => canonicalProject(x) === project)
    );
  }
  /** `prefs` is read once by the caller: a list decorates every session with the same settings. */
  decorate(s: Session, prefs: Preferences, personal?: Map<string, string>): Session {
    const data = personal
      ? personal.get(s.id)
      : (
          this.db.prepare('SELECT data FROM personal WHERE id=?').get(s.id) as
            { data: string } | undefined
        )?.data;
    const session = { ...s, ...(data ? JSON.parse(data) : {}) };
    const state = deriveState(
      s.observedStatus ?? s.status,
      s.updatedAt,
      Date.now(),
      session.archived,
      prefs.standbyHours,
      prefs.readyMinutes,
    );
    return {
      ...applyZone(session, prefs.zoneRules),
      status: state.status,
      statusReason: state.reason ?? s.statusReason,
      statusEvidence: state.reason ? 'derived' : s.statusEvidence,
      zone: officeZone(session, prefs),
    };
  }
  /** Keeps desks for the colleagues in the office; written only when they change. */
  assignSeats(listed: Session[] = this.list(false, CANONICAL)): Record<string, number> {
    const sessions = officeResidents(listed).sessions.filter((s) => s.zone === 'office');
    const row = this.db.prepare("SELECT value FROM settings WHERE key='office_seats'").get() as
      { value: string } | undefined;
    const previous = row ? JSON.parse(row.value) : {};
    const next = allocateSeats(sessions, previous);
    const value = JSON.stringify(next);
    if (row?.value !== value)
      this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('office_seats',?)").run(value);
    return next;
  }
  visit(id: string, returnToOffice = false) {
    this.get(id);
    const row = this.db.prepare('SELECT data FROM personal WHERE id=?').get(id) as
      { data: string } | undefined;
    const p = row ? JSON.parse(row.data) : {};
    const now = Date.now();
    const next = {
      ...p,
      lastViewedAt: now,
      openCount: (p.openCount || 0) + (now - (p.lastViewedAt || 0) > 10_000 ? 1 : 0),
      ...(returnToOffice ? { returnedAt: now, archived: false } : {}),
    };
    this.db.prepare('INSERT OR REPLACE INTO personal VALUES (?,?)').run(id, JSON.stringify(next));
  }
  /** Stored sessions, newest first. The writer parses only rows it has not parsed yet. */
  private rows(): Session[] {
    const parse = (rows: { data: string }[]) => rows.map((r) => JSON.parse(r.data) as Session);
    if (!this.cached)
      return parse(
        this.db.prepare('SELECT data FROM sessions ORDER BY updated_at DESC').all() as {
          data: string;
        }[],
      );
    const { data_version: version } = this.db.prepare('PRAGMA data_version').get() as {
      data_version: number;
    };
    if (version !== this.dataVersion) {
      this.cached.clear();
      this.dataVersion = version;
    }
    if (!this.cached.size) {
      const all = parse(
        this.db.prepare('SELECT data FROM sessions ORDER BY updated_at DESC').all() as {
          data: string;
        }[],
      );
      for (const s of all) this.cached.set(s.id, s);
      return all;
    }
    const read = this.db.prepare('SELECT data FROM sessions WHERE id=?');
    const ids = this.db.prepare('SELECT id FROM sessions ORDER BY updated_at DESC').all() as {
      id: string;
    }[];
    const result: Session[] = [];
    const present = new Set<string>();
    for (const { id } of ids) {
      present.add(id);
      let s = this.cached.get(id);
      if (!s) {
        const row = read.get(id) as { data: string } | undefined;
        if (!row) continue;
        s = JSON.parse(row.data) as Session;
        this.cached.set(id, s);
      }
      result.push(s);
    }
    if (this.cached.size > present.size)
      for (const id of this.cached.keys()) if (!present.has(id)) this.cached.delete(id);
    return result;
  }
  /** Visible sessions decorated with the person's settings and desks, before grouping. */
  private decorated(full: boolean, seats: Record<string, number>): Session[] {
    const prefs = this.preferences();
    const personal = new Map(
      (
        this.db.prepare('SELECT id, data FROM personal').all() as { id: string; data: string }[]
      ).map((r) => [r.id, r.data]),
    );
    return this.rows()
      .filter((s) => this.visible(s, prefs))
      .map((s) => {
        const d = {
          ...this.decorate(s, prefs, personal),
          officeSeat: seats[seatKey(s)] ?? seats[s.id],
        };
        return full ? d : { ...d, events: snapshotEvents(d) };
      });
  }
  private seats(): Record<string, number> {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='office_seats'").get() as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : {};
  }
  /** Visible sessions in `locale` (the collector's stored rows are canonical). */
  list(full = false, locale: Locale = getLocale()): Session[] {
    return attachSessions(this.decorated(full, this.seats())).map((s) =>
      localizeSession(s, locale),
    );
  }
  /**
   * What the office shows, from one read of the sessions: desks kept up to date, notices of the
   * same colleagues, all in `locale`. The same result as `assignSeats`, `noticeList` and `list`
   * called in turn, without reading and parsing every session three times.
   */
  officeView(locale: Locale = getLocale()): { sessions: Session[]; notices: OfficeNotice[] } {
    const stored = this.seats();
    const base = this.decorated(false, stored);
    const listed = attachSessions(base);
    const seats = this.assignSeats(listed);
    const sessions =
      JSON.stringify(seats) === JSON.stringify(stored)
        ? listed
        : attachSessions(base.map((s) => ({ ...s, officeSeat: seats[seatKey(s)] ?? seats[s.id] })));
    return {
      sessions: sessions.map((s) => localizeSession(s, locale)),
      notices: this.noticeList(locale, sessions),
    };
  }
  /** The stored (canonical) session, if the person's settings let it be seen. */
  private stored(id: string, prefs: Preferences): Session {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id) as
      { data: string } | undefined;
    if (!row) throw new Error(m().server.store.notFound);
    const s = JSON.parse(row.data) as Session;
    if (!this.visible(s, prefs)) throw new Error(m().server.store.excluded);
    return s;
  }
  get(id: string, locale: Locale = getLocale()): Session {
    const prefs = this.preferences();
    return localizeSession(this.decorate(this.stored(id, prefs), prefs), locale);
  }
  /**
   * Who these sessions are natively, for finding their terminals: the same visibility as `get`,
   * read in one query without loading, decorating or localizing their events. Unknown and
   * excluded ids are left out.
   */
  identities(ids: string[]): SessionIdentity[] {
    const prefs = this.preferences();
    const rows = this.db
      .prepare(
        `SELECT id, json_extract(data,'$.provider') AS provider,
          json_extract(data,'$.project') AS project, json_extract(data,'$.nativeId') AS nativeId,
          json_extract(data,'$.sourcePath') AS sourcePath
        FROM sessions WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids)) as unknown as (SessionIdentity & { project: string })[];
    return rows
      .filter((r) => this.visible(r, prefs))
      .map(({ id, provider, nativeId, sourcePath }) => ({ id, provider, nativeId, sourcePath }));
  }
  patch(id: string, patch: SessionPatch) {
    this.get(id);
    const row = this.db.prepare('SELECT data FROM personal WHERE id=?').get(id) as
      { data: string } | undefined;
    this.db.prepare('INSERT OR REPLACE INTO personal VALUES (?,?)').run(
      id,
      JSON.stringify({
        ...(row ? JSON.parse(row.data) : {}),
        ...patch,
        alias:
          patch.alias === undefined
            ? row
              ? (JSON.parse(row.data).alias ?? '')
              : ''
            : redact(patch.alias, 60, getLocale()),
        // The person's own words: kept as written (placeholders in their language), never localized.
        ...(patch.notes !== undefined ? { notes: redact(patch.notes, 12000, getLocale()) } : {}),
      }),
    );
  }
  /**
   * Hide colleagues until their next conversation, or bring them back. One transaction and
   * the service's own clock, so a renderer cannot stamp a future time.
   */
  veil(ids: string[], on: boolean, now = Date.now()) {
    this.personalize(ids, { hiddenAt: on ? now : null });
  }
  /** Pin or unpin colleagues, e.g. every run of a persona: all of them or none. */
  pin(ids: string[], on: boolean) {
    this.personalize(ids, { pinned: on });
  }
  /** Set the same personal fields on several visible sessions in one transaction. */
  private personalize(ids: string[], fields: Partial<Session>) {
    const read = this.db.prepare('SELECT data FROM personal WHERE id=?');
    const write = this.db.prepare('INSERT OR REPLACE INTO personal VALUES (?,?)');
    const prefs = this.preferences();
    this.db.exec('BEGIN');
    try {
      for (const id of ids) {
        this.stored(id, prefs);
        const row = read.get(id) as { data: string } | undefined;
        write.run(id, JSON.stringify({ ...(row ? JSON.parse(row.data) : {}), ...fields }));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  /** Matches what the reader sees: sessions are searched in `locale`. */
  search(query: string, provider?: Provider, locale: Locale = getLocale()): SearchHit[] {
    const q = query.trim().slice(0, 200);
    if (!q)
      return this.list(false, locale)
        .filter((s) => !provider || s.provider === provider)
        .slice(0, 40)
        .map((session) => ({ session, snippet: session.action, eventId: null }));
    // Literal substring matching also supports Korean partial words and punctuation. Bounded local corpus.
    const terms = q.toLocaleLowerCase().split(/\s+/);
    const hits: SearchHit[] = [];
    for (const s of this.list(true, locale)) {
      if (provider && s.provider !== provider) continue;
      const base = [s.title, s.alias, s.project, s.notes, s.cwd ?? '', s.model ?? '']
        .join(' ')
        .toLowerCase();
      const combined =
        base +
        ' ' +
        s.events
          .map((e) => e.text)
          .join(' ')
          .toLowerCase();
      if (!terms.every((t) => combined.includes(t))) continue;
      const event = s.events.find((e) => terms.some((t) => e.text.toLowerCase().includes(t)));
      const text = event?.text ?? s.notes ?? s.title;
      const at = Math.max(0, text.toLowerCase().indexOf(terms[0]) - 70);
      hits.push({
        session: { ...s, events: s.events.slice(-4) },
        snippet: text.slice(at, at + 280),
        eventId: event?.id ?? null,
      });
      if (hits.length >= 50) break;
    }
    return hits;
  }
  /**
   * Handoff Markdown in `locale`, from one read of the session. Errors use the active language,
   * which can differ (the MCP server answers agents in English but writes the office language).
   */
  handoff(id: string, revision: string, locale: Locale = getLocale()): Handoff {
    const s = this.get(id, locale);
    if (s.revision !== revision) throw new Error(m().server.store.changed);
    const excerpts = s.events
      .filter((e) => ['user', 'assistant', 'lifecycle'].includes(e.kind))
      .slice(-8);
    const t = messagesFor(locale).server.handoff;
    const f = t.field;
    const markdown = redact(
      [
        `# ${t.title(s.alias || s.title)}`,
        ``,
        `> ${t.disclaimer}`,
        ``,
        `- ${f.tool}: ${s.provider}`,
        `- ${f.session}: ${s.nativeId}`,
        `- ${f.project}: ${s.project}`,
        `- ${f.location}: ${s.cwd ?? t.unknown}`,
        `- ${f.branch}: ${s.branch ?? t.unknown}`,
        `- ${f.model}: ${s.model ?? t.notCollected}`,
        `- ${f.lastActivity}: ${new Date(s.updatedAt).toISOString()}`,
        `- ${f.snapshot}: ${s.revision}`,
        `- ${f.scope}: ${s.partial ? t.partial : t.full}`,
        ``,
        `## ${t.notes}`,
        s.notes || t.noNotes,
        ``,
        `## ${t.evidence}`,
        ...excerpts.flatMap((e) => [
          ``,
          `### ${e.kind} · ${new Date(e.at).toISOString()}`,
          `${t.source}: ${e.sourceRef}`,
          e.text
            .slice(0, 1500)
            .split('\n')
            .map((l) => '> ' + l)
            .join('\n'),
        ]),
        ``,
        `## ${t.results}`,
        ...s.artifacts.map((a) => '- ' + a),
        s.artifacts.length ? '' : t.noResults,
        ``,
        `## ${t.next}`,
        `- ${t.nextSource}`,
        `- ${t.nextDone}`,
      ].join('\n'),
      18000,
      locale,
    );
    return { markdown, revision: s.revision, createdAt: Date.now() };
  }
}
