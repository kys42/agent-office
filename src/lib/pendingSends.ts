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
  /** Delivery succeeded, but this provider does not put image-only input in its transcript. */
  unrecorded?: boolean;
  /** Only a digest is persisted. Other windows/restarts show a text-free receipt. */
  fingerprint?: string;
  restored?: boolean;
};
type Recorded = { id: string; kind: string; text: string; at: number };

// Lives outside the card's inspector, which is remounted on every open or colleague switch:
// a busy Claude can take minutes to read queued input, and the bubble should wait that long.
let pending: PendingSend[] = [];
// Recorded requests that already settled a send. One record settles one send, across updates.
const used = new Set<string>();
const listeners = new Set<() => void>();
const LIFETIME = 30 * 60_000;
const PREFIX = 'office:sent:v1:';
const TAKEN = 'office:sent-used:v1:';
const MAX_RECEIPTS = 50;
const MAX_USED = 1000;
const volatile = new Map<string, PendingSend>();

export function decodePending(value: unknown, now = Date.now()): PendingSend | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as PendingSend;
  if (
    typeof p.id !== 'string' ||
    !p.id.startsWith('sent:') ||
    p.id.length > 1000 ||
    typeof p.sessionId !== 'string' ||
    p.sessionId.length > 500 ||
    Object.hasOwn(p, 'text') ||
    (p.fingerprint !== undefined &&
      (typeof p.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(p.fingerprint))) ||
    !Number.isFinite(p.at) ||
    p.at > now + 10000 ||
    now - p.at > LIFETIME ||
    (p.images !== undefined && (!Number.isInteger(p.images) || p.images < 0 || p.images > 5))
  )
    return null;
  return {
    id: p.id,
    sessionId: p.sessionId,
    text: '',
    restored: true,
    ...(p.fingerprint && { fingerprint: p.fingerprint }),
    at: p.at,
    ...(p.images && { images: p.images }),
    ...(p.unrecorded === true && { unrecorded: true }),
  };
}

// Same local-only retention as composer drafts, with a 30-minute expiry and 50-receipt cap.
// Each receipt has its own key: independent native windows cannot overwrite another's send.
function saved(): PendingSend[] | null {
  try {
    const rows: PendingSend[] = [];
    const keys = Object.keys(localStorage);
    const markers: { id: string; at: number }[] = [];
    const now = Date.now();
    const memory = new Map(pending.map((p) => [p.id, p]));
    for (const key of keys) {
      if (key.startsWith(TAKEN)) {
        const at = Number(localStorage.getItem(key));
        if (!Number.isFinite(at) || now - at > LIFETIME || at > now + 10000)
          localStorage.removeItem(key);
        else markers.push({ id: key.slice(TAKEN.length), at });
      }
      if (!key.startsWith(PREFIX)) continue;
      let row: PendingSend | null = null;
      try {
        row = decodePending(JSON.parse(localStorage.getItem(key) || 'null'));
      } catch {}
      if (!row || key !== PREFIX + row.id) localStorage.removeItem(key);
      else rows.push(memory.get(row.id) ?? row);
    }
    markers.sort((a, b) => b.at - a.at);
    for (const marker of markers.slice(MAX_USED)) localStorage.removeItem(TAKEN + marker.id);
    used.clear();
    for (const marker of markers.slice(0, MAX_USED)) used.add(marker.id);
    for (const [id, row] of volatile) {
      if (now - row.at > LIFETIME) volatile.delete(id);
      else if (!rows.some((p) => p.id === id)) rows.push(row);
    }
    rows.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
    for (const row of rows.slice(MAX_RECEIPTS)) localStorage.removeItem(PREFIX + row.id);
    const next = rows.slice(0, MAX_RECEIPTS).reverse();
    return next.length === pending.length && next.every((p, i) => p === pending[i])
      ? pending
      : next;
  } catch {
    return null;
  }
}
pending = saved() ?? [];
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key.startsWith(PREFIX) || event.key.startsWith(TAKEN)) {
      const rows = saved();
      if (rows) publish(rows, false);
    }
  });

function publish(next: PendingSend[], persist = true) {
  if (next === pending) return;
  if (persist) {
    try {
      const ids = new Set(next.map((p) => p.id));
      for (const p of pending)
        if (!ids.has(p.id)) {
          volatile.delete(p.id);
          localStorage.removeItem(PREFIX + p.id);
        }
      const old = new Set(pending.map((p) => p.id));
      for (const p of next)
        if (!old.has(p.id)) {
          const { text: _text, restored: _restored, ...receipt } = p;
          try {
            localStorage.setItem(PREFIX + p.id, JSON.stringify(receipt));
            volatile.delete(p.id);
          } catch {
            volatile.set(p.id, p);
          }
        }
    } catch {
      /* Keep receipts in memory when local storage is unavailable. */
    }
  }
  pending = next;
  for (const fn of listeners) fn();
}

