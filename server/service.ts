import { QuotaService } from './quotas.js';
import path from 'node:path';
import os from 'node:os';
import { stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  Connector,
  Mood,
  OfficeNotice,
  Preferences,
  Provider,
  Session,
  Snapshot,
  WorkspaceIdentity,
} from '../src/shared/types.js';
import { OfficeStore } from './store.js';
import { discover, type SourceFile } from './adapters/files.js';
import { RecordWindowCache } from './adapters/record-window.js';
import { parseRecords, hash } from './adapters/normalize.js';
import { codexMetadata, type CodexMeta } from './adapters/codex.js';
import { readOpenClawDatabases } from './adapters/openclaw.js';
import { artifactDetails } from './artifacts.js';
import { claudeMetadata, claudeSubagentMetadata } from './adapters/claude.js';
import {
  applyLiveWait,
  defaultLiveDeps,
  liveClaudeProcesses,
  liveWaitSignature,
  readClaudeProcessesCached,
  waitingClaudeProcesses,
  type ClaudeLiveDeps,
  type ClaudeProcess,
} from './adapters/claude-live.js';
import { mergeSessions } from './adapters/merge.js';
import { NOTICE_PAGE_MAX } from '../src/shared/notice-pages.js';
import { DETAIL_PAGE_MAX } from '../src/shared/conversation-pages.js';
import { BOOKMARK_NOTE, BOOKMARK_PAGE_MAX } from '../src/shared/bookmarks.js';
import {
  applyPatch,
  composePatches,
  diffSnapshot,
  indexSnapshot,
  type SnapshotIndex,
  type SnapshotPatch,
} from '../src/shared/snapshot-patch.js';
import { enrichWorkspaces, workspaceSignature } from './workspaces.js';
import { syncLocale } from './locale.js';
import { deriveState } from '../src/shared/runtime.js';
import { attachSessions, parentSession } from '../src/shared/office.js';
import { isBackground, isHelper, needsAttention } from '../src/shared/residents.js';
import { noticeOrder, residentNotices } from '../src/shared/notice-pages.js';
import { unreadNoticeCount } from '../src/shared/notices.js';
import {
  LOCALES,
  getLocale,
  m,
  type Locale,
  type LocalePreference,
} from '../src/shared/i18n/index.js';
import { CANONICAL, localizePreferences, localizeSession } from '../src/shared/canonical.js';
import { PET_CHARACTERS, PET_COLORS, PET_ACCESSORIES } from '../src/shared/pets.js';
import type { PetCharacter, PetColor, PetAccessory } from '../src/shared/pets.js';
const petLookSchema = z
  .object({
    character: z.enum(Object.keys(PET_CHARACTERS) as [PetCharacter, ...PetCharacter[]]),
    color: z.enum(Object.keys(PET_COLORS) as [PetColor, ...PetColor[]]),
    accessory: z.enum(Object.keys(PET_ACCESSORIES) as [PetAccessory, ...PetAccessory[]]),
  })
  .strict();
const providerSchema = z.enum(['claude', 'codex', 'openclaw']);
const patchSchema = z
  .object({
    alias: z.string().max(60).optional(),
    notes: z.string().max(12000).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    completed: z.boolean().optional(),
  })
  .strict();
const zoneRuleSchema = z
  .object({
    id: z.string().min(1).max(60),
    name: z.string().trim().min(1).max(40),
    match: z.enum(['session', 'worktree', 'path', 'branch']),
    value: z.string().trim().min(1).max(1000),
    repo: z.string().max(1000).optional(),
    target: z.string().max(1100).optional(),
  })
  .strict();
const prefsSchema = z
  .object({
    paused: z.boolean().optional(),
    privacy: z.boolean().optional(),
    reducedMotion: z.boolean().optional(),
    excludedProjects: z.array(z.string().max(150)).max(100).optional(),
    enabledProviders: z.array(providerSchema).max(3).optional(),
    maxSessions: z.number().int().min(10).max(300).optional(),
    standbyHours: z.number().int().min(1).max(2160).optional(),
    autoArchive: z.boolean().optional(),
    archiveDays: z.number().int().min(1).max(365).optional(),
    bubbleHours: z.number().int().min(1).max(24).optional(),
    readyMinutes: z.number().int().min(5).max(240).optional(),
    zoneRules: z.array(zoneRuleSchema).max(200).optional(),
    locale: z
      .enum(['auto', ...Object.keys(LOCALES)] as [LocalePreference, ...LocalePreference[]])
      .optional(),
    notifications: z
      .object({ finals: z.boolean(), calls: z.boolean(), sound: z.boolean() })
      .strict()
      .optional(),
    tinyNames: z.boolean().optional(),
    tinyFinalDot: z.boolean().optional(),
    dockPill: z.enum(['always', 'subdued', 'hover']).optional(),
    dockPillResetAt: z.number().int().min(0).optional(),
    panelWidthsResetAt: z.number().int().min(0).optional(),
    readOnOpen: z.boolean().optional(),
    readDwellSeconds: z.number().min(0).max(10).optional(),
    helperDesks: z.boolean().optional(),
    helperStackAt: z.number().int().min(2).max(8).optional(),
    helperRetainMinutes: z.number().int().min(5).max(240).optional(),
    tmuxSkipPermissions: z.boolean().optional(),
    textSize: z.enum(['small', 'normal', 'large', 'larger']).optional(),
    readingFont: z.enum(['system', 'pretendard', 'mono']).optional(),
    windowGlass: z.number().int().min(0).max(70).nullable().optional(),
    petAppearance: z
      .object({
        version: z.literal(1),
        providers: z
          .object({
            claude: petLookSchema.nullable().optional(),
            codex: petLookSchema.nullable().optional(),
            openclaw: petLookSchema.nullable().optional(),
          })
          .strict(),
        colleagues: z
          .record(z.string().min(1).max(500), petLookSchema.nullable())
          .refine((value) => Object.keys(value).length <= 3000, { error: () => m().pets.tooMany }),
      })
      .strict()
      .optional(),
  })
  .strict();
const detailPageSchema = z
  .object({
    before: z.string().max(1000).optional(),
    beforeAt: z.number().optional(),
    limit: z.number().int().min(1).max(DETAIL_PAGE_MAX).optional(),
    reach: z.string().max(1000).optional(),
    reachAt: z.number().optional(),
  })
  .strict();
