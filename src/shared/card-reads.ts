import type { OfficeNotice, Preferences } from './types';
import { cardReadNotices } from './notices';

/** How long a card stays on one colleague, in sight, before it reads that colleague's replies. */
export const CARD_READ_DWELL_MS = 1500;
/**
 * The person's reading preferences (#228): whether a card reads at all, and after how long.
 * Missing values keep the behaviour from before (on, CARD_READ_DWELL_MS).
 */
export function cardReadSettings(p?: Pick<Preferences, 'readOnOpen' | 'readDwellSeconds'> | null) {
  const seconds = p?.readDwellSeconds;
  return {
    enabled: p?.readOnOpen !== false,
    dwellMs:
      typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
        ? Math.round(seconds * 1000)
        : CARD_READ_DWELL_MS,
  };
}
/** A receipt that keeps failing is asked again on later snapshots, this many times in all. */
export const CARD_READ_ATTEMPTS = 3;
export const CARD_READ_BUDGET = 4096;

const keyOf = (n: { id: string; version: string }) => `${n.id}\n${n.version}`;

/**
 * What one open of a colleague's work card has read, is reading, and must leave alone.
 *
 * - A version seen read while the card is on the colleague (here, in another window, or before
 *   it opened) is never read by the card again: marked unread on purpose, it stays unread until
 *   the colleague is opened anew.
 * - A receipt in flight is not asked twice; one that failed is asked again later, a few times.
 */
export class CardReads {
  colleague: string;
  /** Versions this open must not read: seen read, or read by it. */
  private done = new Set<string>();
  private pending = new Set<string>();
  private attempts = new Map<string, number>();

  constructor(colleague: string) {
    this.colleague = colleague;
  }

  /** Remember every version of the colleague's runs that is read now. */
  observe(notices: OfficeNotice[], memberIds: Iterable<string>) {
    const ids = new Set(memberIds);
    for (const n of notices) {
      const key = keyOf(n);
      if (!n.seenAt || !ids.has(n.sessionId) || this.done.has(key) || this.pending.has(key))
        continue;
      if (
        this.attempts.has(key) ||
        this.done.size + this.attempts.size + this.pending.size < CARD_READ_BUDGET
      ) {
        this.attempts.delete(key);
        this.done.add(key);
      }
    }
  }

  /** The unread final replies this open may read now. */
  due(notices: OfficeNotice[], memberIds: Iterable<string>) {
    // Once this open exhausts its receipt budget, leave further results unread until a new
    // open/manual action. Never evict an intentional-unread guard and silently read it again.
    if (this.done.size + this.attempts.size >= CARD_READ_BUDGET) return [];
    return cardReadNotices(notices, memberIds)
      .filter((n) => {
        const key = keyOf(n);
        return (
          !this.done.has(key) &&
          !this.pending.has(key) &&
          (this.attempts.get(key) ?? 0) < CARD_READ_ATTEMPTS
        );
      })
      .slice(
        0,
        Math.max(0, CARD_READ_BUDGET - this.done.size - this.attempts.size - this.pending.size),
      );
  }

  begin(list: { id: string; version: string }[]) {
    for (const n of list) this.pending.add(keyOf(n));
  }

  settle(list: { id: string; version: string }[], ok: boolean) {
    for (const n of list) {
      const key = keyOf(n);
      this.pending.delete(key);
      if (ok) {
        this.attempts.delete(key);
        this.done.add(key);
      } else this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
    }
  }
}
