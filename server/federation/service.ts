import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { OfficeService } from '../service.js';
import type { Snapshot } from '../../src/shared/types.js';
import { isRemoteId } from '../../src/shared/federation.js';
import {
  diffSnapshot,
  indexSnapshot,
  type SnapshotPatch,
} from '../../src/shared/snapshot-patch.js';
import { attachSessions } from '../../src/shared/office.js';
import { PeerManager } from './peers.js';

const sessionMethods = new Set([
  'detail',
  'visit',
  'returnToOffice',
  'artifacts',
  'patch',
  'bookmark',
  'unbookmarkMessage',
  'handoff',
  'remote-send',
]);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Inspect references, never arbitrary notes, titles, search text or project names. */
function remoteReferences(method: string, args: unknown[]): boolean {
  const input = record(args[0]);
  let references: unknown[] = [];
  if (['veil', 'pin', 'reorderSeats', 'identities'].includes(method)) references = list(args[0]);
  if (method === 'bookmarks') references = list(input.sessionIds);
  if (method === 'notices') references = list(args[0]).map((item) => record(item).id);
  if (['unbookmark', 'bookmarkNote', 'bookmarkById', 'readReplies'].includes(method))
    references = [args[0]];
  if (['bookmark', 'unbookmarkMessage'].includes(method)) references = [args[1]];
  if (method === 'preferences') {
    references = list(input.zoneRules)
      .map(record)
      .filter((rule) => rule.match === 'session')
      .map((rule) => rule.value);
    references.push(...Object.keys(record(record(input.petAppearance).colleagues)));
  }
  return references.some(isRemoteId);
}

/** Desktop-only composition. Existing HTTP/MCP and local store retain their original API. */
export class FederatedService extends EventEmitter {
  private localSnapshot?: Snapshot;
  private published?: Snapshot;
  private epoch = randomUUID();
  private version = 0;
  constructor(
    private local: OfficeService,
    readonly peers: PeerManager,
  ) {
    super();
    local.on('snapshot', (s: Snapshot, patch?: SnapshotPatch) => {
      this.localSnapshot = s;
      if (!peers.enabled) {
        this.published = undefined;
        this.emit('snapshot', s, patch);
      } else this.publish();
    });
    peers.on('change', () => {
      if (peers.enabled) this.publish();
      else {
        this.published = undefined;
        this.epoch = randomUUID();
        this.version = 0;
        if (this.localSnapshot) this.emit('snapshot', this.localSnapshot);
      }
    });
  }
  private compose(local: Snapshot): Snapshot {
    const sessions = local.sessions;
    const remote = this.peers
      .sessions()
      .filter(
        (s) =>
          local.preferences.enabledProviders.includes(s.provider) &&
          !local.preferences.excludedProjects.includes(s.project),
      );
    return {
      ...local,
      sessions: attachSessions([...sessions, ...remote]),
      epoch: this.epoch,
      version: this.version,
      federation: this.peers.state(),
    };
  }
  private publish(): Snapshot | undefined {
    if (!this.localSnapshot || !this.peers.enabled) return;
    const next = this.compose(this.localSnapshot);
    const previous = this.published;
    const diff = previous ? diffSnapshot(indexSnapshot(previous), next) : undefined;
    if (diff && !Object.keys(diff).length) return previous;
    next.version = ++this.version;
    this.published = next;
    this.emit(
      'snapshot',
      next,
      previous && diff
        ? {
            ...diff,
            kind: 'patch',
            epoch: this.epoch,
            base: previous.version,
            version: next.version,
          }
        : undefined,
    );
    return next;
  }
  async call(
    method: string,
    args: unknown[] = [],
    authorized?: () => Promise<void>,
  ): Promise<unknown> {
    if (method === 'federation') return this.peers.command(args[0]);
    if (method === 'remote-launch') {
      const [id, spec, start] = args;
      if (!isRemoteId(id)) throw Error('Remote session unavailable');
      const verify = async () => {
        const local = (await this.local.call('snapshot')) as Snapshot;
        if (!this.compose(local).sessions.some((s) => s.id === id))
          throw Error('Remote session unavailable');
        await authorized?.();
      };
      await verify();
      return this.peers.launchSession(
        id as string,
        spec,
        start as Parameters<PeerManager['launchSession']>[2],
        verify,
      );
    }
    if (method === 'remote-targets') {
      const ids = args[0];
      if (!Array.isArray(ids) || ids.length > 200 || ids.some((id) => !isRemoteId(id)))
        throw new Error('Invalid targets');
      const local = (await this.local.call('snapshot')) as Snapshot;
      const visible = new Set(this.compose(local).sessions.map((s) => s.id));
      return this.peers.targets(ids.filter((id) => visible.has(id)));
    }
    const id = args[0];
    if (sessionMethods.has(method) && isRemoteId(id)) {
      if (method === 'detail' || method === 'remote-send') {
        const local = (await this.local.call('snapshot')) as Snapshot;
        const visible = this.compose(local).sessions.some((s) => s.id === id);
        if (!visible) throw new Error('Remote session unavailable');
        if (method === 'remote-send') {
          if (typeof args[1] !== 'string' || args[1].length > 20000 || typeof args[2] !== 'string')
            throw new Error('Invalid send');
          return this.peers.send(id, args[1], args[2], async () => {
            const latest = (await this.local.call('snapshot')) as Snapshot;
            if (!this.compose(latest).sessions.some((s) => s.id === id))
              throw Error('Remote session unavailable');
            await authorized?.();
          });
        }
        return this.peers.detail(id);
      }
      if (method === 'visit') return this.call('snapshot'); // Read-only: no local visit record.
      if (method === 'artifacts') return [];
      throw new Error('Remote Office is read-only in this beta');
    }
    // Remote references still cannot reach local writes, even after the beta is disabled.
    if (remoteReferences(method, args)) {
      if (method === 'bookmarks') return { bookmarks: [], more: false, total: 0 };
      if (method === 'bookmarkById') return null;
      throw new Error('Remote Office is read-only in this beta');
    }
    const result = await this.local.call(method, args);
    if (this.peers.enabled && result && typeof result === 'object') {
      if ('sessions' in result && 'preferences' in result) {
        this.localSnapshot = result as Snapshot;
        return this.publish();
      }
      if ('snapshot' in result) {
        this.localSnapshot = (result as { snapshot: Snapshot }).snapshot;
        return { ...result, snapshot: this.publish() };
      }
    }
    return result;
  }
  start() {
    this.local.start();
    this.peers.start();
  }
  async shutdown() {
    this.peers.close();
    await this.local.shutdown();
  }
}
