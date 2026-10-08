import type { DetailPage, OfficeEvent, OfficeNotice, Session, SessionDetail } from './types';

/**
 * A colleague's card holds only the conversation pages the person has read: the newest page
 * on open, older pages as they scroll back. Live snapshot events join at the newest end.
 */
export const DETAIL_PAGE = 40;
export const DETAIL_PAGE_MAX = 200;
/**
 * Events a card left open keeps at most as live ones arrive (well above a stored session's own
 * bound); the oldest go first and can be read again.
 */
export const LOADED_EVENTS = 400;

/** The newest `limit` events before `before` (the newest page without it). */
export function detailPage(
  s: Session,
  page: DetailPage = {},
  notices: OfficeNotice[] = [],
): SessionDetail {
  const end = page.before ? s.events.findIndex((e) => e.id === page.before) : s.events.length;
  // The cursor left the source window: everything older left with it.
  if (end < 0) return { ...s, events: [], olderEvents: false, notices: [] };
  const start = Math.max(0, end - (page.limit ?? DETAIL_PAGE));
  const events = s.events.slice(start, end);
  const from = start > 0 ? Math.min(...events.map((e) => e.at)) : -Infinity;
  const until = page.before ? s.events[end].at : Infinity;
  return {
    ...s,
    events,
    olderEvents: start > 0,
    notices: notices.filter((n) => n.at >= from && (n.at < until || !page.before)),
  };
}

export interface LoadedConversation {
  session: Session;
  /** Older events exist before the loaded ones. */
  older: boolean;
  /** A page was read (before that the card shows the snapshot's few events). */
  paged: boolean;
  /** Notices that came with the pages (resident ones arrive with the snapshot). */
  notices: OfficeNotice[];
}
export const freshConversation = (session: Session): LoadedConversation => ({
  session,
  older: false,
  paged: false,
  notices: [],
});

const byTime = (a: OfficeEvent, b: OfficeEvent) => a.at - b.at;
const union = (a: OfficeEvent[], b: OfficeEvent[]) =>
  [...new Map([...a, ...b].map((e) => [e.id, e])).values()].sort(byTime);
const unionNotices = (a: OfficeNotice[], b: OfficeNotice[]) => [
  ...new Map([...a, ...b].map((n) => [n.id, n])).values(),
];
/** At most `LOADED_EVENTS`, dropping the oldest (which can be read again). */
function bounded(view: LoadedConversation, events: OfficeEvent[]): LoadedConversation {
  if (events.length <= LOADED_EVENTS) return { ...view, session: { ...view.session, events } };
  const kept = events.slice(-LOADED_EVENTS);
  return {
    ...view,
    session: { ...view.session, events: kept },
    older: true,
    notices: view.notices.filter((n) => n.at >= kept[0].at),
  };
}

/**
 * The office's latest view of this colleague (status, names, its few latest events). With
 * older pages unread, events from before the loaded ones (the snapshot also keeps the person's
 * last requests) wait for their page, so the card never shows a gap as if it were continuous.
 */
export function mergeLive(view: LoadedConversation, live: Session): LoadedConversation {
  if (view.session.id !== live.id) return freshConversation(live);
  const first = view.session.events[0]?.at;
  const fresh =
    view.older && first !== undefined ? live.events.filter((e) => e.at >= first) : live.events;
  return bounded(
    { ...view, session: { ...view.session, ...live } },
    union(view.session.events, fresh),
  );
}

/**
 * The newest page read again. Pages read further back stay while they join it; if the
 * conversation moved on by more than a page meanwhile, the card starts over from this page.
 */
export function mergeNewest(view: LoadedConversation, page: SessionDetail): LoadedConversation {
  const head = page.events[0];
  const joins =
    view.paged &&
    view.session.id === page.id &&
    !!page.olderEvents &&
    !!head &&
    view.session.events.some((e) => e.id === head.id);
  const { olderEvents, notices = [], ...session } = page;
  if (!joins)
    return {
      session,
      older: !!olderEvents,
      paged: true,
      notices,
    };
  const kept = view.session.events.filter((e) => e.at < head.at);
  return bounded(
    {
      session,
      older: view.older,
      paged: true,
      notices: unionNotices(
        view.notices.filter((n) => n.at < head.at),
        notices,
      ),
    },
    union(kept, page.events),
  );
}

/** An older page, read before the loaded events. */
export function prependPage(view: LoadedConversation, page: SessionDetail): LoadedConversation {
  if (view.session.id !== page.id) return view;
  return {
    ...view,
    session: { ...view.session, events: union(page.events, view.session.events) },
    older: !!page.olderEvents,
    notices: unionNotices(page.notices ?? [], view.notices),
  };
}
