export type Provider = 'claude' | 'codex' | 'openclaw';
export type Mood = 'work' | 'think' | 'call' | 'error' | 'done' | 'idle' | 'sleep' | 'leave';
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
  git?: {
    branch: string | null;
    commit: string | null;
    state: 'branch' | 'detached' | 'unborn' | 'unavailable';
    observedAt: number;
  };
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
/** Desk pet window: a small floating pet, or a full-width row of desks. */
export type DockMode = 'pet' | 'row';
export type DockAction = DockMode | 'drag-start' | 'drag-end' | 'solid' | 'through';
export interface OfficeAPI {
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
  exportFile: (name: string, content: string) => Promise<boolean>;
  onSelect?: (callback: (id: string) => void) => () => void;
  /** Desktop only. Browser previews switch the dock layout locally. */
  dock?: (action: DockAction) => Promise<void>;
  onDock?: (callback: (mode: DockMode) => void) => () => void;
}
export const PROVIDERS: Record<
  Provider,
  { name: string; short: string; color: string; description: string }
> = {
  claude: {
    name: 'Claude Code',
    short: 'Claude',
    color: '#ec9a6c',
    description: '프로젝트 세션 기록',
  },
  codex: { name: 'Codex', short: 'Codex', color: '#7fd6c0', description: '세션 로그 · 제목 DB' },
  openclaw: {
    name: 'OpenClaw',
    short: 'OpenClaw',
    color: '#f2878f',
    description: '에이전트 DB · JSONL',
  },
};
export const MOODS: Record<Mood, { label: string; color: string; rank: number }> = {
  call: { label: '불러요', color: '#ff7a8a', rank: 0 },
  error: { label: '확인 필요', color: '#f6b24f', rank: 1 },
  work: { label: '일하는 중', color: '#5fd69b', rank: 2 },
  think: { label: '생각 중', color: '#ab9cff', rank: 3 },
  done: { label: '응답 완료', color: '#78b6ff', rank: 4 },
  idle: { label: '쉬는 중', color: '#a7a3ad', rank: 5 },
  sleep: { label: '대기 중', color: '#85818d', rank: 6 },
  leave: { label: '보관됨', color: '#6d6975', rank: 7 },
};
