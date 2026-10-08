import { useEffect, useRef, useState } from 'react';
import { Check, Mail, X, ArrowUpRight } from 'lucide-react';
import type {
  NoticeFilter,
  NoticePage,
  NoticeQuery,
  OfficeNotice,
  NoticeReceipt,
  Session,
} from '../shared/types';
import {
  applyNoticeReceipt,
  noticeLabel,
  noticeExposure,
  isFinalNotice,
  unreadNoticeCount,
} from '../shared/notices';
import {
  NOTICE_PAGE,
  NOTICE_PAGE_MAX,
  matchesKind,
  matchesQuery,
  noticeCursor,
  noticeOrder,
} from '../shared/notice-pages';
import { api } from '../lib/api';
import { useNoticePaging } from '../lib/notice-paging';
import { sessionName } from '../shared/office';
import { ago } from '../lib/format';
import { Sprite } from './Sprite';
import { PanelTabs } from './PanelTabs';
import { useI18n } from '../lib/i18n';
export type ReceiptHandler = (
  receipts: NoticeReceipt[],
  action: 'read' | 'dismiss' | 'unread' | 'view',
) => void;

export function NewsList({
  notices,
  sessions,
  privacy,
  onReceipt,
  onSelect,
  emptyText,
  emptyDetail,
  hasMore = false,
  onMore,
}: {
  notices: OfficeNotice[];
  sessions: Session[];
  privacy: boolean;
  onReceipt: ReceiptHandler;
  onSelect?: (id: string) => void;
  emptyText?: string;
  emptyDetail?: string;
  /** Older notices wait on the collector: `onMore` reads the next page of them. */
  hasMore?: boolean;
  onMore?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const l = t.news.list;
  const [limit, setLimit] = useState(30);
  const [loading, setLoading] = useState(false);
  const hidden = notices.length - limit;
  const more = async () => {
    if (hidden < 30 && hasMore && onMore) {
      setLoading(true);
      try {
        await onMore();
      } finally {
        setLoading(false);
      }
    }
    setLimit((n) => n + 30);
  };
  const [expanded, setExpanded] = useState(new Set<string>());
  return (
    <div className="news-list">
      {!notices.length && (
        <div className="news-empty">
          <Mail size={28} />
          <h3>{emptyText ?? l.emptyTitle}</h3>
          <p>{emptyDetail ?? l.emptyDetail}</p>
        </div>
      )}
      {notices.slice(0, limit).map((n) => {
        const session = sessions.find((s) => s.id === n.sessionId);
        const open = expanded.has(n.id);
        const receipt = [{ id: n.id, version: n.version }];
        return (
          <article
            key={n.id}
            className={`news-item ${n.seenAt ? 'seen' : 'unread'} news-${n.kind === 'reply' && !isFinalNotice(n) ? 'message' : n.kind}`}
            data-notice-id={n.id}
          >
            <div className="news-meta">
              <span className="news-kind">
                {noticeLabel(n)}
                {!n.seenAt && <i />}
              </span>
              <span className="notice-exposure">
                {noticeExposure(n)}
                {n.background ? ` · ${l.background}` : ''}
              </span>
              <time>{ago(n.at)}</time>
            </div>
            {onSelect && session && (
              <button
                className="news-session"
                onClick={() => {
                  if (!privacy) onReceipt(receipt, 'view');
                  onSelect(n.sessionId);
                }}
              >
                <span className={`face face-${session.provider}`}>
                  <Sprite
                    session={session}
                    provider={session.provider}
                    mood={session.status}
                    size={22}
                  />
                </span>
                <span>{privacy ? l.hiddenTeammate : sessionName(session)}</span>
                <ArrowUpRight size={13} />
              </button>
            )}
            <p className={open ? 'expanded' : ''}>{privacy ? l.hiddenText : n.text}</p>
            {!privacy && n.text.length > 160 && (
              <button
                className="news-more"
                onClick={() => {
                  if (!open) onReceipt(receipt, 'view');
                  setExpanded((old) => {
                    const next = new Set(old);
                    open ? next.delete(n.id) : next.add(n.id);
                    return next;
                  });
                }}
              >
                {open ? l.less : l.more}
              </button>
            )}
            <div className="news-actions">
              <button onClick={() => onReceipt(receipt, n.seenAt ? 'unread' : 'read')}>
                <Check size={13} />
                {n.seenAt ? l.markUnread : l.markRead}
              </button>
              {!n.dismissedAt && (
                <button onClick={() => onReceipt(receipt, 'dismiss')} title={l.dismissTitle}>
                  <X size={13} />
                  {l.dismiss}
                </button>
              )}
              {n.dismissedAt && <small>{l.dismissed}</small>}
            </div>
          </article>
        );
      })}
      {(hidden > 0 || hasMore) && (
        <button className="button news-load" disabled={loading} onClick={() => void more()}>
          {loading ? l.loadingOlder : hidden > 0 ? l.loadMore(hidden) : l.loadOlder}
        </button>
      )}
    </div>
  );
}
type LoadedPage = Omit<NoticePage, 'notices'> & { key: string; notices: OfficeNotice[] };
export function NewsFeed({
  notices,
  sessions,
  privacy,
  onReceipt,
  onSelect,
  initialFilter = 'final',
  includeBackground = false,
  sessionIds,
}: {
  notices: OfficeNotice[];
  sessions: Session[];
  privacy: boolean;
  onReceipt: ReceiptHandler;
  onSelect?: (id: string) => void;
  initialFilter?: NoticeFilter;
  includeBackground?: boolean;
  /** The sessions `notices` belong to (a colleague's own news); absent for the whole office. */
  sessionIds?: string[];
}) {
  const { t } = useI18n();
  const f = t.news.feed;
  const [filter, setFilter] = useState(initialFilter);
  const [includeRead, setIncludeRead] = useState(false);
  const { paged, readAll, stats } = useNoticePaging();
  const query: NoticeQuery = {
    filter,
    includeRead,
    includeBackground,
    ...(sessionIds ? { sessionIds } : {}),
  };
  const key = JSON.stringify(query);
  // When the snapshot carries only part of the news, the list reads it from the collector by
  // page; the carried copies (the freshest) stand in for theirs. Read again whenever the carried
  // notices or the office's counts move, as deep as the person has scrolled.
  const [page, setPage] = useState<LoadedPage | null>(null);
  const depth = useRef({ key, count: NOTICE_PAGE });
  const carried = notices
    .map((n) => `${n.id}:${n.version}:${n.seenAt}:${n.dismissedAt}:${n.resolvedAt}`)
    .join('\n');
  useEffect(() => {
    if (!paged) return setPage(null);
    if (depth.current.key !== key) depth.current = { key, count: NOTICE_PAGE };
    let valid = true;
    api
      .noticePage({ ...query, limit: Math.min(NOTICE_PAGE_MAX, depth.current.count) })
      .then((p) => valid && setPage({ ...p, key }))
      .catch(() => {});
    return () => {
      valid = false;
    };
  }, [paged, key, carried, stats]);
  const loaded = paged && page?.key === key ? page : null;
  const onMore = async () => {
    const last = loaded?.notices.at(-1);
    if (!loaded || !last) return;
    const next = await api.noticePage({ ...query, before: noticeCursor(last), limit: NOTICE_PAGE });
    setPage((p) => {
      if (p?.key !== key) return p;
      const ids = new Set(p.notices.map((n) => n.id));
      const notices = [...p.notices, ...next.notices.filter((n) => !ids.has(n.id))];
      depth.current = { key, count: notices.length };
      return { ...p, notices, more: next.more };
    });
  };
  // A receipt shows at once on paged-in notices too (the carried ones follow the snapshot).
  const receipt: ReceiptHandler = (receipts, action) => {
    setPage((p) => p && { ...p, notices: applyNoticeReceipt(p.notices, receipts, action) });
    onReceipt(receipts, action);
  };
  const matches = (n: OfficeNotice, kind = filter) => matchesKind(n, kind, includeBackground);
  const local = (kind: NoticeFilter) => notices.filter((n) => !n.seenAt && matches(n, kind)).length;
  const counts = (kind: NoticeFilter) => (loaded ? loaded.unread[kind] : local(kind));
  const selected = loaded
    ? merged(loaded, notices, query)
    : notices.filter((n) => matchesQuery(n, query));
  const unread = selected.filter((n) => !n.seenAt);
  const unreadCount = loaded ? loaded.unread[filter] : unread.length;
  return (
    <div className="news-feed">
      <div className="news-filter-bar" role="group" aria-label={f.kinds}>
        {(['final', 'attention', 'all'] as const).map((kind) => (
          <button
            key={kind}
            aria-pressed={kind === filter}
            className={kind === filter ? 'active' : ''}
            onClick={() => setFilter(kind)}
          >
            {f[kind]}
            <span>{counts(kind)}</span>
          </button>
        ))}
      </div>
      {filter === 'final' && counts('attention') > 0 && (
        <button className="news-attention-link" onClick={() => setFilter('attention')}>
          {f.waiting(counts('attention'))} <ArrowUpRight size={13} />
        </button>
      )}
      <div className="news-review-bar">
        <label>
          <input
            type="checkbox"
            checked={includeRead}
            onChange={(e) => setIncludeRead(e.target.checked)}
          />
          {f.includeRead}
        </label>
        <button
          disabled={!unreadCount}
          title={f.markAllTitle}
          onClick={() =>
            // Paged, the collector reads every match, shown or not, as of the page's reading.
            loaded && readAll
              ? void readAll({ ...query, includeRead: false }, loaded.at)
              : receipt(
                  unread.map(({ id, version }) => ({ id, version })),
                  'read',
                )
          }
        >
          <Check size={12} />
          {f.markAll(unreadCount)}
        </button>
      </div>
      <div className="news-feed-scroll">
        <NewsList
          key={`${filter}:${includeRead}`}
          notices={selected}
          sessions={sessions}
          privacy={privacy}
          onReceipt={receipt}
          onSelect={onSelect}
          emptyText={f.empty[filter]}
          emptyDetail={f.emptyDetail[filter]}
          hasMore={!!loaded?.more}
          onMore={onMore}
        />
      </div>
    </div>
  );
}
/**
 * A read page with the carried notices laid over it: their copies replace the page's, and
 * those that arrived since it was read join it (older ones wait for their page).
 */
function merged(page: LoadedPage, carried: OfficeNotice[], query: NoticeQuery) {
  const last = page.notices.at(-1);
  const byId = new Map(page.notices.map((n) => [n.id, n]));
  for (const n of carried)
    if (byId.has(n.id) || !page.more || !last || noticeOrder(n, last) < 0) byId.set(n.id, n);
  return [...byId.values()].filter((n) => matchesQuery(n, query)).sort(noticeOrder);
}
export function NewsInbox({
  notices,
  unread: count,
  sessions,
  privacy,
  onReceipt,
  onSelect,
  onClose,
}: {
  notices: OfficeNotice[];
  /** The office's exact count (the carried notices are a bounded part of all). */
  unread?: number;
  sessions: Session[];
  privacy: boolean;
  onReceipt: ReceiptHandler;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const i = t.news.inbox;
  const unread = count ?? unreadNoticeCount(notices);
  const [before, after] = i.unread(unread);
  return (
    <aside className="inspector news-inbox" aria-label={i.label}>
      <PanelTabs active="inbox" unread={unread} onRoster={onClose} onClose={onClose} />
      <div className="inbox-heading">
        <h2>
          {unread ? (
            <>
              {before}
              <b>{unread}</b>
              {after}
            </>
          ) : (
            i.allClear
          )}
        </h2>
        <p>{i.body}</p>
      </div>
      <NewsFeed
        notices={notices}
        sessions={sessions}
        privacy={privacy}
        onReceipt={onReceipt}
        onSelect={onSelect}
      />
      <p className="news-footnote">{i.footnote}</p>
    </aside>
  );
}
