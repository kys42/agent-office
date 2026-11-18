export const OFFICE_COLORS = ['sky', 'lilac', 'mint', 'peach', 'rose', 'gold'] as const;
export type OfficeColor = (typeof OFFICE_COLORS)[number];
export const OFFICE_SWATCH: Record<OfficeColor, string> = {
  sky: '#85cafa',
  lilac: '#c6a6f5',
  mint: '#7cd9bf',
  peach: '#ffac7b',
  rose: '#f691b6',
  gold: '#e9cd69',
};

/** Beta metadata is separate from local collection/preferences. */
export interface RemoteSource {
  officeId: string;
  sessionId: string;
  color?: OfficeColor;
  label: string;
  tags: string[];
  receivedAt: number;
  stale: boolean;
  conversation: boolean;
  send: boolean;
}
export interface PeerInput {
  officeId: string;
  endpoint: string;
  fingerprint: string;
  token: string;
  sendToken?: string;
  /** Optional local host override; absent means exact-identity automatic routing. Never imported. */
  codexHostId?: string;
  color?: OfficeColor;
  label: string;
  tags: string[];
  /** Explicit remote project name -> local project name. View only. */
  projects: Record<string, string>;
}
export interface FederationState {
  enabled: boolean;
  codexHosts?: { id: string; label: string }[];
  error?: string | null;
  peers: (Omit<PeerInput, 'token' | 'sendToken'> & {
    canSend: boolean;
    state: 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'rejected';
    count: number;
    receivedAt: number | null;
    error: string | null;
  })[];
}
export type FederationCommand =
  | { action: 'state' }
  | { action: 'enable'; enabled: boolean }
  | { action: 'add'; peer: PeerInput }
  | {
      action: 'update';
      color?: OfficeColor;
      codexHostId?: string;
      officeId: string;
      label: string;
      tags: string[];
      projects: Record<string, string>;
    }
  | { action: 'remove'; officeId: string };
export const REMOTE_PREFIX = 'remote-office:';
export const isRemoteId = (id: unknown): id is `remote-office:${string}` =>
  typeof id === 'string' && id.startsWith(REMOTE_PREFIX);
export const remoteId = (officeId: string, id: string) => `${REMOTE_PREFIX}${officeId}:${id}`;
export function parseRemoteId(id: string) {
  const match = /^remote-office:([0-9a-f-]{36}):([0-9a-f]{64})$/.exec(id);
  if (!match) throw new Error('Invalid remote office reference');
  return { officeId: match[1], id: match[2] };
}
