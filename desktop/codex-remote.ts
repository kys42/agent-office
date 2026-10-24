import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { wireId } from '../server/federation/protocol.js';
import { desktopOwnsThread, remoteCodexHost, sendToCodexDesktop } from './codex-desktop.js';

export interface CodexRelay {
  hosts(): { id: string; label: string }[];
  resolve(host: string, opaqueId: string): string | null;
  available(host: string, thread: string): Promise<boolean>;
  prepare?: (host: string, thread: string, authorize: () => Promise<void>) => Promise<void>;
  send(host: string, thread: string, text: string, authorize: () => Promise<void>): Promise<void>;
}
/** Read only the local app's explicit thread/host assignments. Never infer identity from titles. */
export class DesktopCodexRelay implements CodexRelay {
  readonly prepare?: CodexRelay['prepare'];
  constructor(
    private home: string,
    openConversation = process.platform === 'darwin'
      ? async (url: string) => {
          await promisify(execFile)('/usr/bin/open', [url], { timeout: 5000 });
        }
      : undefined,
  ) {
    if (openConversation)
      this.prepare = async (host, thread, authorize) => {
        const current = () => this.resolve(host, wireId(`codex:${thread}`)) === thread;
        if (!current()) throw Error('Remote conversation changed');
        await authorize();
        if (!current()) throw Error('Remote conversation changed');
        // Only an explicit send opens the existing app conversation. Never put message text in URLs.
        const url = new URL(`codex://threads/${thread}`);
        url.searchParams.set('hostId', host);
        await openConversation(url.toString());
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          if (!current()) throw Error('Remote conversation changed');
          await authorize();
          if (await this.available(host, thread)) return;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw Error('Codex conversation connection timed out');
      };
  }
  private cached?: {
    signature: string;
    value: { memberships: Record<string, string>; labels: Record<string, string> };
  };
  private metadata(): { memberships: Record<string, string>; labels: Record<string, string> } {
    const empty = { memberships: {}, labels: {} };
    try {
      const file = path.join(this.home, '.codex-global-state.json');
      const stat = statSync(file);
      if (stat.size > 16 * 1024 * 1024) return empty;
      const signature = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      if (this.cached?.signature === signature) return this.cached.value;
      const state = JSON.parse(readFileSync(file, 'utf8'));
      const assignments = new Map<string, Set<string>>();
      const add = (id: unknown, host: unknown) => {
        if (
          typeof id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id) ||
          typeof host !== 'string' ||
          (host !== 'local' && !remoteCodexHost(host))
        )
          return;
        const hosts = assignments.get(id) ?? new Set<string>();
        hosts.add(host);
        assignments.set(id, hosts);
      };
      const membership = state['thread-project-membership-host-ids'];
      if (membership && typeof membership === 'object' && !Array.isArray(membership))
        for (const [id, host] of Object.entries(membership)) add(id, host);
      const atoms = state['electron-persisted-atom-state'];
      if (atoms && typeof atoms === 'object')
        for (const [key, value] of Object.entries(atoms)) {
          const prefix = 'remote-thread-summaries-v3:';
          if (!key.startsWith(prefix) || !Array.isArray(value)) continue;
          const host = key.slice(prefix.length);
          for (const item of value) if (item?.hostId === host) add(item.conversationId, host);
        }
      const labels: Record<string, string> = {};
      if (Array.isArray(state['codex-managed-remote-connections']))
        for (const item of state['codex-managed-remote-connections'])
          if (remoteCodexHost(item?.hostId ?? '') && typeof item.displayName === 'string')
            labels[item.hostId] = item.displayName.slice(0, 80);
      const value = {
        memberships: Object.fromEntries(
          [...assignments]
            .filter(([, hosts]) => hosts.size === 1 && !hosts.has('local'))
            .map(([id, hosts]) => [id, [...hosts][0]]),
        ),
        labels,
      };
      this.cached = { signature, value };
      return value;
    } catch {
      return empty;
    }
  }
  hosts() {
    const { memberships, labels } = this.metadata();
    return [...new Set(Object.values(memberships))]
      .sort()
      .map((id) => ({ id, label: labels[id] ? `${labels[id]} · ${id}` : id }));
  }
  resolve(host: string, opaqueId: string) {
    if (!remoteCodexHost(host)) return null;
    return (
      Object.entries(this.metadata().memberships).find(
        ([id, owner]) => owner === host && wireId(`codex:${id}`) === opaqueId,
      )?.[0] ?? null
    );
  }
  available(host: string, thread: string) {
    return desktopOwnsThread(this.home, thread, 2000, host);
  }
  async send(host: string, thread: string, text: string, authorize: () => Promise<void>) {
    await sendToCodexDesktop(this.home, thread, text, 15000, authorize, host);
  }
}
