import type { Mood, Provider, OfficeEvent } from './types';
export interface MobileSettings {
  enabled: boolean;
  address: string;
  port: number;
  accessCode?: string;
  running: boolean;
  url: string | null;
  addresses: string[];
  error: string | null;
}
export type MobileCommand =
  | { action: 'state' }
  | { action: 'configure'; enabled: boolean; address: string; port: number }
  | { action: 'rotate' };
export interface MobileAgent {
  id: string;
  name: string;
  provider: Provider;
  project: string;
  officeId: string;
  office: string;
  tags: string[];
  status: Mood;
  updatedAt: number;
  preview: string;
  stale: boolean;
  archived: boolean;
}
export interface MobileSnapshot {
  agents: MobileAgent[];
  privacy: boolean;
  sendEnabled: boolean;
  at: number;
  lastSync: number | null;
}
export interface MobileDetail {
  id: string;
  events: Pick<OfficeEvent, 'id' | 'kind' | 'phase' | 'at' | 'text' | 'excerpt'>[];
  older: boolean;
}
export interface MobileReceipt {
  requestId: string;
  status: 'sent' | 'uncertain' | 'blocked';
}
