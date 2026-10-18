import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { OfficeService } from '../service.js';
import type { Snapshot, Session } from '../../src/shared/types.js';
import { isRemoteId } from '../../src/shared/federation.js';
import {
  diffSnapshot,
  indexSnapshot,
  type SnapshotPatch,
} from '../../src/shared/snapshot-patch.js';
import { attachSessions } from '../../src/shared/office.js';
import { PeerManager, linkedProjectKey } from './peers.js';

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
    const linked = this.peers.linkedProjects();
    const sessions: Session[] = local.sessions.map((s) =>
      linked.has(s.project)
        ? {
            ...s,
            area: {
              key: linkedProjectKey(s.project),
              name: s.project,
              ruleId: 'federation-local-view',
              match: 'session',
            },
          }
        : s,
    );
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
  async call(method: string, args: unknown[] = []): Promise<unknown> {
    if (method === 'federation') return this.peers.command(args[0]);
    const id = args[0];
    if (isRemoteId(id)) {
      if (method === 'detail') {
        const local = (await this.local.call('snapshot')) as Snapshot;
        const visible = this.compose(local).sessions.some((s) => s.id === id);
        if (!visible) throw new Error('Remote session unavailable');
        return this.peers.detail(id);
      }
      if (method === 'visit') return this.call('snapshot'); // Read-only: no local visit record.
      if (method === 'artifacts') return [];
      throw new Error('Remote Office is read-only in this beta');
    }
    // Reject remote IDs hidden in batch mutations/query objects before reaching the local store.
    const hasRemote = (v: unknown): boolean =>
      isRemoteId(v) ||
      (Array.isArray(v)
        ? v.some(hasRemote)
        : !!v && typeof v === 'object' && Object.values(v).some(hasRemote));
    if (hasRemote(args)) {
      if (method === 'bookmarks') return { bookmarks: [], more: false, total: 0 };
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
