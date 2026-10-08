import type {
  NoticeCursor,
  NoticeFilter,
  NoticePage,
  NoticePageRequest,
  NoticeQuery,
  OfficeNotice,
} from './types';
import { isAttentionNotice, isFinalNotice, isInboxNotice } from './notices';
import { ARRIVAL_LAG_MS, ARRIVAL_MS } from './speech';

/**
 * The snapshot carries a bounded set of notices; the rest are read a page at a time. Both sides
 * use the same order, kinds and scope rules from here, so a page continues exactly where the
 * carried ones stop and nothing falls between them.
 */
/** The most recent notices carried whatever their kind. */
export const RECENT_NOTICES = 100;
/** Unread finals carried at most (newest first); beyond, the news pages read them. */
export const UNREAD_FINALS = 1000;
export const NOTICE_PAGE = 50;
export const NOTICE_PAGE_MAX = 500;

/** Newest first, then by id: a total order, so a cursor never skips or repeats a notice. */
export const noticeOrder = (a: OfficeNotice, b: OfficeNotice) =>
  b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const after = (n: OfficeNotice, c: NoticeCursor) => n.at < c.at || (n.at === c.at && n.id < c.id);
export const noticeCursor = (n: OfficeNotice): NoticeCursor => ({ at: n.at, id: n.id });

/** The news lists' kinds (read state aside). */
export function matchesKind(n: OfficeNotice, filter: NoticeFilter, includeBackground = false) {
  return filter === 'final'
    ? isFinalNotice(n) && (includeBackground || !n.background)
    : filter === 'attention'
      ? isAttentionNotice(n)
      : true;
}
const inScope = (n: OfficeNotice, q: Pick<NoticeQuery, 'sessionIds'>) =>
  !q.sessionIds || q.sessionIds.includes(n.sessionId);
export const matchesQuery = (n: OfficeNotice, q: NoticeQuery) =>
  inScope(n, q) && matchesKind(n, q.filter, q.includeBackground) && (!!q.includeRead || !n.seenAt);

/** Unread counts of each kind in the query's scope. */
export function unreadByKind(notices: OfficeNotice[], q: Omit<NoticeQuery, 'filter'>) {
  const unread: Record<NoticeFilter, number> = { final: 0, attention: 0, all: 0 };
  for (const n of notices)
    if (!n.seenAt && inScope(n, q))
      for (const kind of ['final', 'attention', 'all'] as const)
        if (matchesKind(n, kind, q.includeBackground)) unread[kind]++;
  return unread;
}

/** One page of `notices` (in `noticeOrder`) for `request`. */
export function pageNotices(
  notices: OfficeNotice[],
  request: NoticePageRequest,
  at = Date.now(),
): NoticePage {
  const limit = request.limit ?? NOTICE_PAGE;
  const before = request.before;
  const page: OfficeNotice[] = [];
  let more = false;
  for (const n of notices) {
    if ((before && !after(n, before)) || !matchesQuery(n, request)) continue;
    if (page.length === limit) {
      more = true;
      break;
    }
    page.push(n);
  }
  return { notices: page, more, unread: unreadByKind(notices, request), at };
}

/**
 * What the office needs live, out of every visible notice (in `noticeOrder`): each session's
 * latest notice (its bubble or peek), latest request (the quote above it) and latest
 * conversation (whether a hidden colleague came back), just-arrived requests, every open call,
 * every unread final up to `UNREAD_FINALS`, and the `RECENT_NOTICES` newest of any kind.
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
    if (!n.seenAt && isFinalNotice(n) && !n.background) finals++;
    // The bubble picks the latest by time, then by arrival: keep every notice tied for it.
    const top = latest.get(n.sessionId);
    if (!top) latest.set(n.sessionId, n);
    if (!top || top.at === n.at) keep.add(n.id);
    for (const kind of [
      n.kind === 'request' && 'request',
      (n.kind === 'request' || isFinalNotice(n) || n.kind === 'attention' || n.kind === 'error') &&
        'conversation',
    ])
      if (kind && !seen.has(`${n.sessionId}\n${kind}`)) {
        seen.add(`${n.sessionId}\n${kind}`);
        keep.add(n.id);
      }
  });
  return notices.filter((n) => keep.has(n.id));
}
