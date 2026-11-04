import type { OfficeNotice } from './types';
import { isAttentionNotice, isFinalNotice, isInboxNotice } from './notices';
import { ARRIVAL_LAG_MS, ARRIVAL_MS } from './speech';

/**
 * The snapshot carries a bounded set of notices; a conversation reads the rest of its own
 * excerpts with its pages, in the same order.
 */
/** The most recent notices carried whatever their kind. */
export const RECENT_NOTICES = 100;
/** Unread finals carried at most (newest first); counts still cover the rest. */
export const UNREAD_FINALS = 1000;

/** Newest first, then by id: a total order, so a cursor never skips or repeats a notice. */
export const noticeOrder = (a: OfficeNotice, b: OfficeNotice) =>
  b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * What the office needs live, out of every visible notice (in `noticeOrder`): each session's
 * latest notice (its bubble or peek), latest request (the quote above it) and latest
 * conversation (whether a hidden colleague came back) and latest unread result (its badge),
 * just-arrived requests, every open call, every unread final up to `UNREAD_FINALS`, and the
 * `RECENT_NOTICES` newest of any kind.
 * Unread counts come from all of them, not from this set.
 */
export function residentNotices(notices: OfficeNotice[], now = Date.now()): OfficeNotice[] {
  const keep = new Set<string>();
  const latest = new Map<string, OfficeNotice>();
  const seen = new Set<string>();
  let finals = 0;
  notices.forEach((n, i) => {
    if (i < RECENT_NOTICES || isAttentionNotice(n)) keep.add(n.id);
    else if (n.kind === 'request' && now - n.at < ARRIVAL_MS + ARRIVAL_LAG_MS) keep.add(n.id);
    else if (!n.seenAt && isInboxNotice(n) && finals < UNREAD_FINALS) keep.add(n.id);
    // Counts every unread inbox final, carried for another reason or not, so the cap keeps
    // the newest `UNREAD_FINALS` of them (open calls are all carried regardless).
    if (!n.seenAt && isFinalNotice(n) && !n.background) finals++;
    // The bubble picks the latest by time, then by arrival: keep every notice tied for it.
    const top = latest.get(n.sessionId);
    if (!top) latest.set(n.sessionId, n);
    if (!top || top.at === n.at) keep.add(n.id);
    for (const kind of [
      n.kind === 'request' && 'request',
      (n.kind === 'request' || isFinalNotice(n) || n.kind === 'attention' || n.kind === 'error') &&
        'conversation',
      // Every colleague with an unread result keeps one past the cap (its badge and triage).
      !n.seenAt && isInboxNotice(n) && 'unread',
    ])
      if (kind && !seen.has(`${n.sessionId}\n${kind}`)) {
        seen.add(`${n.sessionId}\n${kind}`);
        keep.add(n.id);
      }
  });
  return notices.filter((n) => keep.has(n.id));
}
