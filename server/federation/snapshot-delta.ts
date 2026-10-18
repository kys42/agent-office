import {
  MAX_BYTES,
  wireId,
  type WireSnapshot,
  type WireDelta,
  type WireSession,
} from './protocol.js';

/** Only hashes of the previous version, never another retained copy of its messages. */
export class SnapshotVersions {
  private current?: { signature: string; version: number; hashes: Map<string, string> };
  private previous?: { version: number; hashes: Map<string, string> };
  clear() {
    this.current = this.previous = undefined;
  }
  update(signature: string, sessions: WireSession[]) {
    if (this.current?.signature === signature) return this.current.version;
    this.previous = this.current && { version: this.current.version, hashes: this.current.hashes };
    this.current = {
      signature,
      version: (this.current?.version ?? 0) + 1,
      hashes: new Map(sessions.map((s) => [s.id, wireId(JSON.stringify(s))])),
    };
    return this.current.version;
  }
  delta(
    snapshot: WireSnapshot,
    epoch: string | null,
    version: string | null,
  ): WireDelta | undefined {
    if (epoch !== snapshot.epoch || version !== String(this.previous?.version) || !this.previous)
      return;
    const { protocol: _, ...base } = snapshot;
    return {
      ...base,
      delta: true,
      base: this.previous.version,
      sessions: snapshot.sessions.filter(
        (s) => this.previous!.hashes.get(s.id) !== this.current!.hashes.get(s.id),
      ),
      removed: [...this.previous.hashes.keys()].filter((id) => !this.current!.hashes.has(id)),
      order: snapshot.sessions.map((s) => s.id),
    };
  }
}
export function applyDelta(previous: WireSnapshot | undefined, delta: WireDelta): WireSnapshot {
  if (
    !previous ||
    previous.officeId !== delta.officeId ||
    previous.epoch !== delta.epoch ||
    previous.version !== delta.base ||
    delta.version <= delta.base
  )
    throw Error('Invalid delta base');
  const changed = new Set(delta.sessions.map((s) => s.id));
  const removed = new Set(delta.removed),
    order = new Set(delta.order);
  if (
    changed.size !== delta.sessions.length ||
    removed.size !== delta.removed.length ||
    order.size !== delta.order.length ||
    order.size > 900 ||
    [...changed].some((id) => removed.has(id))
  )
    throw Error('Invalid delta identities');
  const byId = new Map(previous.sessions.map((s) => [s.id, s]));
  for (const id of removed) if (!byId.delete(id)) throw Error('Unknown removal');
  for (const s of delta.sessions) byId.set(s.id, s);
  if (byId.size !== order.size || [...order].some((id) => !byId.has(id)))
    throw Error('Invalid delta order');
  const result: WireSnapshot = {
    protocol: 1,
    officeId: delta.officeId,
    epoch: delta.epoch,
    version: delta.version,
    sampledAt: delta.sampledAt,
    paused: delta.paused,
    conversation: delta.conversation,
    sessions: delta.order.map((id) => byId.get(id)!),
  };
  // Bound the assembled state, not just each individual HTTP response. Count
  // one session at a time to avoid a second giant serialized snapshot string.
  let bytes = Buffer.byteLength(JSON.stringify({ ...result, sessions: [] }));
  for (const [i, session] of result.sessions.entries()) {
    bytes += Buffer.byteLength(JSON.stringify(session)) + (i ? 1 : 0);
    if (bytes > MAX_BYTES) throw Error('Delta snapshot exceeds byte budget');
  }
  return result;
}