const bookmarkQuerySchema = z
  .object({
    sessionIds: z.array(z.string().max(400)).max(500).optional(),
    text: z.string().max(200).optional(),
    before: z
      .object({ createdAt: z.number(), id: z.string().max(100) })
      .strict()
      .nullable()
      .optional(),
    limit: z.number().int().min(1).max(BOOKMARK_PAGE_MAX).optional(),
  })
  .strict();
const noteSchema = z.string().max(BOOKMARK_NOTE);
const noticeQueryShape = {
  filter: z.enum(['final', 'attention', 'all']),
  includeRead: z.boolean().optional(),
  includeBackground: z.boolean().optional(),
  sessionIds: z.array(z.string().max(400)).max(500).optional(),
};
const noticeQuerySchema = z.object(noticeQueryShape).strict();
const noticePageSchema = z
  .object({
    ...noticeQueryShape,
    before: z
      .object({ at: z.number(), id: z.string().max(1000) })
      .strict()
      .nullable()
      .optional(),
    limit: z.number().int().min(1).max(NOTICE_PAGE_MAX).optional(),
  })
  .strict();
/** A quiet office still reports that it checked, at this pace. */
const HEALTH_MS = 60_000;
/** Changes kept for pollers that fell behind; further back they get the whole office. */
const PATCH_HISTORY = 64;
/** Changes are kept only while a poller has asked recently (the desktop app never asks). */
const POLLER_MS = 60_000;
/** Whether a change is more than the check times moving on. */
function meaningful(change: ReturnType<typeof diffSnapshot>, before: Snapshot, after: Snapshot) {
  const { fields, ...parts } = change;
  if (Object.keys(parts).length) return true;
  const keys = Object.keys(fields ?? {}).filter((k) => k !== 'lastSync' && k !== 'connectors');
  if (keys.length) return true;
  const plain = (s: Snapshot) => JSON.stringify(s.connectors.map((c) => ({ ...c, lastSync: 0 })));
  return !!fields?.connectors && plain(before) !== plain(after);
}
/**
 * The hot path (#77): colleagues at work are re-read every `tickMs` (sooner on a file watch
 * hint) instead of waiting for the 5-second full pass. See PERFORMANCE-DESIGN §3.4.
 */
export interface HotOptions {
  /** How often hot files are stat'ed. */
  tickMs: number;
  /** One session is processed at most this often. */
  minMs: number;
  /** A file watch event waits this long for more before the session is processed. */
  debounceMs: number;
  /** A session stays hot this long after its final reply. */
  graceMs: number;
  /** At most this many sessions are hot; the rest wait for the full pass. */
  max: number;
  /** Watch hot files for changes (a hint only: the stat tick and the full pass still recover). */
  watch: boolean;
}
export const HOT_DEFAULTS: HotOptions = {
  tickMs: 1000,
  minMs: 1000,
  debounceMs: 150,
  graceMs: 10_000,
  max: 8,
  watch: true,
};
/** A timer tick may come this much early; it must not push an update a whole tick back. */
const TICK_SLACK_MS = 100;
const WORKING: ReadonlySet<Mood> = new Set(['work', 'think', 'call']);
const LIVE_ACTIVE: ReadonlySet<string> = new Set(['busy', 'waiting']);
/**
 * A JSONL session as the last pass stored it: enough to rebuild it from its files alone, reusing
 * what only the full pass looks up (names from metadata, the workspace from Git).
 */
interface KnownSession {
  id: string;
  provider: Provider;
  nativeId: string;
  /** Source files, in the order the full pass merged them. */
  files: string[];
  /** What `enrichWorkspaces` resolved the workspace from (see `place`). */
  place: string;
  workspace: WorkspaceIdentity | undefined;
  mood: Mood;
  updatedAt: number;
  /** `liveWaitSignature` of the wait applied last (Claude only). */
  wait: string;
}
/** Everything `enrichWorkspaces` reads of a session: equal places resolve to the same workspace. */
const place = (s: Session) =>
  JSON.stringify([s.provider, s.project, s.cwd, s.workingLocation?.path ?? null]);
/**
 * `enrichWorkspaces` for a session whose place has not moved, with the workspace it resolved
 * last time: the same workspace, project and revision, without Git.
 */
function placed(s: Session, last: WorkspaceIdentity | undefined): Session {
  const workspace = last?.locationSource ? { ...last, locationSource: s.workingLocation } : last;
  return {
    ...s,
    workspace,
    project: !workspace || workspace.evidence === 'unknown' ? s.project : workspace.name,
    revision: hash(`${s.revision}:${workspaceSignature(workspace)}`),
  };
}
/**
 * Whether a session's change leaves everyone else's place as it was: the same zone, standing
 * (pinned, archived, background or not and, if background, calling or not), identity and
 * relations, and no actor (an actor's runs share one desk). `was` as published, `now` decorated.
 */
