export type ManagerCard =
  | {
      type: 'agents';
      at: number;
      agents: {
        id: string;
        name: string;
        project: string;
        status: import('./types').Mood;
        updatedAt: number;
      }[];
    }
  | {
      type: 'briefing';
      at: number;
      total: number;
      working: number;
      attention: number;
      results: number;
    };
export type ManagerProvider = 'codex' | 'claude';
export type ManagerSchedule =
  { kind: 'off' } | { kind: 'hourly'; hours: number } | { kind: 'daily'; time: string };
export interface ManagerSettings {
  provider: ManagerProvider;
  schedule: ManagerSchedule;
  notifications: boolean;
}
export interface ManagerAction {
  command: string;
  sessionId?: string;
  at: number;
}
export interface ManagerJob {
  id: string;
  kind: 'chat' | 'summary';
  text: string;
  selectedId?: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  answer?: string;
  error?: string;
  actions: ManagerAction[];
  cards?: ManagerCard[];
  progress?: string;
  draftAnswer?: string;
  /** Only completed reports advance this watermark. */
  since?: number;
}
export interface ManagerState {
  createdAt?: number;
  settings: ManagerSettings;
  running: boolean;
  ready: boolean;
  sessionId?: string;
  /** Explicitly owned native conversations; never identify a manager by its title. */
  ownedSessionIds?: string[];
  tmuxSession?: string;
  error?: string;
  jobs: ManagerJob[];
  nextRunAt?: number;
  lastSummaryAt?: number;
  availability: { tmux: boolean; codex: boolean; claude: boolean };
}
export type ManagerRequest =
  | { action: 'status' | 'start' | 'stop' | 'summary' }
  | { action: 'chat'; text: string; selectedId?: string }
  | { action: 'configure'; settings: ManagerSettings };

export const MANAGER_ID = 'office:manager';
export function isManagerSession(id: string, state?: ManagerState) {
  return (
    id === MANAGER_ID ||
    !!state?.ownedSessionIds?.includes(id) ||
    (!!state?.sessionId && id === `${state.settings.provider}:${state.sessionId}`)
  );
}
