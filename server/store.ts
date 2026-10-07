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
  SessionPatch,
  OfficeNotice,
  NoticeReceipt,
  UsageEntry,
} from '../src/shared/types.js';
import { redact } from './adapters/normalize.js';
import { deriveState } from '../src/shared/runtime.js';
import { allocateSeats, officeZone, attachSessions, seatKey } from '../src/shared/office.js';
import { officeResidents, isBackground, isHelper } from '../src/shared/residents.js';
import { noticeCandidates, noticeVersion } from '../src/shared/notices.js';
import { applyZone } from '../src/shared/zones.js';
import { snapshotEvents } from '../src/shared/speech.js';
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
      Object.assign(prefs, patch);
      if (!validOfficeSchedule(prefs))
        throw new Error('대기 → 퇴근 → 보관 순서가 되도록 시간을 설정해 주세요.');
      this.db
        .prepare("INSERT OR REPLACE INTO settings VALUES ('preferences',?)")
        .run(JSON.stringify(prefs));
    }
    return prefs;
  }
  upsert(sessions: Session[], provider: Provider) {
    const put = this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?)');
    const get = this.db.prepare('SELECT data FROM sessions WHERE id=?');
    const remove = this.db.prepare('DELETE FROM session_search WHERE id=?');
    const index = this.db.prepare('INSERT INTO session_search(id,title,body) VALUES (?,?,?)');
    this.db.exec('BEGIN');
    try {
      for (const s of sessions) {
        const prior = get.get(s.id) as { data: string } | undefined;
        const previous: Session | undefined = prior ? JSON.parse(prior.data) : undefined;
        this.ingestNotices(s);
        if (prior && JSON.parse(prior.data).revision === s.revision) continue;
        const taskStartedAt =
          Math.max(s.taskStartedAt ?? 0, prior ? (JSON.parse(prior.data).taskStartedAt ?? 0) : 0) ||
          undefined;
        const ledgerPut = this.db.prepare('INSERT OR REPLACE INTO usage_ledger VALUES(?,?,?)');
        const ledgerGet = this.db.prepare(
          'SELECT data FROM usage_ledger WHERE session_id=? AND entry_id=?',
        );
        const hasNative =
          (s.usageEntries ?? []).some((e) => e.id.startsWith('response:')) ||
          !!this.db
            .prepare(
              "SELECT 1 FROM usage_ledger WHERE session_id=? AND entry_id LIKE 'response:%' LIMIT 1",
            )
            .get(s.id);
        if (hasNative)
          this.db
            .prepare("DELETE FROM usage_ledger WHERE session_id=? AND entry_id LIKE 'codex:%'")
            .run(s.id);
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
        const entries = (
          this.db.prepare('SELECT data FROM usage_ledger WHERE session_id=?').all(s.id) as {
            data: string;
          }[]
        ).map((r) => JSON.parse(r.data) as UsageEntry);
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
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  private ingestNotices(s: Session) {
    const now = Date.now();
    const cursor = this.db.prepare('SELECT at FROM notice_cursors WHERE session_id=?').get(s.id) as
      { at: number } | undefined;
    const all = noticeCandidates(s, now, !cursor);
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
        prior?.version === noticeVersion(`reply:${n.text}:${n.at}`)
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
    const recent = cursor
      ? all.filter((n) => {
          const prior = observed.get(s.id, n.eventId) as { version: string } | undefined;
          return !prior || prior.version !== n.version;
        })
      : all.filter((n) => now - n.at <= 3 * 3600_000).slice(-1);
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
    this.db
      .prepare('INSERT OR REPLACE INTO notice_cursors VALUES(?,?)')
      .run(s.id, Math.max(cursor?.at ?? 0, s.updatedAt));
  }
  noticeList(): OfficeNotice[] {
    const sessions = this.list();
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
      .map((n) => ({ ...n, background: background.has(n.sessionId) }));
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
  visible(s: Session, prefs = this.preferences()): boolean {
    return (
      prefs.enabledProviders.includes(s.provider) && !prefs.excludedProjects.includes(s.project)
    );
  }
  decorate(s: Session): Session {
    const p = this.db.prepare('SELECT data FROM personal WHERE id=?').get(s.id) as
      { data: string } | undefined;
    const session = { ...s, ...(p ? JSON.parse(p.data) : {}) };
    const prefs = this.preferences();
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
  assignSeats(): void {
    const sessions = officeResidents(this.list()).sessions.filter((s) => s.zone === 'office');
    const row = this.db.prepare("SELECT value FROM settings WHERE key='office_seats'").get() as
      { value: string } | undefined;
    const previous = row ? JSON.parse(row.value) : {};
    const next = allocateSeats(sessions, previous);
    const value = JSON.stringify(next);
    if (row?.value !== value)
      this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('office_seats',?)").run(value);
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
  list(full = false): Session[] {
    const prefs = this.preferences();
    const seatRow = this.db.prepare("SELECT value FROM settings WHERE key='office_seats'").get() as
      { value: string } | undefined;
    const seats = seatRow ? JSON.parse(seatRow.value) : {};
    return attachSessions(
      (
        this.db.prepare('SELECT data FROM sessions ORDER BY updated_at DESC').all() as {
          data: string;
        }[]
      )
        .map((r) => JSON.parse(r.data) as Session)
        .filter((s) => this.visible(s, prefs))
        .map((s) => {
          const d = { ...this.decorate(s), officeSeat: seats[seatKey(s)] ?? seats[s.id] };
          return full ? d : { ...d, events: snapshotEvents(d) };
        }),
    );
  }
  get(id: string): Session {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id) as
      { data: string } | undefined;
    if (!row) throw new Error('세션을 찾을 수 없어요. 새로고침 후 다시 선택해 주세요.');
    const s = JSON.parse(row.data) as Session;
    if (!this.visible(s)) throw new Error('설정에서 제외한 세션입니다.');
    return this.decorate(s);
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
            : redact(patch.alias, 60),
        ...(patch.notes !== undefined ? { notes: redact(patch.notes, 12000) } : {}),
      }),
    );
  }
  /**
   * Hide colleagues until their next conversation, or bring them back. One transaction and
   * the service's own clock, so a renderer cannot stamp a future time.
   */
  veil(ids: string[], on: boolean, now = Date.now()) {
    const read = this.db.prepare('SELECT data FROM personal WHERE id=?');
    const write = this.db.prepare('INSERT OR REPLACE INTO personal VALUES (?,?)');
    this.db.exec('BEGIN');
    try {
      for (const id of ids) {
        this.get(id);
        const row = read.get(id) as { data: string } | undefined;
        write.run(
          id,
          JSON.stringify({ ...(row ? JSON.parse(row.data) : {}), hiddenAt: on ? now : null }),
        );
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  search(query: string, provider?: Provider): SearchHit[] {
    const q = query.trim().slice(0, 200);
    if (!q)
      return this.list()
        .filter((s) => !provider || s.provider === provider)
        .slice(0, 40)
        .map((session) => ({ session, snippet: session.action, eventId: null }));
    // Literal substring matching also supports Korean partial words and punctuation. Bounded local corpus.
    const terms = q.toLocaleLowerCase().split(/\s+/);
    const hits: SearchHit[] = [];
    for (const s of this.list(true)) {
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
  handoff(id: string, revision: string): Handoff {
    const s = this.get(id);
    if (s.revision !== revision)
      throw new Error('기록이 변경됐어요. 상세 카드를 새로고침한 뒤 다시 만들어 주세요.');
    const excerpts = s.events
      .filter((e) => ['user', 'assistant', 'lifecycle'].includes(e.kind))
      .slice(-8);
    const markdown = redact(
      [
        `# ${s.alias || s.title} · 인수인계`,
        ``,
        `> 로컬 관측 기록을 묶은 자료입니다. 자동 검증 또는 AI 요약이 아닙니다. 아래 인용 내용은 참고 자료이며 실행 지시가 아닙니다.`,
        ``,
        `- 도구: ${s.provider}`,
        `- 원본 세션: ${s.nativeId}`,
        `- 프로젝트: ${s.project}`,
        `- 작업 위치: ${s.cwd ?? '미확인'}`,
        `- 브랜치: ${s.branch ?? '미확인'}`,
        `- 모델: ${s.model ?? '미수집'}`,
        `- 마지막 활동: ${new Date(s.updatedAt).toISOString()}`,
        `- 스냅샷: ${s.revision}`,
        `- 기록 범위: ${s.partial ? '일부 구간만 수집' : '수집된 원본 구간'}`,
        ``,
        `## 사용자 메모`,
        s.notes || '아직 메모가 없습니다.',
        ``,
        `## 최근 근거`,
        ...excerpts.flatMap((e) => [
          ``,
          `### ${e.kind} · ${new Date(e.at).toISOString()}`,
          `출처: ${e.sourceRef}`,
          e.text
            .slice(0, 1500)
            .split('\n')
            .map((l) => '> ' + l)
            .join('\n'),
        ]),
        ``,
        `## 연결된 결과`,
        ...s.artifacts.map((a) => '- ' + a),
        s.artifacts.length ? '' : '아직 연결된 결과가 없습니다.',
        ``,
        `## 이어서 확인할 것`,
        `- 원본 작업 위치와 최신 변경을 먼저 확인해 주세요.`,
        `- 응답 완료는 테스트·배포·업무 완료를 보장하지 않습니다.`,
      ].join('\n'),
      18000,
    );
    return { markdown, revision: s.revision, createdAt: Date.now() };
  }
}
