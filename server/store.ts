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
  NoticePage,
  NoticePageRequest,
  NoticeQuery,
  DetailPage,
  SessionDetail,
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
  unreadNoticeCount,
} from '../src/shared/notices.js';
import {
  matchesQuery,
  noticeOrder,
  pageNotices,
  residentNotices,
} from '../src/shared/notice-pages.js';
import { detailPage } from '../src/shared/conversation-pages.js';
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
/** A notice read more than 30 days ago is no longer listed. */
const fresh = (n: OfficeNotice) => !n.seenAt || Date.now() - n.seenAt < 30 * 86400_000;
const isBusy = (e: unknown) =>
  /database is locked|SQLITE_BUSY/i.test(e instanceof Error ? e.message : String(e));
/** Startup only: block this thread briefly (the collector runs in its own worker). */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Sessions newest first, then by id: one total order on disk and in memory alike. */
const byIdDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
/** Usage ledger access for one session: on disk, or staged in memory by the hot path. */
interface LedgerIO {
  hasNative(): boolean;
  dropFallback(): void;
  get(entryId: string): UsageEntry | undefined;
  put(entry: UsageEntry): void;
  all(): UsageEntry[];
}
/** Notice, observation and cursor access for one session: on disk, or staged in memory. */
interface NoticeIO {
  cursor(): number | undefined;
  setCursor(at: number): void;
  /** Observed versions by event id; kept current by `setVersion`. */
  versions(): Map<string, string>;
  setVersion(eventId: string, version: string): void;
  get(id: string): OfficeNotice | undefined;
  put(n: OfficeNotice): void;
  del(id: string): void;
  /** Ids of notices with a phase, and unphased replies/progress (legacy rows to reclassify). */
  phases(): { phased: Set<string>; unphased: Map<string, OfficeNotice> };
  before(at: number): OfficeNotice[];
  /** Unresolved calls. */
  openCalls(): OfficeNotice[];
}
/** A session the hot path took in without writing it yet (`OfficeStore.stage`). */
interface Staged {
  provider: Provider;
  /** The row as `upsert` will store it, and what the office keeps of it. */
  row: Session;
  resident: Session;
  /** Notices written (null: deleted) since the disk. */
  notices: Map<string, OfficeNotice | null>;
  versions: Map<string, string> | null;
  /** Event ids whose observed version moved. */
  observed: Set<string>;
  cursor: number | undefined;
  /** The session's notices and cursor on disk when it was first staged (null: no cursor). */
  disk?: Map<string, OfficeNotice>;
  diskCursor?: number | null;
  ledger: { entries: Map<string, UsageEntry>; dirty: Set<string>; dropped: boolean } | null;
}
export class OfficeStore {
  db: DatabaseSync;
  /**
   * Writer only: stored sessions already parsed, by id. Our own writes drop their ids (upsert),
   * a commit from another connection (a dev server or second app on the same data) drops all of
   * them (`PRAGMA data_version`, compared on this one connection). A read-only store (MCP) has
   * no cache and always reads what is on disk. Returned sessions share these objects (and their
   * events, workspace, usage): callers treat what `list`/`officeView` return as read-only.
   */
  private cached: Map<string, Session> | null = null;
  private dataVersion = -1;
  /**
   * Sessions whose notices this run already took in, by revision and event ids. Each collector
   * run takes every session in once (a newer collector may classify notices differently), then
   * an unchanged session costs nothing.
   */
  private ingested = new Map<string, string>();
  /**
   * Sessions the collector's hot path took in since their provider was last written, by id: read
   * by every query of this store, written by the next `upsert` of that provider (or on close).
   */
  private staged = new Map<string, Staged>();
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
    // What the hot path showed is written before the store goes (best effort: the next run
    // re-derives every session from its source anyway).
    try {
      if (this.staged.size) this.persistStaged();
    } catch {
      /* the database is locked or gone: nothing more to do */
    }
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
  /**
   * Stores one provider's collected sessions. A full pass (`partial` false) is the provider's
   * whole list: stored sessions missing from it are deleted. A `partial` pass writes only the
   * sessions it carries and leaves every other one as it is. Either way, what the hot path staged
   * in memory for these sessions (all of the provider's, on a full pass) is written first, exactly
   * as it was shown, then the sessions are taken in as always.
   */
  upsert(sessions: Session[], provider: Provider, partial = false) {
    const put = this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?)');
    const get = this.db.prepare('SELECT data FROM sessions WHERE id=?');
    const remove = this.db.prepare('DELETE FROM session_search WHERE id=?');
    const index = this.db.prepare('INSERT INTO session_search(id,title,body) VALUES (?,?,?)');
    const standbyHours = this.preferences().standbyHours ?? DEFAULT_PREFS.standbyHours!;
    const ids = new Set(sessions.map((s) => s.id));
    const staged = [...this.staged].filter(([id, x]) =>
      partial ? ids.has(id) : x.provider === provider,
    );
    this.db.exec('BEGIN');
    try {
      for (const [id, x] of staged) this.flushStaged(id, x);
      for (const s of sessions) {
        const prior = get.get(s.id) as { data: string } | undefined;
        const previous: Session | undefined = prior ? JSON.parse(prior.data) : undefined;
        // What the stored form builds on: the staged row if the hot path showed one.
        const base = this.staged.get(s.id)?.row ?? previous;
        // Unchanged since this run took it in: nothing about its notices can become new with time
        // alone (time only retires old requests), so a quiet cycle writes nothing.
        const seen = `${s.revision}\n${s.events.map((e) => e.id).join('\n')}`;
        // A place stored by the old cd rule is rewritten even when the record didn't change.
        const legacyPlace = ['shell-cd', 'tool-workdir'].includes(
          previous?.workingLocation?.source ?? '',
        );
        // A staged version that differs (e.g. a live wait the hot path showed and that ended
        // before this pass) still has to be taken in over: its notices may need resolving.
        const stagedOther = !!base && base !== previous && base.revision !== s.revision;
        if (
          previous?.revision === s.revision &&
          this.ingested.get(s.id) === seen &&
          !legacyPlace &&
          !stagedOther
        )
          continue;
        this.ingestNotices(s, this.noticesOnDisk(s.id), standbyHours);
        this.ingested.set(s.id, seen);
        if (previous?.revision === s.revision && !legacyPlace) continue;
        this.cached?.delete(s.id);
        const row = this.storedForm(s, base, this.ledgerOnDisk(s.id));
        put.run(s.id, provider, row.project, s.updatedAt, JSON.stringify(row));
        remove.run(s.id);
        index.run(
          s.id,
          s.title,
          [s.project, s.cwd, s.model, ...s.events.map((e) => e.text)].filter(Boolean).join('\n'),
        );
      }
      const present = new Set(sessions.map((s) => s.id));
      for (const row of (partial
        ? []
        : this.db.prepare('SELECT id FROM sessions WHERE provider=?').all(provider)) as {
        id: string;
      }[]) {
        if (!present.has(row.id)) {
          this.db.prepare('DELETE FROM sessions WHERE id=?').run(row.id);
          remove.run(row.id);
          this.cached?.delete(row.id);
          this.ingested.delete(row.id);
        }
      }
      this.db.exec('COMMIT');
      for (const [id] of staged) this.staged.delete(id);
    } catch (e) {
      this.db.exec('ROLLBACK');
      // Nothing of this pass was kept: take everything in again next time (staged stays staged).
      this.ingested.clear();
      this.cached?.clear();
      throw e;
    }
  }
  /**
   * The collector's hot path: takes these sessions in exactly as `upsert` would (stored form,
   * usage, notices with the person's receipts) but only in memory. Every read of this store sees
   * them at once; the next `upsert` of their provider writes them. Nothing here touches the disk.
   */
  stage(sessions: Session[], provider: Provider) {
    const standbyHours = this.preferences().standbyHours ?? DEFAULT_PREFS.standbyHours!;
    for (const s of sessions) {
      let x = this.staged.get(s.id);
      const base =
        x?.row ??
        (() => {
          const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(s.id) as
            { data: string } | undefined;
          return row ? (JSON.parse(row.data) as Session) : undefined;
        })();
      if (base?.revision === s.revision) continue;
      x ??= {
        provider,
        row: base!,
        resident: base!,
        notices: new Map(),
        versions: null,
        observed: new Set(),
        cursor: undefined,
        ledger: null,
      };
      this.ingestNotices(s, this.noticesStaged(s.id, x), standbyHours);
      const row = this.storedForm(s, base, this.ledgerStaged(s.id, x));
      Object.assign(x, { row, resident: { ...row, events: snapshotEvents(row) } });
      this.staged.set(s.id, x);
    }
  }
  /** Writes what the hot path staged for one session: notices, observations, cursor, usage. */
  private flushStaged(id: string, x: Staged) {
    const put = this.db.prepare('INSERT OR REPLACE INTO notices VALUES(?,?,?,?)');
    const drop = this.db.prepare('DELETE FROM notices WHERE id=?');
    for (const [nid, n] of x.notices)
      if (n) put.run(n.id, n.sessionId, n.at, JSON.stringify(n));
      else drop.run(nid);
    const remember = this.db.prepare('INSERT OR REPLACE INTO notice_observed VALUES(?,?,?)');
    for (const eventId of x.observed) remember.run(id, eventId, x.versions!.get(eventId)!);
    if (x.cursor !== undefined)
      this.db.prepare('INSERT OR REPLACE INTO notice_cursors VALUES(?,?)').run(id, x.cursor);
    if (x.ledger) {
      if (x.ledger.dropped)
        this.db
          .prepare("DELETE FROM usage_ledger WHERE session_id=? AND entry_id LIKE 'codex:%'")
          .run(id);
      const ledgerPut = this.db.prepare('INSERT OR REPLACE INTO usage_ledger VALUES(?,?,?)');
      for (const entryId of x.ledger.dirty)
        ledgerPut.run(id, entryId, JSON.stringify(x.ledger.entries.get(entryId)));
    }
  }
  /** Writes everything staged (sessions included), e.g. before the store closes. */
  persistStaged() {
    const byProvider = new Map<Provider, Session[]>();
    for (const x of this.staged.values())
      byProvider.set(x.provider, [...(byProvider.get(x.provider) ?? []), x.row]);
    // One provider failing (rolled back, still staged) does not keep the others from being written.
    let failure: unknown;
    for (const [provider, rows] of byProvider)
      try {
        this.upsert(rows, provider, true);
      } catch (e) {
        failure ??= e;
      }
    if (failure) throw failure;
  }
  /** Sessions staged by the hot path and not yet written (for tests and diagnostics). */
  stagedIds(): string[] {
    return [...this.staged.keys()];
  }
  /**
   * The row `upsert` stores for `s` over `previous`: usage taken into the ledger (`ledger`) and
   * summed, the working location kept from `previous` when a partial tail lost its evidence.
   */
  private storedForm(s: Session, previous: Session | undefined, ledger: LedgerIO): Session {
    const taskStartedAt = Math.max(s.taskStartedAt ?? 0, previous?.taskStartedAt ?? 0) || undefined;
    const hasNative =
      (s.usageEntries ?? []).some((e) => e.id.startsWith('response:')) || ledger.hasNative();
    if (hasNative) ledger.dropFallback();
    for (const entry of s.usageEntries ?? []) {
      if (hasNative && entry.id.startsWith('codex:')) continue;
      const prev = ledger.get(entry.id);
      // Streaming snapshots sometimes regress; preserve the fullest message.
      if (!prev || entry.output >= prev.output)
        ledger.put({ ...entry, model: entry.model ?? prev?.model ?? null });
    }
    const { usageEntries: _transient, ...stored } = s;
    // A partial tail may miss the evidence; keep the last one — but never an old cd-based guess.
    const retainLocation =
      !s.workingLocation &&
      s.windowed &&
      ['file-edit', 'git-write'].includes(previous?.workingLocation?.source ?? '') &&
      previous?.workingLocation;
    const location = s.workingLocation ?? (retainLocation ? previous?.workingLocation : undefined);
    const workspace = retainLocation ? previous?.workspace : s.workspace;
    const project = retainLocation ? previous!.project : s.project;
    // As stored and read back: a JSON round trip, so a staged row is the row the disk will hold.
    return JSON.parse(
      JSON.stringify({
        ...stored,
        workingLocation: location,
        workspace,
        project,
        cost: summarizeCost(ledger.all()),
        taskStartedAt,
      }),
    );
  }
  private ledgerOnDisk(id: string): LedgerIO {
    return {
      hasNative: () =>
        !!this.db
          .prepare(
            "SELECT 1 FROM usage_ledger WHERE session_id=? AND entry_id LIKE 'response:%' LIMIT 1",
          )
          .get(id),
      dropFallback: () =>
        void this.db
          .prepare("DELETE FROM usage_ledger WHERE session_id=? AND entry_id LIKE 'codex:%'")
          .run(id),
      get: (entryId) => {
        const row = this.db
          .prepare('SELECT data FROM usage_ledger WHERE session_id=? AND entry_id=?')
          .get(id, entryId) as { data: string } | undefined;
        return row ? JSON.parse(row.data) : undefined;
      },
      put: (entry) =>
        void this.db
          .prepare('INSERT OR REPLACE INTO usage_ledger VALUES(?,?,?)')
          .run(id, entry.id, JSON.stringify(entry)),
      all: () =>
        (
          this.db
            .prepare('SELECT data FROM usage_ledger WHERE session_id=? ORDER BY entry_id')
            .all(id) as { data: string }[]
        ).map((r) => JSON.parse(r.data) as UsageEntry),
    };
  }
  private ledgerStaged(id: string, x: Staged): LedgerIO {
    const ledger = (x.ledger ??= {
      entries: new Map(
        (
          this.db.prepare('SELECT entry_id, data FROM usage_ledger WHERE session_id=?').all(id) as {
            entry_id: string;
            data: string;
          }[]
        ).map((r) => [r.entry_id, JSON.parse(r.data) as UsageEntry]),
      ),
      dirty: new Set(),
      dropped: false,
    });
    return {
      hasNative: () => [...ledger.entries.keys()].some((k) => k.startsWith('response:')),
      dropFallback: () => {
        ledger.dropped = true;
        for (const k of [...ledger.entries.keys()])
          if (k.startsWith('codex:')) {
            ledger.entries.delete(k);
            ledger.dirty.delete(k);
          }
      },
      get: (entryId) => ledger.entries.get(entryId),
      put: (entry) => {
        // As the disk would hold it.
        ledger.entries.set(entry.id, JSON.parse(JSON.stringify(entry)));
        ledger.dirty.add(entry.id);
      },
      all: () =>
        [...ledger.entries.keys()]
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
          .map((k) => ledger.entries.get(k)!),
    };
  }
  /** One session's notices, observations and cursor as stored. */
  private noticesOnDisk(id: string): NoticeIO {
    const parse = (rows: { data: string }[]) => rows.map((r) => JSON.parse(r.data) as OfficeNotice);
    let versions: Map<string, string> | null = null;
    return {
      cursor: () =>
        (
          this.db.prepare('SELECT at FROM notice_cursors WHERE session_id=?').get(id) as
            { at: number } | undefined
        )?.at,
      setCursor: (at) =>
        void this.db.prepare('INSERT OR REPLACE INTO notice_cursors VALUES(?,?)').run(id, at),
      versions: () =>
        (versions ??= new Map(
          (
            this.db
              .prepare('SELECT event_id, version FROM notice_observed WHERE session_id=?')
              .all(id) as { event_id: string; version: string }[]
          ).map((r) => [r.event_id, r.version]),
        )),
      setVersion: (eventId, version) => {
        this.db
          .prepare('INSERT OR REPLACE INTO notice_observed VALUES(?,?,?)')
          .run(id, eventId, version);
        versions?.set(eventId, version);
      },
      get: (nid) => {
        const row = this.db.prepare('SELECT data FROM notices WHERE id=?').get(nid) as
          { data: string } | undefined;
        return row ? JSON.parse(row.data) : undefined;
      },
      put: (n) =>
        void this.db
          .prepare('INSERT OR REPLACE INTO notices VALUES(?,?,?,?)')
          .run(n.id, n.sessionId, n.at, JSON.stringify(n)),
      del: (nid) => void this.db.prepare('DELETE FROM notices WHERE id=?').run(nid),
      phases: () => {
        const phased = new Set<string>();
        const unphased = new Map<string, OfficeNotice>();
        for (const r of this.db
          .prepare(
            "SELECT id, COALESCE(json_extract(data,'$.phase'),'')<>'' AS phased, CASE WHEN COALESCE(json_extract(data,'$.phase'),'')='' AND json_extract(data,'$.kind') IN ('reply','progress') THEN data END AS legacy FROM notices WHERE session_id=?",
          )
          .all(id) as { id: string; phased: number; legacy: string | null }[]) {
          if (r.phased) phased.add(r.id);
          if (r.legacy !== null) unphased.set(r.id, JSON.parse(r.legacy));
        }
        return { phased, unphased };
      },
      before: (at) =>
        parse(
          this.db.prepare('SELECT data FROM notices WHERE session_id=? AND at<?').all(id, at) as {
            data: string;
          }[],
        ),
      openCalls: () =>
        parse(
          this.db
            .prepare(
              "SELECT data FROM notices WHERE session_id=? AND json_extract(data,'$.kind')='attention' AND json_extract(data,'$.resolvedAt') IS NULL",
            )
            .all(id) as { data: string }[],
        ),
    };
  }
  /** The same, for the hot path: reads the disk under what is staged, writes only to `x`. */
  private noticesStaged(id: string, x: Staged): NoticeIO {
    const disk = this.noticesOnDisk(id);
    // The session's notices as on disk, read once while it stays staged; receipts on them go to
    // `x.notices` too (`noticeById`), so this copy never goes stale.
    const stored = (x.disk ??= new Map(
      (
        this.db.prepare('SELECT data FROM notices WHERE session_id=?').all(id) as {
          data: string;
        }[]
      ).map((r) => {
        const n = JSON.parse(r.data) as OfficeNotice;
        return [n.id, n];
      }),
    ));
    /** Those with the staged ones laid over them. */
    const current = () => [
      ...[...stored.values()].filter((n) => !x.notices.has(n.id)),
      ...[...x.notices.values()].filter((n): n is OfficeNotice => !!n),
    ];
    if (x.cursor === undefined && x.diskCursor === undefined) x.diskCursor = disk.cursor() ?? null;
    return {
      cursor: () => x.cursor ?? x.diskCursor ?? undefined,
      setCursor: (at) => void (x.cursor = at),
      versions: () => (x.versions ??= new Map(disk.versions())),
      setVersion: (eventId, version) => {
        (x.versions ??= new Map(disk.versions())).set(eventId, version);
        x.observed.add(eventId);
      },
      get: (nid) => (x.notices.has(nid) ? (x.notices.get(nid) ?? undefined) : stored.get(nid)),
      put: (n) => void x.notices.set(n.id, JSON.parse(JSON.stringify(n))),
      del: (nid) => void x.notices.set(nid, null),
      phases: () => {
        const phased = new Set<string>();
        const unphased = new Map<string, OfficeNotice>();
        for (const n of current())
          if (n.phase) phased.add(n.id);
          else if (['reply', 'progress'].includes(n.kind)) unphased.set(n.id, n);
        return { phased, unphased };
      },
      before: (at) => current().filter((n) => n.at < at),
      openCalls: () => current().filter((n) => n.kind === 'attention' && n.resolvedAt == null),
    };
  }
  /** The session's notices with what the hot path staged laid over them, in `noticeOrder`. */
  private withStagedNotices(rows: OfficeNotice[], sessionIds?: Set<string>): OfficeNotice[] {
    const staged = [...this.staged].filter(
      ([id, x]) => x.notices.size && (!sessionIds || sessionIds.has(id)),
    );
    if (!staged.length) return rows;
    const replaced = new Set(staged.flatMap(([, x]) => [...x.notices.keys()]));
    return rows
      .filter((n) => !replaced.has(n.id))
      .concat(
        staged.flatMap(([, x]) => [...x.notices.values()].filter((n): n is OfficeNotice => !!n)),
      )
      .sort(noticeOrder);
  }
  /** A notice by id as the office sees it (staged first), and where to write a change to it. */
  private noticeById(id: string): { n: OfficeNotice; staged?: Staged } | undefined {
    for (const x of this.staged.values()) {
      if (x.notices.has(id)) {
        const n = x.notices.get(id);
        return n ? { n, staged: x } : undefined;
      }
      const n = x.disk?.get(id);
      if (n) return { n, staged: x };
    }
    const row = this.db.prepare('SELECT data FROM notices WHERE id=?').get(id) as
      { data: string } | undefined;
    return row ? { n: JSON.parse(row.data) } : undefined;
  }
  /**
   * A person's receipt (read, dismissed, viewed, unread) goes to disk at once, even for a notice
   * only the hot path has shown so far, so a quit before the next full pass cannot lose it. The
   * staged copy is updated too, so writing what was staged later writes the same notice.
   */
  private writeNotice(n: OfficeNotice, staged?: Staged) {
    this.db
      .prepare('INSERT OR REPLACE INTO notices VALUES(?,?,?,?)')
      .run(n.id, n.sessionId, n.at, JSON.stringify(n));
    if (!staged) return;
    if (staged.notices.has(n.id)) staged.notices.set(n.id, n);
    else staged.disk?.set(n.id, n);
  }
  private ingestNotices(s: Session, io: NoticeIO, standbyHours = DEFAULT_PREFS.standbyHours!) {
    const now = Date.now();
    const cursor = io.cursor();
    // A conversation first seen within minutes of its start is live, not history: its first
    // request and replies are news (the arrival plays), unlike an old session found on scan.
    const born = cursor === undefined && now - s.startedAt < NEW_SESSION_MS;
    const all = noticeCandidates(s, now, cursor === undefined && !born);
    // Parser upgrades must not turn already-read messages into fresh notices.
    // Transfer ONLY when the old ordinal key has exactly the same content version.
    const legacyIds = new Map(s.events.filter((e) => e.legacyId).map((e) => [e.id, e.legacyId!]));
    for (const n of all) {
      const legacy = legacyIds.get(n.eventId);
      if (!legacy) continue;
      if (io.versions().get(legacy) === n.version) io.setVersion(n.eventId, n.version);
      const oldId = `${s.id}::${legacy}`;
      const old = io.get(oldId);
      if (!old || io.get(n.id)) continue;
      if (old.version !== n.version) continue;
      io.put({ ...old, id: n.id, eventId: n.eventId });
      io.del(oldId);
    }
    // What this session's events were last observed as, read once; written only when it moves
    // (rewriting the same version every pass was most of a busy colleague's write cost).
    const versions = io.versions();
    const observe = (eventId: string, version: string) => {
      if (versions.get(eventId) !== version) io.setVersion(eventId, version);
    };
    // Classify legacy replies without turning a parser upgrade into a fresh notification.
    // Old rows outside the retained source window stay available in All, but never count as finals.
    // Stored notices with a phase need nothing here; unphased replies/progress may be reclassified.
    const { phased, unphased } = io.phases();
    for (const n of all) {
      // Legacy unphased assistants used the reply kind, even when bootstrap suppressed
      // their notice rows. Advance that cursor too, rather than backfilling old progress.
      if (
        !phased.has(n.id) &&
        n.kind !== 'reply' &&
        versions.get(n.eventId) === noticeContentVersion('reply', n.text, n.at)
      )
        observe(n.eventId, n.version);
      const old = unphased.get(n.id);
      if (old && old.text === n.text && old.at === n.at)
        io.put({ ...old, kind: n.kind, phase: n.phase, version: n.version });
    }
    // An unanswered request older than the off-duty time belongs to a colleague who has gone
    // home (STATUS-POLICY §3): history, not news. E.g. a plan approval abandoned days ago that a
    // newer collector recognizes for the first time. It is remembered below, never notified.
    const news = all.filter((n) => n.kind !== 'attention' || now - n.at < standbyHours * 3600_000);
    const recent =
      cursor !== undefined || born
        ? news.filter((n) => versions.get(n.eventId) !== n.version)
        : news.filter((n) => now - n.at <= 3 * 3600_000).slice(-1);
    for (const n of all) observe(n.eventId, n.version);
    for (const n of recent) {
      const old = io.get(n.id);
      if (old?.version === n.version) continue;
      if (
        old &&
        !s.events.some((e) => e.id === n.eventId) &&
        old.text.startsWith(n.text.replace(/…$/, ''))
      )
        continue;
      io.put(
        old
          ? {
              ...n,
              receivedAt: now,
              bootstrap: old.bootstrap,
              seenAt: null,
              viewedAt: null,
              dismissedAt: null,
              resolvedAt: old.resolvedAt,
            }
          : n,
      );
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
      for (const n of io.before(resumed))
        if (!n.resolvedAt && ['attention', 'error'].includes(n.kind))
          io.put({ ...n, resolvedAt: resumed });
    // A request that is no longer open resolves its own cue: answered (its result), moved past,
    // or no longer waiting live (a permission prompt that was approved). Requests outside the
    // read window are left to the rule above.
    const open = new Set(all.filter((n) => n.kind === 'attention').map((n) => n.eventId));
    for (const n of io.openCalls()) {
      const request = s.events.find((e) => e.id === n.eventId);
      if (!request || open.has(n.eventId)) continue;
      const resolvedAt = requestClosedAt(s.events, request) ?? now;
      io.put({ ...n, resolvedAt });
    }
    io.setCursor(Math.max(cursor ?? 0, s.updatedAt));
  }
  /** Every visible notice in `locale`, in `noticeOrder`; stored rows stay canonical. */
  noticeList(
    locale: Locale = getLocale(),
    sessions: Session[] = this.list(false, CANONICAL),
  ): OfficeNotice[] {
    const visible = new Set(sessions.map((s) => s.id));
    const background = new Set(
      sessions.filter((s) => isBackground(s) || isHelper(s)).map((s) => s.id),
    );
    const rows = this.db.prepare('SELECT data FROM notices ORDER BY at DESC, id DESC').all() as {
      data: string;
    }[];
    return this.withStagedNotices(rows.map((r) => JSON.parse(r.data) as OfficeNotice))
      .filter((n) => visible.has(n.sessionId) && fresh(n))
      .map((n) => ({ ...localizeNotice(n, locale), background: background.has(n.sessionId) }));
  }
  /** What a snapshot carries: the notices the office needs live, and exact counts of all. */
  noticeView(
    locale: Locale = getLocale(),
    sessions: Session[] = this.list(false, CANONICAL),
  ): { notices: OfficeNotice[]; noticeStats: { unread: number; total: number } } {
    const all = this.noticeList(locale, sessions);
    return {
      notices: residentNotices(all),
      noticeStats: { unread: unreadNoticeCount(all), total: all.length },
    };
  }
  /** A page of the news by cursor: the same notices, rules and order as the snapshot's. */
  noticePage(request: NoticePageRequest, locale: Locale = getLocale()): NoticePage {
    return pageNotices(this.noticeList(locale), request);
  }
  /**
   * Marks every unread notice matching `query` read, carried in a snapshot or not, except those
   * received after `asOf` (the person had not seen them yet, nor a newer version of one).
   */
  noticeReadAll(query: NoticeQuery, asOf: number) {
    const now = Date.now();
    const ids = this.noticeList(CANONICAL)
      .filter((n) => matchesQuery(n, { ...query, includeRead: false }) && n.receivedAt <= asOf)
      .map((n) => n.id);
    this.db.exec('BEGIN');
    try {
      for (const id of ids) {
        const found = this.noticeById(id);
        if (found) this.writeNotice({ ...found.n, seenAt: now }, found.staged);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  noticeReceipt(receipts: NoticeReceipt[], action: 'read' | 'dismiss' | 'unread' | 'view') {
    for (const receipt of receipts) {
      // A notice the hot path showed may not be written yet: its receipt goes with it.
      const found = this.noticeById(receipt.id);
      if (!found) continue;
      const n = found.n;
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
      this.writeNotice(next, found.staged);
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
  /**
   * Stored sessions, newest first. The writer parses only rows it has not parsed yet and keeps
   * just what the office shows of each (`snapshotEvents`, a few events), never the whole
   * conversation: `full` reads (search, recovery) go to the database every time.
   */
  private rows(full = false): Session[] {
    const rows = this.diskRows(full);
    if (!this.staged.size) return rows;
    // Staged sessions in place of their rows, and in their place by time (a stable sort keeps
    // the database's order for everyone else).
    return rows
      .map((s) => {
        const x = this.staged.get(s.id);
        return x ? (full ? x.row : x.resident) : s;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt || byIdDesc(a.id, b.id));
  }
  private diskRows(full = false): Session[] {
    const parse = (rows: { data: string }[]) => rows.map((r) => JSON.parse(r.data) as Session);
    const resident = (s: Session): Session => ({ ...s, events: snapshotEvents(s) });
    if (!this.cached || full)
      return parse(
        this.db.prepare('SELECT data FROM sessions ORDER BY updated_at DESC, id DESC').all() as {
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
        this.db.prepare('SELECT data FROM sessions ORDER BY updated_at DESC, id DESC').all() as {
          data: string;
        }[],
      );
      const kept = all.map(resident);
      for (const s of kept) this.cached.set(s.id, s);
      return kept;
    }
    const read = this.db.prepare('SELECT data FROM sessions WHERE id=?');
    const ids = this.db
      .prepare('SELECT id FROM sessions ORDER BY updated_at DESC, id DESC')
      .all() as {
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
        s = resident(JSON.parse(row.data) as Session);
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
    return this.rows(full)
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
  /**
   * One provider's stored records exactly as collected: no settings, no visibility filter. For
   * the collector to keep what it could not read this pass (a hidden project's records included).
   */
  storedRecords(provider: Provider): Session[] {
    return (
      this.db.prepare('SELECT data FROM sessions WHERE provider=?').all(provider) as {
        data: string;
      }[]
    ).map((r) => {
      const s = JSON.parse(r.data) as Session;
      return this.staged.get(s.id)?.row ?? s;
    });
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
  officeView(locale: Locale = getLocale()): {
    sessions: Session[];
    notices: OfficeNotice[];
    noticeStats: { unread: number; total: number };
    /** Every visible notice the carried ones were chosen from (`noticeList`). */
    all: OfficeNotice[];
  } {
    const stored = this.seats();
    const base = this.decorated(false, stored);
    const listed = attachSessions(base);
    const seats = this.assignSeats(listed);
    const sessions =
      JSON.stringify(seats) === JSON.stringify(stored)
        ? listed
        : attachSessions(base.map((s) => ({ ...s, officeSeat: seats[seatKey(s)] ?? seats[s.id] })));
    const all = this.noticeList(locale, sessions);
    return {
      sessions: sessions.map((s) => localizeSession(s, locale)),
      notices: residentNotices(all),
      noticeStats: { unread: unreadNoticeCount(all), total: all.length },
      all,
    };
  }
  /**
   * One session as `officeView` lists it before attachment and localization: decorated with the
   * person's settings, seated, events cut to what the office shows. Null when it is not stored
   * or not visible. Reads one row, for a collector pass that changed only a few sessions.
   */
  officeRow(id: string): Session | null {
    const s = this.residentRow(id);
    if (!s) return null;
    const prefs = this.preferences();
    if (!this.visible(s, prefs)) return null;
    const seats = this.seats();
    const d = { ...this.decorate(s, prefs), officeSeat: seats[seatKey(s)] ?? seats[s.id] };
    return { ...d, events: snapshotEvents(d) };
  }
  /** Stored session ids in the order `officeView` lists them (newest first). */
  sessionOrder(): string[] {
    const rows = this.db
      .prepare('SELECT id, updated_at FROM sessions ORDER BY updated_at DESC, id DESC')
      .all() as {
      id: string;
      updated_at: number;
    }[];
    if (this.staged.size) {
      for (const r of rows) r.updated_at = this.staged.get(r.id)?.row.updatedAt ?? r.updated_at;
      rows.sort((a, b) => b.updated_at - a.updated_at || byIdDesc(a.id, b.id));
    }
    return rows.map((r) => r.id);
  }
  /**
   * `noticeList` for just these (visible) sessions, in `noticeOrder`: what a collector pass that
   * changed only them merges into the office's notices. `background` as `noticeList` marks it.
   */
  noticesOf(ids: string[], background: Set<string>, locale: Locale = getLocale()): OfficeNotice[] {
    const rows = (
      this.db
        .prepare(
          'SELECT data FROM notices WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY at DESC, id DESC',
        )
        .all(JSON.stringify(ids)) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as OfficeNotice);
    return this.withStagedNotices(rows, new Set(ids))
      .filter(fresh)
      .map((n) => ({ ...localizeNotice(n, locale), background: background.has(n.sessionId) }));
  }
  /** One stored row as `rows` keeps it, through the same cache and invalidation. */
  private residentRow(id: string): Session | null {
    const staged = this.staged.get(id);
    if (staged) return staged.resident;
    const read = () => {
      const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id) as
        { data: string } | undefined;
      if (!row) return null;
      const s = JSON.parse(row.data) as Session;
      return { ...s, events: snapshotEvents(s) };
    };
    if (!this.cached) return read();
    const { data_version: version } = this.db.prepare('PRAGMA data_version').get() as {
      data_version: number;
    };
    if (version !== this.dataVersion) {
      this.cached.clear();
      this.dataVersion = version;
    }
    let s = this.cached.get(id);
    if (!s) {
      const row = read();
      if (!row) return null;
      this.cached.set(id, (s = row));
    }
    return s;
  }
  /** The stored (canonical) session, if the person's settings let it be seen. */
  private stored(id: string, prefs: Preferences): Session {
    // What the hot path took in shows at once (an open work card reads the newest page).
    const staged = this.staged.get(id)?.row;
    const row = staged
      ? undefined
      : (this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id) as
          { data: string } | undefined);
    if (!staged && !row) throw new Error(m().server.store.notFound);
    const s = staged ?? (JSON.parse(row!.data) as Session);
    if (!this.visible(s, prefs)) throw new Error(m().server.store.excluded);
    return s;
  }
  get(id: string, locale: Locale = getLocale()): Session {
    const prefs = this.preferences();
    return localizeSession(this.decorate(this.stored(id, prefs), prefs), locale);
  }
  /**
   * One page of the conversation (the newest without `before`), with the same visibility as
   * `get`, and the session's notices the page's excerpts need.
   */
  detail(id: string, page: DetailPage = {}, locale: Locale = getLocale()): SessionDetail {
    const s = this.get(id, locale);
    const background = isBackground(s) || isHelper(s);
    const notices = this.withStagedNotices(
      (
        this.db
          .prepare('SELECT data FROM notices WHERE session_id=? ORDER BY at DESC, id DESC')
          .all(id) as { data: string }[]
      ).map((r) => JSON.parse(r.data) as OfficeNotice),
      new Set([id]),
    )
      .filter(fresh)
      .map((n) => ({ ...localizeNotice(n, locale), background }));
    return detailPage(s, page, notices);
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
