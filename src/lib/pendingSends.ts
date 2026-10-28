import { useSyncExternalStore } from 'react';
import { SAVED_IMAGE_PATH } from '../shared/attachments';

/** A message the person sent that the session's record does not show yet. */
export type PendingSend = {
  id: string;
  sessionId: string;
  text: string;
  at: number;
  /** Images that went with it: the record shows them around the text (see `sameWithImages`). */
  images?: number;
};
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

export function rememberSend(sessionId: string, text: string, now = Date.now(), images = 0) {
  publish([
    ...pending,
    {
      id: `sent:${sessionId}:${now}:${seq++}`,
      sessionId,
      text: text.trim(),
      at: now,
      ...(images > 0 && { images }),
    },
  ]);
}

/** Hide only this local receipt. Never withdraws input from the agent's queue or terminal. */
export function dismissSend(id: string) {
  publish(pending.filter((p) => p.id !== id));
}

// A terminal may record a long paste inside its own paste markers; the words are still the send's.
const PASTE_MARKER = /<\/?pasted_content(?:\s+id="[^"]*")?\s*>/g;
const plain = (text: string) =>
  text
    .replace(PASTE_MARKER, ' ')
    .normalize('NFC')
    .replace(/[\u200b\u2060\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
// The record may tidy the words (spacing, hidden secrets, long text cut), so compare loosely.
// Short words must match whole ("ok" is not "ok then run tests"); long ones by their start.
const same = (a: string, b: string) =>
  a === b || (a.length >= 60 && b.length >= 60 && a.slice(0, 60) === b.slice(0, 60));

/**
 * A request recorded for a send with `images` images, its text being `text`. Each agent records
 * them differently: Claude Code puts `[Image #N]` (or, when it did not attach one, the pasted
 * path) before the text; the Codex queue gets the text, then the saved paths; Codex Desktop
 * records the text alone. Exactly `images` of them, at that place only.
 */
export function sameWithImages(recorded: string, text: string, images: number): boolean {
  const record = plain(recorded);
  const want = plain(text);
  if (same(record, want)) return true;
  if (images <= 0) return false;
  const before = new RegExp(`^(?:(?:\\[Image #\\d+\\]|${SAVED_IMAGE_PATH}) ?){${images}}`);
  const lead = before.exec(record);
  if (lead && same(record.slice(lead[0].length).trim(), want)) return true;
  const after = new RegExp(`^(?: ?${SAVED_IMAGE_PATH}){${images}}$`);
  return record.startsWith(want) && after.test(record.slice(want.length));
}

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
    .filter((e) => e.kind === 'user' && !taken.has(`${sessionId}:${e.id}`))
    .map((e) => ({ id: e.id, text: plain(e.text), at: e.at }));
  const next = list.filter((p) => {
    if (now - p.at > LIFETIME) return false;
    if (p.sessionId !== sessionId) return true;
    const match = asked.find(
      (e) =>
        !taken.has(`${sessionId}:${e.id}`) &&
        e.at >= p.at - 10_000 &&
        sameWithImages(e.text, p.text, p.images ?? 0),
    );
    if (!match) return true;
    taken.add(`${sessionId}:${match.id}`);
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