export async function rememberSend(
  sessionId: string,
  text: string,
  now = Date.now(),
  images = 0,
  unrecorded = false,
) {
  const fingerprint = await receiptHash(text);
  pending = saved() ?? pending;
  publish([
    ...pending.slice(-(MAX_RECEIPTS - 1)),
    {
      id: `sent:${globalThis.crypto?.randomUUID?.() ?? `${now}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`}`,
      sessionId,
      text: text.trim().slice(0, 20000),
      at: now,
      ...(fingerprint && { fingerprint }),
      ...(images > 0 && { images }),
      ...(unrecorded && { unrecorded }),
    },
  ]);
}

/** Hide only this local receipt. Never withdraws input from the agent's queue or terminal. */
export function dismissSend(id: string) {
  pending = saved() ?? pending;
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
  matches = (p: PendingSend, e: Pick<Recorded, 'id' | 'text' | 'at'>) =>
    sameWithImages(e.text, p.text, p.images ?? 0),
): PendingSend[] {
  const asked = events
    .filter((e) => e.kind === 'user' && !taken.has(`${sessionId}:${e.id}`))
    .map((e) => ({ id: e.id, text: plain(e.text), at: e.at }));
  const next = list.filter((p) => {
    if (now - p.at > LIFETIME) return false;
    if (p.sessionId !== sessionId) return true;
    const match = asked.find(
      (e) => !taken.has(`${sessionId}:${e.id}`) && e.at >= p.at - 10_000 && matches(p, e),
    );
    if (!match) return true;
    taken.add(`${sessionId}:${match.id}`);
    return false;
  });
  return next.length === list.length ? list : next;
}

/** Hash the same whole-short / prefix-long comparison without persisting prompt contents. */
async function receiptHash(text: string): Promise<string | null> {
  try {
    const normalized = plain(text);
    const bytes = new TextEncoder().encode(
      `${normalized.length < 60 ? 'whole' : 'prefix'}:${normalized.slice(0, 60)}`,
    );
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) =>
      x.toString(16).padStart(2, '0'),
    ).join('');
  } catch {
    // The receipt still exists if WebCrypto is unavailable; do not guess transcript matches.
    return null;
  }
}

function recordForms(text: string, images: number): string[] {
  const record = plain(text);
  if (!images) return [record];
  const lead = new RegExp(`^(?:(?:\\[Image #\\d+\\]|${SAVED_IMAGE_PATH}) ?){${images}}`).exec(
    record,
  );
  const tail = new RegExp(`(?: ?${SAVED_IMAGE_PATH}){${images}}$`).exec(record);
  return [
    record,
    ...(lead ? [record.slice(lead[0].length).trim()] : []),
    ...(tail ? [record.slice(0, tail.index).trim()] : []),
  ];
}

// Serializing settlement avoids two open inspectors consuming the same record in one renderer.
let settlement = Promise.resolve();
export function settlePending(sessionId: string, events: Recorded[]) {
  const reconcile = async () => {
    if (!pending.length) return;
    const stored = saved();
    if (stored) publish(stored, false);
    if (!pending.some((p) => p.sessionId === sessionId)) return;
    const images = new Set(
      pending.filter((p) => p.restored && p.sessionId === sessionId).map((p) => p.images ?? 0),
    );
    const fingerprints = new Map<string, (string | null)[]>();
    await Promise.all(
      events
        .filter((e) => e.kind === 'user')
        .flatMap((e) =>
          [...images].map(async (n) =>
            fingerprints.set(
              `${e.id}:${n}`,
              await Promise.all(recordForms(e.text, n).map(receiptHash)),
            ),
          ),
        ),
    );
    // Storage may have changed while digesting. Re-read before reconciling/deleting receipts.
    const latest = saved();
    if (latest) publish(latest, false);
    const prior = new Set(used);
    const next = settleSends(pending, sessionId, events, used, Date.now(), (p, e) =>
      p.restored
        ? !!p.fingerprint && !!fingerprints.get(`${e.id}:${p.images ?? 0}`)?.includes(p.fingerprint)
        : sameWithImages(e.text, p.text, p.images ?? 0),
    );
    try {
      for (const id of used)
        if (!prior.has(id)) localStorage.setItem(TAKEN + id, String(Date.now()));
    } catch {
      /* In-memory settlement still works. */
    }
    publish(next);
  };
  settlement = settlement
    .then(async () => {
      if (typeof navigator !== 'undefined' && navigator.locks)
        await navigator.locks.request('office:receipt-settlement:v1', reconcile);
      else await reconcile();
    })
    .catch(() => {
      /* A receipt stays visible if reconciliation is unavailable. */
    });
  return settlement;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function usePendingSends(): PendingSend[] {
  return useSyncExternalStore(subscribe, () => pending);
}
