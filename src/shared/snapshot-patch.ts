import type { OfficeNotice, Session, Snapshot } from './types';

/**
 * What changed in the office since version `base` of the same collector run: the colleagues
 * and notices that are new or different, the ones that left, the order when it moved, and the
 * other snapshot fields that changed. Unchanged colleagues are not sent at all.
 */
export interface SnapshotPatch {
  kind: 'patch';
  epoch: string;
  base: number;
  version: number;
  sessions?: Session[];
  removed?: string[];
  order?: string[];
  notices?: OfficeNotice[];
  removedNotices?: string[];
  noticeOrder?: string[];
  fields?: Partial<Omit<Snapshot, 'sessions' | 'notices' | 'version' | 'epoch'>>;
}
/** A whole office, or what changed in it. */
export type SnapshotMessage = Snapshot | SnapshotPatch;
export const isPatch = (m: SnapshotMessage): m is SnapshotPatch =>
  (m as SnapshotPatch).kind === 'patch';

type Field = keyof NonNullable<SnapshotPatch['fields']>;
/** Each part of a snapshot as it was sent, to tell next time what changed. */
export interface SnapshotIndex {
  sessions: Map<string, string>;
  notices: Map<string, string>;
  order: string;
  noticeOrder: string;
  fields: Map<Field, string>;
}
const FIELDS_SKIPPED = new Set(['sessions', 'notices', 'version', 'epoch']);
export function indexSnapshot(s: Snapshot): SnapshotIndex {
  const fields = new Map<Field, string>();
  for (const [key, value] of Object.entries(s))
    if (!FIELDS_SKIPPED.has(key)) fields.set(key as Field, JSON.stringify(value ?? null));
  const notices = s.notices ?? [];
  return {
    sessions: new Map(s.sessions.map((x) => [x.id, JSON.stringify(x)])),
    notices: new Map(notices.map((n) => [n.id, JSON.stringify(n)])),
    order: s.sessions.map((x) => x.id).join('\n'),
    noticeOrder: notices.map((n) => n.id).join('\n'),
    fields,
  };
}
/** The parts of `next` that differ from what `prev` indexed; empty parts are left out. */
export function diffSnapshot(
  prev: SnapshotIndex,
  next: Snapshot,
  index: SnapshotIndex = indexSnapshot(next),
): Omit<SnapshotPatch, 'kind' | 'epoch' | 'base' | 'version'> {
  const patch: Omit<SnapshotPatch, 'kind' | 'epoch' | 'base' | 'version'> = {};
  const sessions = next.sessions.filter(
    (s) => prev.sessions.get(s.id) !== index.sessions.get(s.id),
  );
  if (sessions.length) patch.sessions = sessions;
  const removed = [...prev.sessions.keys()].filter((id) => !index.sessions.has(id));
  if (removed.length) patch.removed = removed;
  if (prev.order !== index.order) patch.order = next.sessions.map((s) => s.id);
  const notices = (next.notices ?? []).filter(
    (n) => prev.notices.get(n.id) !== index.notices.get(n.id),
  );
  if (notices.length) patch.notices = notices;
  const removedNotices = [...prev.notices.keys()].filter((id) => !index.notices.has(id));
  if (removedNotices.length) patch.removedNotices = removedNotices;
  if (prev.noticeOrder !== index.noticeOrder)
    patch.noticeOrder = (next.notices ?? []).map((n) => n.id);
  const fields: Record<string, unknown> = {};
  for (const [key, value] of index.fields)
    if (prev.fields.get(key) !== value) fields[key] = next[key];
  for (const key of prev.fields.keys()) if (!index.fields.has(key)) fields[key] = undefined;
  if (Object.keys(fields).length) patch.fields = fields as SnapshotPatch['fields'];
  return patch;
}
function merged<T extends { id: string }>(
  items: T[],
  changed: T[] | undefined,
  removed: string[] | undefined,
  order: string[] | undefined,
): T[] {
  if (!changed?.length && !removed?.length && !order) return items;
  const byId = new Map(items.map((x) => [x.id, x]));
  for (const id of removed ?? []) byId.delete(id);
  for (const x of changed ?? []) byId.set(x.id, x);
  // Membership changes always come with the new order; without one, order and members stay.
  return (order ?? items.map((x) => x.id)).flatMap((id) => {
    const x = byId.get(id);
    return x ? [x] : [];
  });
}
/** `snapshot` with `patch` applied. Colleagues and notices that did not change keep their objects. */
export function applyPatch(snapshot: Snapshot, patch: SnapshotPatch): Snapshot {
  const next: Snapshot = {
    ...snapshot,
    ...patch.fields,
    sessions: merged(snapshot.sessions, patch.sessions, patch.removed, patch.order),
    version: patch.version,
    epoch: patch.epoch,
  };
  if (snapshot.notices || patch.notices || patch.noticeOrder)
    next.notices = merged(
      snapshot.notices ?? [],
      patch.notices,
      patch.removedNotices,
      patch.noticeOrder,
    );
  return next;
}
/** Consecutive patches as one, for a client that is several versions behind. */
export function composePatches(patches: SnapshotPatch[]): SnapshotPatch {
  const [first, ...rest] = patches;
  let out: SnapshotPatch = { ...first };
  for (const p of rest) {
    const sessions = new Map((out.sessions ?? []).map((s) => [s.id, s]));
    for (const s of p.sessions ?? []) sessions.set(s.id, s);
    const removed = new Set(out.removed ?? []);
    for (const id of p.removed ?? []) {
      removed.add(id);
      sessions.delete(id);
    }
    for (const s of p.sessions ?? []) removed.delete(s.id);
    const notices = new Map((out.notices ?? []).map((n) => [n.id, n]));
    for (const n of p.notices ?? []) notices.set(n.id, n);
    const removedNotices = new Set(out.removedNotices ?? []);
    for (const id of p.removedNotices ?? []) {
      removedNotices.add(id);
      notices.delete(id);
    }
    for (const n of p.notices ?? []) removedNotices.delete(n.id);
    out = {
      kind: 'patch',
      epoch: p.epoch,
      base: out.base,
      version: p.version,
      ...(sessions.size ? { sessions: [...sessions.values()] } : {}),
      ...(removed.size ? { removed: [...removed] } : {}),
      ...((p.order ?? out.order) ? { order: p.order ?? out.order } : {}),
      ...(notices.size ? { notices: [...notices.values()] } : {}),
      ...(removedNotices.size ? { removedNotices: [...removedNotices] } : {}),
      ...((p.noticeOrder ?? out.noticeOrder)
        ? { noticeOrder: p.noticeOrder ?? out.noticeOrder }
        : {}),
      ...(out.fields || p.fields ? { fields: { ...out.fields, ...p.fields } } : {}),
    };
  }
  return out;
}
/**
 * `next` (a whole office) reusing the colleague and notice objects of `prev` that did not
 * change, so a full snapshot (after a change of ours, or a resync) redraws only what moved.
 * An older version of the same run than `prev` is dropped.
 */
export function adoptSnapshot(prev: Snapshot | null, next: Snapshot): Snapshot {
  if (!prev) return next;
  // The same or an older version of this run (a reply that lost the race with a push).
  if (next.epoch && prev.epoch === next.epoch && next.version <= prev.version) return prev;
  const reuse = <T extends { id: string }>(was: T[] | undefined, now: T[] | undefined) => {
    if (!was || !now) return now;
    const old = new Map(was.map((x) => [x.id, x]));
    return now.map((x) => {
      const o = old.get(x.id);
      return o && JSON.stringify(o) === JSON.stringify(x) ? o : x;
    });
  };
  return {
    ...next,
    sessions: reuse(prev.sessions, next.sessions)!,
    notices: reuse(prev.notices, next.notices),
  };
}
