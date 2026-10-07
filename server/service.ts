import { QuotaService } from './quotas.js';
import path from 'node:path';
import os from 'node:os';
import { stat } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { Connector, Provider, Session, Snapshot } from '../src/shared/types.js';
import { OfficeStore } from './store.js';
import { discover, readRecords } from './adapters/files.js';
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
import { unreadNoticeCount } from '../src/shared/notices.js';
import { enrichWorkspaces } from './workspaces.js';
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
export class OfficeService extends EventEmitter {
  private quotaService = new QuotaService();
  store: OfficeStore;
  connectors: Connector[] = [];
  syncing = false;
  lastSync: number | null = null;
  error: string | null = null;
  version = 0;
  cache = new Map<string, { stamp: string; session: Session }>();
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
    this.store.assignSeats();
    const locale: Locale = getLocale();
    const notices = this.store.noticeList(locale);
    return {
      notices,
      noticeStats: { unread: unreadNoticeCount(notices), total: notices.length },
      sessions: this.store.list(false, locale),
      connectors: this.connectors,
      preferences: localizePreferences(this.store.preferences(), locale),
      syncing: this.syncing,
      lastSync: this.lastSync,
      error: this.error,
      version: this.version,
      locale,
    };
  }
  emitSnapshot() {
    this.version++;
    const s = this.snapshot();
    this.emit('snapshot', s);
    return s;
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
          if (!s) {
            try {
              const { records, partial } = await readRecords(file);
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
              s.revision = hash(`${stamp}:${s.title}`);
              this.cache.set(file.path, { stamp, session: s });
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
            s.revision = hash(`${stamp}:${s.title}:${s.cwd}:${s.model}:${s.branch}:${s.gitCommit}`);
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
        // Discovery is newest-first. Never let an older duplicate replace live activity.
        sessions = mergeSessions(sessions)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, prefs.maxSessions);
        sessions = await enrichWorkspaces(sessions);
        sessions = sessions.map((s) => ({
          ...s,
          revision: hash(`${s.revision}:${JSON.stringify(s.workspace)}`),
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
        return this.snapshot();
      case 'refresh':
        return this.refresh();
      case 'detail':
        return this.store.get(z.string().max(400).parse(args[0]));
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
