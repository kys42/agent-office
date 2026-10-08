import { QuotaService } from './quotas.js';
import path from 'node:path';
import os from 'node:os';
import { stat } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Connector, Provider, Session, Snapshot } from '../src/shared/types.js';
import { OfficeStore } from './store.js';
import { discover } from './adapters/files.js';
import { RecordWindowCache } from './adapters/record-window.js';
import { parseRecords, hash } from './adapters/normalize.js';
import { codexMetadata } from './adapters/codex.js';
import { readOpenClawDatabases } from './adapters/openclaw.js';
import { artifactDetails } from './artifacts.js';
import { claudeMetadata, claudeSubagentMetadata } from './adapters/claude.js';
import {
  applyLiveWait,
  defaultLiveDeps,
  waitingClaudeProcesses,
  type ClaudeLiveDeps,
  type ClaudeProcess,
} from './adapters/claude-live.js';
import { mergeSessions } from './adapters/merge.js';
import { NOTICE_PAGE_MAX } from '../src/shared/notice-pages.js';
import { DETAIL_PAGE_MAX } from '../src/shared/conversation-pages.js';
import {
  composePatches,
  diffSnapshot,
  indexSnapshot,
  type SnapshotIndex,
  type SnapshotPatch,
} from '../src/shared/snapshot-patch.js';
import { enrichWorkspaces, workspaceSignature } from './workspaces.js';
import { syncLocale } from './locale.js';
import {
  LOCALES,
  getLocale,
  m,
  type Locale,
  type LocalePreference,
} from '../src/shared/i18n/index.js';
import { CANONICAL, localizePreferences } from '../src/shared/canonical.js';
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
    limit: z.number().int().min(1).max(DETAIL_PAGE_MAX).optional(),
  })
  .strict();
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
    const locale: Locale = getLocale();
    const { sessions, notices, noticeStats } = this.store.officeView(locale);
    return {
      notices,
      noticeStats,
      sessions,
      // A copy: the snapshot keeps describing its own version after the connectors move on.
      connectors: this.connectors.map((c) => ({ ...c })),
      preferences: localizePreferences(this.store.preferences(), locale),
      syncing: this.syncing,
      lastSync: this.lastSync,
      error: this.error,
      version: this.version,
      epoch: this.epoch,
      locale,
    };
  }
  /**
   * Sends the office out only when something in it changed: colleagues, notices, settings or a
   * connector's state, as a patch of just those parts (`snapshot` listeners also get the whole
   * office). Time-driven changes (a colleague going quiet, moving to waiting) show up as changed
   * content on the next pass. The check times alone go out once a minute.
   */
  emitSnapshot(): Snapshot {
    const s = this.snapshot();
    const index = indexSnapshot(s);
    const now = Date.now();
    const sent = this.sent;
    const change = sent ? diffSnapshot(sent.index, s, index) : null;
    if (sent && change && !meaningful(change, sent.snapshot, s) && now - sent.at < HEALTH_MS)
      // Nothing to publish: answer with what was published, the baseline of the next patch.
      return sent.snapshot;
    s.version = ++this.version;
    const patch: SnapshotPatch | null =
      sent && change
        ? {
            kind: 'patch',
            epoch: this.epoch,
            base: sent.snapshot.version,
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
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.store.close();
  }
  async refresh(): Promise<Snapshot> {
    if (this.stopped) throw new Error(m().server.rpc.stopped);
    if (this.pending) return this.pending;
    this.pending = this.collect().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private async collect(): Promise<Snapshot> {
    const prefs = this.store.preferences();
    if (prefs.paused) {
      this.connectors = this.connectors.map((c) => ({ ...c, state: 'paused' }));
      for (const c of this.connectors) this.say(c, () => m().server.connector.paused);
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
              : new Map();
        if (provider === 'openclaw') {
          const r = await readOpenClawDatabases(
            this.roots.openclaw,
            prefs.maxSessions,
            this.clawCache,
          );
          sessions = r.sessions;
          errors = r.errors;
        }
        const files = (await discover(this.roots[provider], provider === 'openclaw' ? 2 : 5)).slice(
          0,
          prefs.maxSessions,
        );
        for (const file of files) {
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
              if (!records.length) continue;
              if (
                provider === 'codex' &&
                partial &&
                !records.some((r) => r.type === 'session_meta')
              )
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
              this.remember(file.path, { stamp, key, session: s });
            } catch {
              errors++;
              continue;
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
          sessions.push(s);
        }
        this.forget(provider, new Set(files.map((f) => f.path)));
        // Discovery is newest-first. Never let an older duplicate replace live activity.
        sessions = mergeSessions(sessions)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, prefs.maxSessions);
        sessions = await enrichWorkspaces(sessions);
        sessions = sessions.map((s) => ({
          ...s,
          revision: hash(`${s.revision}:${workspaceSignature(s.workspace)}`),
        }));
        if (provider === 'claude') sessions = await this.liveWaits(sessions);
        if (errors && sessions.length === 0) throw new Error(m().server.connector.unreadable);
        // On partial source failure, retain existing records instead of silently deleting their history.
        if (errors) {
          const ids = new Set(sessions.map((s) => s.id));
          sessions.push(
            ...this.store
              .list(true, CANONICAL)
              .filter((s) => s.provider === provider && !ids.has(s.id)),
          );
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
        const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
        connector.state = missing ? 'missing' : 'error';
        this.say(connector, () =>
          missing ? m().server.connector.missing : m().server.connector.failed,
        );
      }
    }
    this.syncing = false;
    this.lastSync = Date.now();
    if (this.stopped) throw new Error(m().server.rpc.stopped);
    return this.emitSnapshot();
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
  private async liveWaits(sessions: Session[]): Promise<Session[]> {
    const wanted = new Set(sessions.map((s) => s.nativeId));
    const waiting: Map<string, ClaudeProcess> = await waitingClaudeProcesses(
      this.live,
      wanted,
    ).catch(() => new Map());
    if (!waiting.size) return sessions;
    const now = Date.now();
    return sessions.map((s) => {
      const live = waiting.get(s.nativeId);
      return (live && applyLiveWait(s, live, now)) || s;
    });
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
