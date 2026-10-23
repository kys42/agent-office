/** Beta metadata is separate from local collection/preferences. */
export interface RemoteSource {
  officeId: string;
  sessionId: string;
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
  /** Local-only explicit Codex remote connection; never imported from a peer. */
  codexHostId?: string;
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