function standsStill(was: Session, now: Session): boolean {
  const relation = (s: Session) =>
    JSON.stringify([
      s.provider,
      s.nativeId,
      s.sessionKey ?? null,
      s.agentName ?? null,
      s.parentId ?? null,
      s.relation?.kind ?? null,
      s.relation?.parentNativeId ?? null,
      s.relation?.parentSessionKey ?? null,
    ]);
  return (
    !was.actor &&
    !now.actor &&
    !was.resident &&
    was.zone === now.zone &&
    !!was.pinned === !!now.pinned &&
    !!was.archived === !!now.archived &&
    isBackground(was) === isBackground(now) &&
    (!isBackground(now) || needsAttention(was) === needsAttention(now)) &&
    relation(was) === relation(now)
  );
}
export class OfficeService extends EventEmitter {
  private quotaService = new QuotaService();
  store: OfficeStore;
  connectors: Connector[] = [];
  syncing = false;
  lastSync: number | null = null;
  error: string | null = null;
  version = 0;
  /** This collector's run: a client holding another run's version must take a full snapshot. */
  readonly epoch = randomUUID();
  /** What was last sent, so a cycle that changed nothing sends nothing. */
  private sent: { index: SnapshotIndex; at: number; snapshot: Snapshot } | null = null;
  /** When a full office (with its check times) was last published; see `HEALTH_MS`. */
  private healthAt = 0;
  /**
   * Every visible notice as the office last listed it, for `emitChanged` to merge into. Kept
   * between passes: the same objects every full emit builds anyway, so its size follows the
   * notices table (about what one `officeView` holds).
   */
  private notices: { all: OfficeNotice[]; locale: Locale } | null = null;
  /** Recent changes, for a poller a few versions behind (the web preview). */
  private patches: SnapshotPatch[] = [];
  private polledAt = 0;
  /** `key` feeds revisions: the stamp, plus a marker once a re-verification found drift. */
  cache = new Map<string, { stamp: string; key?: string; session: Session }>();
  /** JSONL read windows: changed files read only their appended lines. */
  windows = new RecordWindowCache();
  clawCache = new Map<string, Session>();
  timer: ReturnType<typeof setTimeout> | null = null;
  pending: Promise<Snapshot> | null = null;
  stopped = false;
  roots: Record<Provider, string>;
  /** Live Claude Code process records (`<claude config>/sessions`): permission prompts. */
  live: ClaudeLiveDeps;
  /** How each connector's message is phrased, so a language switch can re-phrase it in place. */
  private phrasing = new Map<Provider, () => string>();
  /** Hot path settings (tests shorten them before `start`). */
  hot: HotOptions = { ...HOT_DEFAULTS };
  /** JSONL sessions of the last full pass (OpenClaw SQLite ones excluded), by id. */
  private known = new Map<string, KnownSession>();
  /** Names and places each provider's last full pass read from its metadata. */
  private metadataOf = new Map<Provider, Map<string, CodexMeta>>();
  /** Sessions on the hot path, the most recently active first. */
  private hotSet = new Set<string>();
  /** When a hot pass last took changes in; the next one waits `hot.minMs` after it. */
  private processedAt = 0;
  /** When a hot pass last ran: a timer tick right after a hinted pass has nothing to add. */
  private passedAt = 0;
  /** Claude sessions whose verified live process is busy or waiting → since when. */
  private livePromoted = new Map<string, number>();
  private hotTimer: ReturnType<typeof setInterval> | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private hintAt = 0;
  private hotRun: Promise<void> | null = null;
  private hotAgain = false;
  /** File watches on hot files, by path; files whose watch failed rely on the stat tick. */
  private watchers = new Map<string, FSWatcher>();
  private unwatchable = new Set<string>();
  /** Parsed live-process records by file name, re-read only when a file moves. */
  private liveFiles = new Map<string, { stamp: string; record: ClaudeProcess | null }>();
  constructor(dir?: string, home = os.homedir()) {
    super();
    this.store = new OfficeStore(dir);
    syncLocale(this.store.preferences().locale);
    const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude');
    this.live = defaultLiveDeps(path.join(claudeHome, 'sessions'));
    this.roots = {
      claude: path.join(claudeHome, 'projects'),
      codex: path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'), 'sessions'),
      openclaw: path.join(process.env.OPENCLAW_STATE_DIR ?? path.join(home, '.openclaw'), 'agents'),
    };
    this.connectors = (['claude', 'codex', 'openclaw'] as Provider[]).map((provider) => ({
      provider,
      state: 'paused',
      path: this.roots[provider],
      count: 0,
      lastSync: null,
      message: '',
    }));
    for (const c of this.connectors) this.say(c, () => m().server.connector.checking);
  }
  private say(connector: Connector, message: () => string) {
    this.phrasing.set(connector.provider, message);
    connector.message = message();
  }
  /**
   * After a language switch only the connector messages are phrased again. Collected records
   * are canonical (src/shared/canonical.ts) and localized on every read, so nothing is re-parsed
   * and revisions, event ids and notice versions stay the same.
   */
  private relocalize() {
    for (const c of this.connectors) c.message = this.phrasing.get(c.provider)?.() ?? c.message;
  }
  snapshot(): Snapshot {
    return this.compose().snapshot;
  }
  /** The office now, and every visible notice its carried ones were chosen from. */
  private compose(): { snapshot: Snapshot; all: OfficeNotice[] } {
    const locale: Locale = getLocale();
    const { sessions, notices, noticeStats, all } = this.store.officeView(locale);
    return {
      all,
      snapshot: {
        notices,
        noticeStats,
        sessions,
        // A copy: the snapshot keeps describing its own version after the connectors move on.
        connectors: this.connectors.map((c) => ({ ...c })),
        preferences: localizePreferences(this.store.preferences(), locale),
        bookmarked: this.store.bookmarkMarks(sessions.map((x) => x.id)),
        bookmarkStamp: this.store.bookmarkStamp(),
        syncing: this.syncing,
        lastSync: this.lastSync,
        error: this.error,
        version: this.version,
        epoch: this.epoch,
        locale,
      },
    };
  }
  /**
   * Sends the office out only when something in it changed: colleagues, notices, settings or a
   * connector's state, as a patch of just those parts (`snapshot` listeners also get the whole
   * office). Time-driven changes (a colleague going quiet, moving to waiting) show up as changed
   * content on the next pass. The check times alone go out once a minute.
   */
  emitSnapshot(): Snapshot {
    const { snapshot: s, all } = this.compose();
    this.notices = { all, locale: s.locale! };
    const index = indexSnapshot(s);
    const now = Date.now();
    const sent = this.sent;
    const change = sent ? diffSnapshot(sent.index, s, index) : null;
    if (sent && change && !meaningful(change, sent.snapshot, s) && now - this.healthAt < HEALTH_MS)
      // Nothing to publish: answer with what was published, the baseline of the next patch.
      return sent.snapshot;
    s.version = ++this.version;
    // Only a whole office carries the check times: hot patches never push the next one back.
    this.healthAt = now;
    return this.publish(s, index, sent && change);
  }
  /** Makes `s` (indexed as `index`) the published office; `change` from the last one, if any. */
  private publish(
    s: Snapshot,
    index: SnapshotIndex,
    change: ReturnType<typeof diffSnapshot> | null,
  ): Snapshot {
    const now = Date.now();
    const patch: SnapshotPatch | null =
      this.sent && change
        ? {
            kind: 'patch',
            epoch: this.epoch,
            base: this.sent.snapshot.version,
            version: s.version,
            ...change,
          }
        : null;
    this.sent = { index, at: now, snapshot: s };
    if (patch && now - this.polledAt < POLLER_MS)
      this.patches = [...this.patches.slice(-(PATCH_HISTORY - 1)), patch];
    else this.patches = [];
    this.emit('snapshot', s, patch);
    return s;
  }
  /**
   * After a hot pass: sends what changed in just these sessions without rebuilding the office.
   * Their rows are read and decorated one by one, attached against the published colleagues,
   * their notices merged into the last full list of notices, and the carried notices and counts
   * chosen again from it. The result is what `emitSnapshot` would publish, as long as nothing
   * about these sessions can move anyone else: the same zone, desk, attachment, relations, actor
   * and background standing, and no unattached helper hanging off them. Otherwise, and before
   * anything was published, it is `emitSnapshot`. Time-driven changes of other colleagues wait
   * for the next full pass, as they always have.
   */
  private emitChanged(ids: string[]) {
    const sent = this.sent;
    const base = this.notices;
    const locale = getLocale();
    const change =
      sent && base?.locale === locale ? this.changeOf(sent, base.all, ids, locale) : null;
    if (!change) return void this.emitSnapshot();
    this.notices = { all: change.all, locale };
    if (!change.patch) return;
    const s = applyPatch(sent!.snapshot, {
      kind: 'patch',
      epoch: this.epoch,
      base: sent!.snapshot.version,
      version: ++this.version,
      ...change.patch,
    });
    this.publish(s, change.index, change.patch);
  }
  /** `emitChanged`'s patch and index, null when only the whole office can tell. */
  private changeOf(
    sent: NonNullable<OfficeService['sent']>,
    all: OfficeNotice[],
    ids: string[],
    locale: Locale,
  ): {
    patch: ReturnType<typeof diffSnapshot> | null;
    index: SnapshotIndex;
    all: OfficeNotice[];
  } | null {
    const published = sent.snapshot.sessions;
    const before = new Map(published.map((s) => [s.id, s]));
    const changed = new Set(ids);
    const rows = new Map<string, Session>();
    for (const id of changed) {
      const was = before.get(id);
      const row = this.store.officeRow(id);
      if (!was || !row || !standsStill(was, row)) return null;
      rows.set(id, row);
    }
    const list = published.map((s) => rows.get(s.id) ?? s);
    // Anyone hanging off a changed session whose desk could depend on it.
    for (const s of list)
      if (!changed.has(s.id) && isHelper(s)) {
        const parent = parentSession(s, list);
        if (parent && changed.has(parent.id) && (isHelper(parent) || !s.attachedTo)) return null;
      }
    const next = new Map<string, Session>();
    for (const s of attachSessions(list))
      if (changed.has(s.id)) {
        const was = before.get(s.id)!;
        if (s.attachedTo !== was.attachedTo || s.officeSeat !== was.officeSeat) return null;
        // An unattached helper stands on its own desk only while it is shown at all
        // (`helperPresence`): whether it still is depends on more than this session.
        if (isHelper(s) && !s.attachedTo) return null;
        next.set(s.id, localizeSession(s, locale));
      }
    // Notices: these sessions' own, merged into the rest as last listed.
    const background = new Set(
      [...rows.values()].filter((s) => isBackground(s) || isHelper(s)).map((s) => s.id),
    );
    const merged = all
      .filter((n) => !changed.has(n.sessionId))
      .concat(this.store.noticesOf([...changed], background, locale))
      .sort(noticeOrder);
    const carried = residentNotices(merged);
    const noticeStats = { unread: unreadNoticeCount(merged), total: merged.length };
    // The patch, against the published index.
    const prev = sent.index;
    const index: SnapshotIndex = {
      sessions: new Map(prev.sessions),
      notices: new Map(),
      order: prev.order,
      noticeOrder: carried.map((n) => n.id).join('\n'),
      fields: new Map(prev.fields),
    };
    const patch: ReturnType<typeof diffSnapshot> = {};
    for (const s of next.values()) {
      const json = JSON.stringify(s);
      if (prev.sessions.get(s.id) === json) continue;
      index.sessions.set(s.id, json);
      (patch.sessions ??= []).push(s);
    }
    const order = this.store.sessionOrder().filter((id) => before.has(id));
    index.order = order.join('\n');
    if (index.order !== prev.order) patch.order = order;
    const sentNotices = new Map((sent.snapshot.notices ?? []).map((n) => [n.id, n]));
    for (const n of carried) {
      const old = prev.notices.get(n.id);
      const json = sentNotices.get(n.id) === n && old ? old : JSON.stringify(n);
      index.notices.set(n.id, json);
      if (json !== old) (patch.notices ??= []).push(n);
    }
    const removedNotices = [...prev.notices.keys()].filter((id) => !index.notices.has(id));
    if (removedNotices.length) patch.removedNotices = removedNotices;
    if (index.noticeOrder !== prev.noticeOrder) patch.noticeOrder = carried.map((n) => n.id);
    const stats = JSON.stringify(noticeStats);
    if (prev.fields.get('noticeStats') !== stats) {
      index.fields.set('noticeStats', stats);
      patch.fields = { noticeStats };
    }
    return { patch: Object.keys(patch).length ? patch : null, index, all: merged };
  }
  /**
   * The office as last published. Every client must hold exactly what a version was published
   * as, since patches are made against that; a mid-collection read could differ (e.g. `syncing`).
   */
  private published(): Snapshot {
    return this.sent?.snapshot ?? this.emitSnapshot();
  }
  /** What a client holding `version` of run `epoch` needs: nothing, a patch, or the office. */
  private catchUp(epoch: unknown, version: unknown) {
    this.polledAt = Date.now();
    const sent = this.sent;
    if (!sent || epoch !== this.epoch || typeof version !== 'number') return this.published();
    if (version === sent.snapshot.version) return { unchanged: true, epoch, version };
    const from = this.patches.findIndex((p) => p.base === version);
    return from < 0 ? sent.snapshot : composePatches(this.patches.slice(from));
  }
  start() {
    // Polling never outlives stop(): no new timer, no refresh on a closed store.
    const tick = () => {
      if (this.stopped) return;
      this.timer = setTimeout(async () => {
        if (this.stopped) return;
        await this.refresh().catch(() => {});
        tick();
      }, 5000);
    };
    this.refresh().catch(() => {});
    tick();
    this.hotTimer = setInterval(() => {
      // Right after a hinted pass a tick has nothing to add.
      if (Date.now() - this.passedAt >= this.hot.tickMs - TICK_SLACK_MS) void this.hotTick();
    }, this.hot.tickMs);
  }
  /** Stops at once: what a pass in flight had not written yet is written by `close` if it can. */
  stop() {
    this.halt();
    this.close();
  }
  /**
   * Stops and lets a full pass or hot pass in flight finish first, then closes the store, which
   * writes whatever the hot path staged. For a clean quit (desktop, dev server).
   */
  async shutdown() {
    // No new passes from here; the ones in flight run to their end (and stage what they read).
    this.stopping = true;
    this.clearTimers();
    await Promise.allSettled([this.pending, this.hotRun]);
    this.halt();
    this.close();
  }
  private stopping = false;
  private clearTimers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.hotTimer) clearInterval(this.hotTimer);
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.timer = this.hotTimer = this.hintTimer = null;
  }
  private halt() {
    this.stopped = true;
    this.clearTimers();
    this.hotSet.clear();
    this.syncWatches();
  }
  private closed = false;
  private close() {
    if (this.closed) return;
    this.closed = true;
    this.store.close();
  }
  async refresh(): Promise<Snapshot> {
    if (this.pending) return this.pending;
    if (this.stopped || this.stopping) throw new Error(m().server.rpc.stopped);
    // A hot pass in flight finishes first: the two never read the same file at once.
    const hot = this.hotRun ?? Promise.resolve();
    this.pending = hot
      .then(() => this.collect())
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  private async collect(): Promise<Snapshot> {
    const prefs = this.store.preferences();
    if (prefs.paused) {
      this.connectors = this.connectors.map((c) => ({ ...c, state: 'paused' }));
      for (const c of this.connectors) this.say(c, () => m().server.connector.paused);
      this.forgetHot();
      return this.emitSnapshot();
    }
    this.syncing = true;
    this.error = null;
    for (const provider of ['claude', 'codex', 'openclaw'] as Provider[]) {
      if (this.stopped) break;
      const connector = this.connectors.find((c) => c.provider === provider)!;
      if (!prefs.enabledProviders.includes(provider)) {
        connector.state = 'paused';
        this.say(connector, () => m().server.connector.disabled);
        this.forget(provider, new Set());
        this.forgetHot(provider);
        if (provider === 'openclaw') this.clawCache.clear();
        continue;
      }
      try {
        await stat(this.roots[provider]);
        let sessions: Session[] = [];
        let errors = 0;
        const metadata =
          provider === 'codex'
            ? await codexMetadata(path.dirname(this.roots.codex))
            : provider === 'claude'
              ? await claudeMetadata(this.roots.claude)
              : new Map<string, CodexMeta>();
        /** Sessions that come (also) from an OpenClaw database: never rebuilt from files alone. */
        const fromDatabase = new Set<string>();
        if (provider === 'openclaw') {
          const r = await readOpenClawDatabases(
            this.roots.openclaw,
            prefs.maxSessions,
            this.clawCache,
          );
          sessions = r.sessions;
          errors = r.errors;
          for (const s of r.sessions) fromDatabase.add(s.id);
        }
        const files = (await discover(this.roots[provider], provider === 'openclaw' ? 2 : 5)).slice(
          0,
          prefs.maxSessions,
        );
        /** Each session's source files, in merge order. */
        const sources = new Map<string, string[]>();
        for (const file of files) {
          const s = await this.readSession(provider, file, metadata);
          if (s === 'error') errors++;
          if (!s || s === 'error') continue;
          sessions.push(s);
          sources.set(s.id, [...(sources.get(s.id) ?? []), file.path]);
        }
        this.forget(provider, new Set(files.map((f) => f.path)));
        // Discovery is newest-first. Never let an older duplicate replace live activity.
        sessions = mergeSessions(sessions)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, prefs.maxSessions);
        const places = new Map(sessions.map((s) => [s.id, place(s)]));
        sessions = await enrichWorkspaces(sessions);
        sessions = sessions.map((s) => ({
          ...s,
          revision: hash(`${s.revision}:${workspaceSignature(s.workspace)}`),
        }));
        let waits = new Map<string, ClaudeProcess>();
        if (provider === 'claude') ({ sessions, waits } = await this.liveWaits(sessions));
        if (errors && sessions.length === 0) throw new Error(m().server.connector.unreadable);
        // What the hot path rebuilds from: the sessions exactly as stored below.
        this.forgetHot(provider, true);
        this.metadataOf.set(provider, metadata);
        for (const s of sessions) {
          const paths = sources.get(s.id);
          if (paths && !fromDatabase.has(s.id))
            this.known.set(s.id, {
              id: s.id,
              provider,
              nativeId: s.nativeId,
              files: paths,
              place: places.get(s.id)!,
              workspace: s.workspace,
              mood: s.observedStatus ?? s.status,
              updatedAt: s.updatedAt,
              wait: liveWaitSignature(waits.get(s.nativeId)),
            });
        }
        // On partial source failure, retain existing records instead of silently deleting their history.
        if (errors) {
          const ids = new Set(sessions.map((s) => s.id));
          // As stored (not decorated or filtered by visibility): a hidden project's records must
          // not be deleted for a pass that failed to read them.
          sessions.push(...this.store.storedRecords(provider).filter((s) => !ids.has(s.id)));
        }
        this.store.upsert(sessions, provider);
        Object.assign(connector, {
          state: errors ? 'error' : 'connected',
          count: sessions.length,
          lastSync: Date.now(),
        });
        const count = sessions.length;
        this.say(connector, () =>
          errors
            ? m().server.connector.partial(errors)
            : `${m().server.connector.connected(count)}${provider === 'openclaw' ? ' · SQLite / JSONL' : ''}`,
        );
      } catch (e) {
        this.forgetHot(provider);
        const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
        connector.state = missing ? 'missing' : 'error';
        this.say(connector, () =>
          missing ? m().server.connector.missing : m().server.connector.failed,
        );
      }
    }
    this.windows.sweep();
    this.syncing = false;
    this.lastSync = Date.now();
    if (this.stopped) throw new Error(m().server.rpc.stopped);
    this.rehot(Date.now(), prefs);
    return this.emitSnapshot();
  }
  /**
   * One source file up to the provider-wide steps: the parse cache or the incremental reader,
   * metadata names, the subagent sidecar. Shared by the full pass and the hot path, through the
   * same caches, so both make the same session (and revision) of the same bytes. Null when the
   * file holds no records yet; 'error' when it could not be read or parsed.
   */
  private async readSession(
    provider: Provider,
    file: SourceFile,
    metadata: Map<string, CodexMeta>,
  ): Promise<Session | null | 'error'> {
    const stamp = `office-v11:${file.size}:${file.mtime}`;
    const cached = this.cache.get(file.path);
    let s = cached?.stamp === stamp ? cached.session : null;
    let key = (s && cached?.key) || stamp;
    // A window built by appends trusts its guard bytes; re-verify it in full on schedule
    // even when the file has gone quiet, and re-parse only if that found other records.
    if (s && this.windows.stale(file.path)) {
      const check = await this.windows.verify(file).catch(() => null);
      if (check?.drifted) {
        s = null;
        key = `${stamp}:verified:${Date.now()}`;
      }
    }
    if (!s) {
      try {
        const { records, partial } = await this.windows.read(file);
        if (!records.length) return null;
        if (provider === 'codex' && partial && !records.some((r) => r.type === 'session_meta'))
          throw new Error('Native identity header could not be read');
        s = parseRecords(records, {
          provider,
          sourcePath: file.path,
          mtime: file.mtime,
          partial,
          agentName:
            provider === 'openclaw'
              ? path.relative(this.roots.openclaw, file.path).split(path.sep)[0]
              : undefined,
        });
        const meta = metadata.get(s.nativeId);
        if (meta) {
          s = {
            ...s,
            title: provider === 'claude' && s.nativeTitle ? s.title : meta.title || s.title,
            nativeTitle: !!meta.title || s.nativeTitle,
            cwd: meta.cwd ?? s.cwd,
            branch: meta.branch ?? s.branch,
            gitCommit: meta.gitCommit ?? s.gitCommit,
            model: meta.model ?? s.model,
          };
          s.project = s.cwd ? path.basename(s.cwd) : s.project;
        }
        s.revision = hash(`${key}:${s.title}`);
        // A copy, not the parse result itself: its texts are cut out of the raw records
        // (string slices), which would keep every record's full text alive with it.
        this.remember(file.path, { stamp, key, session: structuredClone(s) });
      } catch {
        return 'error';
      }
    }
    const latestMeta = metadata.get(s.nativeId);
    if (latestMeta) {
      s = {
        ...s,
        title: provider === 'claude' && s.nativeTitle ? s.title : latestMeta.title || s.title,
        nativeTitle: !!latestMeta.title || s.nativeTitle,
        cwd: latestMeta.cwd ?? s.cwd,
        branch: latestMeta.branch ?? s.branch,
        gitCommit: latestMeta.gitCommit ?? s.gitCommit,
        model: latestMeta.model ?? s.model,
      };
      s.project = s.cwd ? path.basename(s.cwd) : s.project;
      s.revision = hash(`${key}:${s.title}:${s.cwd}:${s.model}:${s.branch}:${s.gitCommit}`);
    }
    if (provider === 'claude') {
      const sidecar = await claudeSubagentMetadata(file.path);
      if (sidecar)
        s = {
          ...s,
          title: s.nativeTitle ? s.title : sidecar.title || s.title,
          relation: s.relation
            ? { ...s.relation, role: sidecar.role || s.relation.role }
            : undefined,
          revision: hash(`${s.revision}:${sidecar.title}:${sidecar.role}`),
        };
    }
    return s;
  }
  /** Parse cache with a size cap as a safety net; pruning to discovered files keeps it far below. */
  private remember(file: string, entry: { stamp: string; key: string; session: Session }) {
    this.cache.delete(file);
    this.cache.set(file, entry);
    for (const key of this.cache.keys()) {
      if (this.cache.size <= 4000) break;
      this.cache.delete(key);
    }
  }
  /** Drop one provider's read caches for files that are no longer discovered. */
  private forget(provider: Provider, keep: Set<string>) {
    for (const [file, entry] of this.cache)
      if (entry.session.provider === provider && !keep.has(file)) this.cache.delete(file);
    this.windows.prune(keep, this.roots[provider]);
  }
  /**
   * A permission prompt shows only in the live process record, never in the transcript. Applied
   * after the parse cache on every pass, so the overlay appears and disappears with the record
   * (its revision changes either way). Unreadable or unexpected records change nothing.
   */
  private async liveWaits(
    sessions: Session[],
    records?: ClaudeProcess[],
  ): Promise<{ sessions: Session[]; waits: Map<string, ClaudeProcess> }> {
    const wanted = new Set(sessions.map((s) => s.nativeId));
    const waits: Map<string, ClaudeProcess> = await waitingClaudeProcesses(
      this.live,
      wanted,
      records,
    ).catch(() => new Map());
    if (!waits.size) return { sessions, waits };
    const now = Date.now();
    return {
      waits,
      sessions: sessions.map((s) => {
        const live = waits.get(s.nativeId);
        return (live && applyLiveWait(s, live, now)) || s;
      }),
    };
  }
  /** Which known sessions take the hot path now, at most `hot.max`, the most recently active first. */
  private rehot(now: number, prefs: Preferences) {
    const hot = [...this.known.values()]
      .filter((k) => {
        if (!prefs.enabledProviders.includes(k.provider)) return false;
        if (this.livePromoted.has(k.id)) return true;
        const { status } = deriveState(
          k.mood,
          k.updatedAt,
          now,
          false,
          prefs.standbyHours,
          prefs.readyMinutes,
          CANONICAL,
        );
        return WORKING.has(status) || (k.mood === 'done' && now - k.updatedAt < this.hot.graceMs);
      })
      .map((k) => ({ id: k.id, at: Math.max(k.updatedAt, this.livePromoted.get(k.id) ?? 0) }))
      .sort((a, b) => b.at - a.at)
      .slice(0, prefs.paused ? 0 : this.hot.max);
    this.hotSet = new Set(hot.map(({ id }) => id));
    this.syncWatches();
  }
  /**
   * Leave the hot path for one provider (or all): its sessions wait for the next full pass.
   * `relearn`: the full pass is about to list them again, so live promotions are kept.
   */
  private forgetHot(provider?: Provider, relearn = false) {
    for (const [id, k] of this.known)
      if (!provider || k.provider === provider) {
        this.known.delete(id);
        if (!relearn) {
          this.hotSet.delete(id);
          this.livePromoted.delete(id);
        }
      }
    if (!provider) this.metadataOf.clear();
    else this.metadataOf.delete(provider);
    if (!relearn) this.syncWatches();
  }
  /** The hot sessions' ids, most recently active first (for tests and diagnostics). */
  hotSessions(): string[] {
    return [...this.hotSet];
  }
  /** Files watched right now (for tests and diagnostics). */
  watchedFiles(): string[] {
    return [...this.watchers.keys()];
  }
  /** Watch exactly the hot sessions' files; a watch that cannot start is left to the stat tick. */
  private syncWatches() {
    const wanted = new Map<string, string>();
    if (this.hot.watch && !this.stopped)
      for (const id of this.hotSet)
        for (const file of this.known.get(id)?.files ?? []) wanted.set(file, id);
    for (const [file, watcher] of this.watchers)
      if (!wanted.has(file)) {
        watcher.close();
        this.watchers.delete(file);
      }
    for (const file of this.unwatchable) if (!wanted.has(file)) this.unwatchable.delete(file);
    for (const file of wanted.keys()) {
      if (this.watchers.has(file) || this.unwatchable.has(file)) continue;
      try {
        const watcher = watch(file, { persistent: false }, (event) => {
          // Renamed or replaced: this watch follows the old inode. Drop it; the next pass
          // watches whatever is at the path now (the stat tick covers the gap).
          if (event === 'rename') {
            watcher.close();
            if (this.watchers.get(file) === watcher) this.watchers.delete(file);
          }
          this.hint();
        });
        watcher.on('error', () => {
          watcher.close();
          this.watchers.delete(file);
          this.unwatchable.add(file);
        });
        this.watchers.set(file, watcher);
      } catch {
        this.unwatchable.add(file);
      }
    }
  }
  /** A hot file changed: process it shortly, once a burst of writes has settled. */
  private hint(delay = this.hot.debounceMs) {
    if (this.stopped || this.stopping) return;
    const now = Date.now();
    // Not before the next pass may take changes in: an earlier one would only find it too soon.
    const at = Math.max(now + delay, this.processedAt + this.hot.minMs);
    if (this.hintTimer && this.hintAt <= at) return;
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintAt = at;
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      void this.hotTick(true);
    }, at - now);
  }
  /**
   * One hot pass, unless a full pass is running (it reads everything anyway) or one is already
   * running (a hint then runs another right after). Never rejects.
   */
  hotTick(hinted = false): Promise<void> {
    if (this.stopped || this.stopping || this.pending) return Promise.resolve();
    if (this.hotRun) {
      if (hinted) this.hotAgain = true;
      return this.hotRun;
    }
    this.hotRun = this.hotPass(hinted)
      .catch(() => {})
      .finally(() => {
        this.hotRun = null;
        if (this.hotAgain) {
          this.hotAgain = false;
          this.hint(0);
        }
      });
    return this.hotRun;
  }
  /**
   * Re-reads the hot sessions whose files moved (or whose live wait did) through the full pass's
   * own per-file step and caches, reusing its metadata and workspaces, and stores just those
   * sessions. No discovery, metadata reads or Git; one read of the live-process directory, with
   * the usual memoized `ps` check. Anything the full pass would resolve differently (a new place,
   * another identity, a file gone) is left to it.
   */
  private async hotPass(hinted: boolean) {
    this.passedAt = Date.now();
    const prefs = this.store.preferences();
    if (prefs.paused) return this.rehot(Date.now(), prefs);
    let now = Date.now();
    let waits = new Map<string, ClaudeProcess>();
    const claude = [...this.known.values()].filter((k) => k.provider === 'claude');
    if (claude.length && prefs.enabledProviders.includes('claude')) {
      const records = await readClaudeProcessesCached(this.live.sessionsDir, this.liveFiles);
      // Promotion: a busy or waiting process means its transcript is about to move.
      this.rehot(now, prefs);
      // Sessions not hot on their own, and those hot only by an earlier promotion: a promotion
      // holds only while its process is verified alive (and the same process) on every pass,
      // through the same memoized check, so a dead or recycled PID frees its slot.
      const wanted = new Set(
        claude
          .filter((k) => !this.hotSet.has(k.id) || this.livePromoted.has(k.id))
          .map((k) => k.nativeId),
      );
      const active = records.some((r) => LIVE_ACTIVE.has(r.status))
        ? await liveClaudeProcesses(this.live, wanted, LIVE_ACTIVE, records).catch(() => new Map())
        : new Map<string, ClaudeProcess>();
      const promoted = new Map<string, number>();
      for (const k of claude) {
        const live = active.get(k.nativeId);
        if (live)
          promoted.set(k.id, this.livePromoted.get(k.id) ?? live.statusUpdatedAt ?? live.updatedAt);
      }
      this.livePromoted = promoted;
      this.rehot(now, prefs);
      const hotClaude = new Set(
        [...this.hotSet]
          .map((id) => this.known.get(id)!)
          .filter((k) => k.provider === 'claude')
          .map((k) => k.nativeId),
      );
      if (hotClaude.size)
        waits = await waitingClaudeProcesses(this.live, hotClaude, records).catch(() => new Map());
    } else this.rehot(now, prefs);
    // Which hot sessions moved: a stat per file against the parse cache's stamp, or a new wait.
    const due: { k: KnownSession; files: SourceFile[]; live: ClaudeProcess | undefined }[] = [];
    for (const id of this.hotSet.keys()) {
      const k = this.known.get(id);
      if (!k) continue;
      const live = k.provider === 'claude' ? waits.get(k.nativeId) : undefined;
      const files: SourceFile[] = [];
      let moved = liveWaitSignature(live) !== k.wait;
      for (const file of k.files) {
        const st = await stat(file).catch(() => null);
        // Gone: the full pass decides what that means.
        if (!st) {
          moved = false;
          break;
        }
        files.push({ path: file, size: st.size, mtime: st.mtimeMs });
        if (this.cache.get(file)?.stamp !== `office-v11:${st.size}:${st.mtimeMs}`) moved = true;
      }
      if (moved) due.push({ k, files, live });
    }
    if (!due.length || this.stopped || this.pending) return;
    // Everything that moved is taken in together, at most once every `minMs` (so every session
    // at most that often): a burst of writes costs one store write and one patch per interval.
    const wait = this.processedAt + this.hot.minMs - Date.now();
    if (wait > (hinted ? 0 : TICK_SLACK_MS)) return this.hint(wait);
    this.processedAt = Date.now();
    const taken: { k: KnownSession; s: Session; live: ClaudeProcess | undefined }[] = [];
    for (const { k, files, live } of due) {
      if (this.stopped || this.pending) break;
      const s = await this.hotSession(k, files, live);
      if (s) taken.push({ k, s, live });
    }
    if (this.stopped || !taken.length) return;
    const updates = taken.map(({ s }) => s);
    // Taken in memory only; the next full pass of each provider writes them (`OfficeStore.stage`).
    for (const provider of new Set(updates.map((s) => s.provider)))
      this.store.stage(
        updates.filter((s) => s.provider === provider),
        provider,
      );
    this.emitChanged(updates.map((s) => s.id));
    // Only once taken in and sent. If staging or sending fails, a changed live wait is retried
    // by the next hot pass; transcript changes (already in the parse cache) by the next full collect.
    for (const { k, s, live } of taken)
      Object.assign(k, {
        mood: s.observedStatus ?? s.status,
        updatedAt: s.updatedAt,
        wait: liveWaitSignature(live),
      });
    // A final reply starts its grace period; idle sessions leave the hot set.
    this.rehot(Date.now(), prefs);
  }
  /** One hot session rebuilt from its files, or null to leave it to the full pass. */
  private async hotSession(
    k: KnownSession,
    files: SourceFile[],
    live: ClaudeProcess | undefined,
  ): Promise<Session | null> {
    const metadata = this.metadataOf.get(k.provider) ?? new Map<string, CodexMeta>();
    const parts: Session[] = [];
    for (const file of files) {
      const s = await this.readSession(k.provider, file, metadata);
      if (!s || s === 'error' || s.id !== k.id) return null;
      parts.push(s);
    }
    const merged = mergeSessions(parts)[0];
    // A new place may be another workspace: only the full pass asks Git.
    if (place(merged) !== k.place) return null;
    const s = placed(merged, k.workspace);
    return (live && applyLiveWait(s, live, Date.now())) || s;
  }
  async call(method: string, args: unknown[] = []): Promise<unknown> {
    switch (method) {
      case 'quotas':
        return Promise.all(
          this.store.preferences().enabledProviders.map((p) => this.quotaService.read(p)),
        );
      case 'snapshot':
        // A poller says what it holds: it gets nothing new, what changed, or the whole office.
        return args.length ? this.catchUp(args[0], args[1]) : this.published();
      case 'refresh':
        return this.refresh();
      case 'detail':
        // Without a page: the newest one, as every caller that only needs the session asks.
        return this.store.detail(
          z.string().max(400).parse(args[0]),
          detailPageSchema.optional().parse(args[1] ?? undefined),
        );
      case 'visit':
      case 'returnToOffice':
        this.store.visit(z.string().max(400).parse(args[0]), method === 'returnToOffice');
        return this.emitSnapshot();
      case 'artifacts':
        return artifactDetails(this.store.get(z.string().max(400).parse(args[0])).artifacts);
      case 'notices':
        this.store.noticeReceipt(
          z
            .array(z.object({ id: z.string().max(1000), version: z.string().max(100) }).strict())
            .max(1000)
            .parse(args[0]),
          z.enum(['read', 'dismiss', 'unread', 'view']).parse(args[1]),
        );
        return this.emitSnapshot();
      case 'noticePage':
        return this.store.noticePage(noticePageSchema.parse(args[0]));
      case 'noticeReadAll':
        this.store.noticeReadAll(
          noticeQuerySchema.parse(args[0]),
          z.number().nonnegative().parse(args[1]),
        );
        return this.emitSnapshot();
      case 'patch':
        this.store.patch(z.string().max(400).parse(args[0]), patchSchema.parse(args[1]));
        return this.emitSnapshot();
      case 'veil':
        this.store.veil(
          z.array(z.string().max(400)).max(500).parse(args[0]),
          z.boolean().parse(args[1]),
        );
        return this.emitSnapshot();
      case 'pin':
        this.store.pin(
          z.array(z.string().max(400)).max(500).parse(args[0]),
          z.boolean().parse(args[1]),
        );
        return this.emitSnapshot();
      case 'reorderSeats':
        this.store.reorderSeats(z.array(z.string().max(400)).max(500).parse(args[0]));
        return this.emitSnapshot();
      case 'identities':
        // Read-only and no more than `detail` already returns, for the desktop's terminal lookup.
        return this.store.identities(z.array(z.string().max(400)).max(500).parse(args[0]));
      case 'preferences':
        if (syncLocale(this.store.preferences(prefsSchema.parse(args[0])).locale))
          this.relocalize();
        return this.emitSnapshot();
      case 'search':
        return this.store.search(
          z.string().max(200).parse(args[0]),
          args[1] ? providerSchema.parse(args[1]) : undefined,
        );
      case 'bookmarks':
        return this.store.bookmarks(bookmarkQuerySchema.optional().parse(args[0] ?? undefined));
      case 'bookmarkById':
        return this.store.bookmarkById(z.string().max(100).parse(args[0]));
      case 'bookmark': {
        const bookmark = this.store.bookmark(
          z.string().max(400).parse(args[0]),
          z.string().max(1000).parse(args[1]),
          noteSchema.optional().parse(args[2] ?? undefined),
        );
        return { bookmark, snapshot: this.emitSnapshot() };
      }
      case 'unbookmark':
        this.store.unbookmark(z.string().max(100).parse(args[0]));
        return this.emitSnapshot();
      case 'unbookmarkMessage':
        this.store.unbookmarkMessage(
          z.string().max(400).parse(args[0]),
          z.string().max(1000).parse(args[1]),
        );
        return this.emitSnapshot();
      case 'bookmarkNote': {
        const bookmark = this.store.bookmarkNote(
          z.string().max(100).parse(args[0]),
          noteSchema.parse(args[1]),
        );
        // Other windows' lists read the note again.
        this.emitSnapshot();
        return bookmark;
      }
      case 'handoff':
        return this.store.handoff(
          z.string().max(400).parse(args[0]),
          z.string().max(100).parse(args[1]),
        );
      default:
        throw new Error(m().server.rpc.unsupported);
    }
  }
}
