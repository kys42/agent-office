import { useSyncExternalStore } from 'react';

/** A message the person sent that the session's record does not show yet. */
export type PendingSend = { id: string; sessionId: string; text: string; at: number };
type Recorded = { id: string; kind: string; text: string; at: number };

// Lives outside the card's inspector, which is remounted on every open or colleague switch:
// a busy Claude can take minutes to read queued input, and the bubble should wait that long.
let pending: PendingSend[] = [];
// Recorded requests that already settled a send. One record settles one send, across updates.
const used = new Set<string>();
const listeners = new Set<() => void>();
let seq = 0;
const LIFETIME = 30 * 60_000;

function publish(next: PendingSend[]) {
  if (next === pending) return;
  pending = next;
  for (const fn of listeners) fn();
}

export function rememberSend(sessionId: string, text: string, now = Date.now()) {
  publish([
    ...pending,
    { id: `sent:${sessionId}:${now}:${seq++}`, sessionId, text: text.trim(), at: now },
  ]);
}

const plain = (text: string) => text.replace(/\s+/g, ' ').trim();
// The record may tidy the words (spacing, hidden secrets, long text cut), so compare loosely.
// Short words must match whole ("ok" is not "ok then run tests"); long ones by their start.
const same = (a: string, b: string) =>
  a === b || (a.length >= 60 && b.length >= 60 && a.slice(0, 60) === b.slice(0, 60));

/**
 * Settles the session's sends against its recorded requests: each record clears one send at
 * most, and only a record from around or after the send. Old sends expire.
 */
export function settleSends(
  list: PendingSend[],
  sessionId: string,
  events: Recorded[],
  taken: Set<string>,
  now = Date.now(),
): PendingSend[] {
  const asked = events
    .filter((e) => e.kind === 'user' && !taken.has(e.id))
    .map((e) => ({ id: e.id, text: plain(e.text), at: e.at }));
  const next = list.filter((p) => {
    if (now - p.at > LIFETIME) return false;
    if (p.sessionId !== sessionId) return true;
    const match = asked.find(
      (e) => !taken.has(e.id) && e.at >= p.at - 10_000 && same(e.text, plain(p.text)),
    );
    if (!match) return true;
    taken.add(match.id);
    return false;
  });
  return next.length === list.length ? list : next;
}

export function settlePending(sessionId: string, events: Recorded[]) {
  publish(settleSends(pending, sessionId, events, used));
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function usePendingSends(): PendingSend[] {
  return useSyncExternalStore(subscribe, () => pending);
}
