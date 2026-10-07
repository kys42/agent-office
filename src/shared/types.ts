import { m, type Locale, type LocalePreference } from './i18n';
import type { PetCustomization } from './pets';
export type Provider = 'claude' | 'codex' | 'openclaw';
/**
 * Office status. Observed (work/think/call/error/done) or derived from time since the last
 * activity: ready (just finished, standing by) → idle → sleep (gone home, lounge) → leave.
 * See docs/golden/STATUS-POLICY.md.
 */
export type Mood =
  'work' | 'think' | 'call' | 'error' | 'done' | 'ready' | 'idle' | 'sleep' | 'leave';
export type Evidence = 'observed' | 'derived';
export type OfficeZone = 'office' | 'waiting' | 'archive';
export type ExecutionPhase =
  | 'working'
  | 'thinking'
  | 'needs-input'
  | 'responded'
  | 'interrupted'
  | 'error'
  | 'quiet'
  | 'unknown';
export interface RuntimeObservation {
  phase: ExecutionPhase;
  at: number;
  evidence: Evidence | 'unknown';
  reason: string;
}
export interface WorkspaceIdentity {
  key: string;
  name: string;
  root: string | null;
  worktree: string | null;
  evidence: 'git-common-dir' | 'record-path' | 'unknown';
  locationSource?: WorkingLocation;
  git?: {
    branch: string | null;
    commit: string | null;
    state: 'branch' | 'detached' | 'unborn' | 'unavailable';
    observedAt: number;
  };
}
/** User-defined office area. Explicit only: path prefixes are never grouped automatically. */
export interface ZoneRule {
  id: string;
  name: string;
  match: 'session' | 'worktree' | 'path' | 'branch';
  /** Session id, worktree path, folder path or branch name (`prefix*` matches a prefix). */
  value: string;
  /** Workspace key the rule was made from, so other repositories never join by accident. */
  repo?: string;
  /** Join an existing project zone (its `projectKey`) instead of a custom area. */
  target?: string;
}
export interface SessionArea {
  key: string;
  name: string;
  ruleId: string;
  match: ZoneRule['match'];
}
export interface SessionRelation {
  kind: 'root' | 'subagent' | 'fork' | 'child' | 'unknown';
  parentNativeId: string | null;
  source: string;
  agentPath?: string;
  role?: string;
  parentSessionKey?: string;
}
export interface SessionActor {
  id: string;
  name: string;
  source: string;
}
export interface SessionOrigin {
  kind: 'interactive' | 'scheduled' | 'internal' | 'unknown';
  source: string;
  role?: string;
}
/** View projection only: its member sessions remain independently addressable. */
export interface OfficeResident {
  key: string;
  name: string;
  sessionIds: string[];
  activeCount: number;
  backgroundCount: number;
}
export type NoticeKind = 'request' | 'progress' | 'reply' | 'message' | 'attention' | 'error';
export interface OfficeNotice {
  id: string;
  sessionId: string;
  eventId: string;
  kind: NoticeKind;
  /** Native public-message phase; legacy replies without this are not confirmed finals. */
  phase?: OfficeEvent['phase'];
  text: string;
  at: number;
  receivedAt: number;
  version: string;
  seenAt: number | null;
  viewedAt?: number | null;
  background?: boolean;
  dismissedAt: number | null;
  resolvedAt: number | null;
  bootstrap: boolean;
}
export interface NoticeReceipt {
  id: string;
  version: string;
}
export type NoticeAction = 'read' | 'dismiss' | 'unread' | 'view';
export interface Artifact {
  url: string;
  kind: 'pull' | 'issues';
  repo: string;
  number: number;
  title?: string;
  state?: 'open' | 'closed' | 'merged' | 'draft';
  verifiedAt?: number;
}
export interface OfficeEvent {
  id: string;
  /** Prior transport-ordinal key, solely for preserving local read receipts. */
  legacyId?: string;
  at: number;
  kind: 'user' | 'assistant' | 'tool' | 'result' | 'lifecycle';
  text: string;
  tool?: string;
  intent?: 'request-input' | 'tool-use';
  phase?: 'commentary' | 'final';
  /** Locally retained public notice excerpt, not the complete source message. */
  excerpt?: boolean;
  lifecycle?: 'started' | 'completed' | 'aborted';
  sourceRef: string;
}
export interface Activity {
  text: string;
  kind: 'progress' | 'reply' | 'message' | 'request' | 'status';
  at: number;
  eventId?: string;
  tool?: { name: string; at: number };
}
export interface Usage {
  input: number | null;
  output: number | null;
  cached: number | null;
  total: number | null;
  contextUsed: number | null;
  contextWindow: number | null;
  scope: 'session' | 'sample';
  source: string;
}
export interface UsageEntry {
  id: string;
  at: number;
  model: string | null;
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  cacheWriteHour: number;
}
export interface SessionCost {
  usd: number | null;
  priced: number;
  unpriced: number;
  tokens: number;
  since: number | null;
  rateVersion: string;
}
export interface WorkingLocation {
  path: string;
  at: number;
  source: 'tool-workdir' | 'shell-cd';
}
export interface QuotaWindow {
  key: string;
  label: string;
  usedPercent: number;
  resetsAt: number | null;
}
export interface ProviderQuota {
  provider: Provider;
  state: 'ok' | 'unavailable' | 'error';
  windows: QuotaWindow[];
  checkedAt: number;
  source: string;
  message: string;
}
export interface Session {
  protocolVersion?: 1;
  id: string;
  nativeId: string;
  identity?: {
    evidence: 'database' | 'native-header' | 'subagent-path' | 'filename-fallback';
    transportId: string;
  };
  /** All observed transports for this native conversation, never a grouping key. */
  sourcePaths?: string[];
  provider: Provider;
  agentName?: string;
  actor?: SessionActor;
  origin?: SessionOrigin;
  sessionKey?: string;
  resident?: OfficeResident;
  title: string;
  nativeTitle?: boolean;
  alias: string;
  project: string;
  cwd: string | null;
  workingLocation?: WorkingLocation;
  /** Adapter-only usage samples; removed at the persistence boundary. */
  usageEntries?: UsageEntry[];
  cost?: SessionCost;
  branch: string | null;
  gitCommit?: string | null;
  model: string | null;
  startedAt: number;
  /** Latest own user request/native turn start, retained beyond compact event windows. */
  taskStartedAt?: number;
  updatedAt: number;
  observedAt: number;
  status: Mood;
  observedStatus?: Mood;
  statusEvidence: Evidence;
  statusReason: string;
  action: string;
  activity?: Activity;
  sourcePath: string;
  sourceKind: 'jsonl' | 'sqlite' | 'demo';
  sourceVersion: string;
  partial: boolean;
  archived: boolean;
  pinned: boolean;
  parentId: string | null;
  relation?: SessionRelation;
  runtime?: RuntimeObservation;
  workspace?: WorkspaceIdentity;
  attachedTo?: string;
  /** Custom office area from preferences; replaces the project zone only in the office view. */
  area?: SessionArea;
  usage: Usage;
  events: OfficeEvent[];
  artifacts: string[];
  notes: string;
  revision: string;
  completed: boolean;
  officeSeat?: number;
  zone?: OfficeZone;
  lastViewedAt?: number;
  openCount?: number;
  returnedAt?: number;
  /** The person hid this colleague at this time; shown again on their next conversation. */
  hiddenAt?: number | null;
}
export interface Connector {
  provider: Provider;
  state: 'connected' | 'missing' | 'error' | 'paused';
  path: string;
  count: number;
  lastSync: number | null;
  message: string;
}
export interface Preferences {
  paused: boolean;
  reducedMotion: boolean;
  privacy: boolean;
  excludedProjects: string[];
  enabledProviders: Provider[];
  maxSessions: number;
  standbyHours?: number;
  archiveDays?: number;
  autoArchive?: boolean;
  bubbleHours?: number;
  /** Minutes a colleague stands by ('대기 중') after its last activity before resting. */
  readyMinutes?: number;
  zoneRules?: ZoneRule[];
  /** UI and collector language. Missing means `auto` (system language, else English). */
  locale?: LocalePreference;
  petAppearance?: PetCustomization;
}
export interface Snapshot {
  sessions: Session[];
  connectors: Connector[];
  preferences: Preferences;
  syncing: boolean;
  lastSync: number | null;
  error: string | null;
  version: number;
  notices?: OfficeNotice[];
  noticeStats?: { unread: number; total: number };
  /**
   * The collector's resolved language: its sessions, notices and messages are written in it.
   * With the `auto` preference the UI follows it, so both sides always agree. Demo snapshots
   * may omit it.
   */
  locale?: Locale;
}
export interface SearchHit {
  session: Session;
  snippet: string;
  eventId: string | null;
}
export interface Handoff {
  markdown: string;
  revision: string;
  createdAt: number;
}
export type SessionPatch = Partial<
  Pick<Session, 'alias' | 'notes' | 'pinned' | 'archived' | 'completed'>
>;
/**
 * Where a follow-up can go, observed by the desktop app only. Never carries a handle.
 * Orca/tmux type into the live terminal of a Claude Code session; `codex` hands the message
 * to the shared Codex CLI daemon (`codex queue`), which every attached screen shows.
 */
export interface TerminalTarget {
  kind: 'orca' | 'tmux' | 'codex';
  label: string;
  /** Agent CLI process state, e.g. idle, busy, shell. */
  status: string;
  canSend: boolean;
  /** The app can bring the session's terminal to the front. */
  canFocus: boolean;
  /** Text sent while a turn runs waits for it instead of being refused. */
  queues?: boolean;
}
export interface JumpResult {
  action: 'focused' | 'opened' | 'copy';
  text: string;
}
/**
 * Desk pet window: a small floating pet, the office as one row (zones on rugs), or the
 * floor version (desks standing right on the screen's bottom edge, zones marked by flags).
 */
export type DockMode = 'pet' | 'row' | 'floor';
/** A rectangle in screen coordinates (CSS pixels on the desktop). */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** What the dock card shows: a colleague, opened from its bubble (news first) or its desk. */
export interface CardTarget {
  id: string;
  news: boolean;
}
export type DockAction = DockMode | 'drag-start' | 'drag-end' | 'solid' | 'through';
export interface OfficeAPI {
  quotas: () => Promise<ProviderQuota[]>;
  detail: (id: string) => Promise<Session>;
  visit: (id: string) => Promise<Snapshot>;
  returnToOffice: (id: string) => Promise<Snapshot>;
  notices: (receipts: NoticeReceipt[], action: NoticeAction) => Promise<Snapshot>;
  artifacts: (id: string) => Promise<Artifact[]>;
  openArtifact: (url: string) => Promise<void>;
  snapshot: () => Promise<Snapshot>;
  refresh: () => Promise<Snapshot>;
  patch: (id: string, patch: SessionPatch) => Promise<Snapshot>;
  /** Hide colleagues until their next conversation (`on`), or bring them back. */
  veil: (ids: string[], on: boolean) => Promise<Snapshot>;
  search: (query: string, provider?: Provider) => Promise<SearchHit[]>;
  handoff: (id: string, revision: string) => Promise<Handoff>;
  preferences: (patch: Partial<Preferences>) => Promise<Snapshot>;
  subscribe: (callback: (s: Snapshot) => void) => () => void;
  window: (action: 'mini' | 'main' | 'hide' | 'quit', sessionId?: string) => Promise<void>;
  reveal: (id: string) => Promise<void>;
  resume: (id: string) => Promise<string>;
  /** Desktop only: where each session can take a follow-up, if that can be verified. */
  terminals?: (ids: string[]) => Promise<Record<string, TerminalTarget | null>>;
  /** Desktop only: focus the live terminal, or fall back to resume. */
  jump?: (id: string) => Promise<JumpResult>;
  /** Desktop only, opt-in: type into an idle Claude terminal, or queue into a Codex CLI session. */
  send?: (id: string, text: string) => Promise<string>;
  /**
   * Desktop only: read, or change, the opt-in for `send`. Kept in the desktop profile, outside
   * the preferences shared with the web preview; turning it on asks for native confirmation.
   */
  terminalSend?: (enable?: boolean) => Promise<boolean>;
  /**
   * Desktop dock only: open the colleague card at a clicked desk or bubble, or (from the card)
   * close it or go to the full office.
   */
  card?: (
    action: 'open' | 'close' | 'expand',
    target?: CardTarget,
    anchor?: ScreenRect,
  ) => Promise<void>;
  /** The dock card window: which colleague to show. */
  onCard?: (callback: (target: CardTarget | null) => void) => () => void;
  exportFile: (name: string, content: string) => Promise<boolean>;
  onSelect?: (callback: (id: string) => void) => () => void;
  /** Desktop only. Browser previews switch the dock layout locally. */
  dock?: (action: DockAction) => Promise<void>;
  onDock?: (callback: (mode: DockMode) => void) => () => void;
}
// Labels are getters: they read the active language at use time, never at import time.
const provider = (key: Provider, name: string, short: string, color: string) => ({
  name,
  short,
  color,
  get description() {
    return m().shared.provider[key];
  },
});
export const PROVIDERS: Record<
  Provider,
  { name: string; short: string; color: string; description: string }
> = {
  claude: provider('claude', 'Claude Code', 'Claude', '#ec9a6c'),
  codex: provider('codex', 'Codex', 'Codex', '#7fd6c0'),
  openclaw: provider('openclaw', 'OpenClaw', 'OpenClaw', '#f2878f'),
};
const mood = (key: Mood, color: string, rank: number) => ({
  get label() {
    return m().shared.mood[key];
  },
  color,
  rank,
});
export const MOODS: Record<Mood, { label: string; color: string; rank: number }> = {
  call: mood('call', '#ff7a8a', 0),
  error: mood('error', '#f6b24f', 1),
  work: mood('work', '#5fd69b', 2),
  think: mood('think', '#ab9cff', 3),
  done: mood('done', '#78b6ff', 4),
  ready: mood('ready', '#7fc4d9', 5),
  idle: mood('idle', '#a7a3ad', 6),
  sleep: mood('sleep', '#85818d', 7),
  leave: mood('leave', '#6d6975', 8),
};
