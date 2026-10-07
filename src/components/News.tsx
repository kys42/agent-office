import { useState } from 'react';
import { Check, Mail, X, ArrowUpRight } from 'lucide-react';
import type { OfficeNotice, NoticeReceipt, Session } from '../shared/types';
import {
  noticeLabel,
  noticeExposure,
  isFinalNotice,
  isAttentionNotice,
  unreadNoticeCount,
} from '../shared/notices';
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
}: {
  notices: OfficeNotice[];
  sessions: Session[];
  privacy: boolean;
  onReceipt: ReceiptHandler;
  onSelect?: (id: string) => void;
  emptyText?: string;
  emptyDetail?: string;
}) {
  const { t } = useI18n();
  const l = t.news.list;
  const [limit, setLimit] = useState(30);
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
      {notices.length > limit && (
        <button className="button news-load" onClick={() => setLimit((n) => n + 30)}>
          {l.loadMore(notices.length - limit)}
        </button>
      )}
    </div>
  );
}
export function NewsFeed({
  notices,
  sessions,
  privacy,
  onReceipt,
  onSelect,
  initialFilter = 'final',
  includeBackground = false,
}: {
  notices: OfficeNotice[];
  sessions: Session[];
  privacy: boolean;
  onReceipt: ReceiptHandler;
  onSelect?: (id: string) => void;
  initialFilter?: 'final' | 'attention' | 'all';
  includeBackground?: boolean;
}) {
  const { t } = useI18n();
  const f = t.news.feed;
  const [filter, setFilter] = useState(initialFilter);
  const [includeRead, setIncludeRead] = useState(false);
  const matches = (n: OfficeNotice, kind = filter) =>
    kind === 'final'
      ? isFinalNotice(n) && (includeBackground || !n.background)
      : kind === 'attention'
        ? isAttentionNotice(n)
        : true;
  const counts = (kind: typeof filter) =>
    notices.filter((n) => !n.seenAt && matches(n, kind)).length;
  const selected = notices.filter((n) => matches(n) && (includeRead || !n.seenAt));
  const unread = selected.filter((n) => !n.seenAt);
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
          disabled={!unread.length}
          title={f.markAllTitle}
          onClick={() =>
            onReceipt(
              unread.map(({ id, version }) => ({ id, version })),
              'read',
            )
          }
        >
          <Check size={12} />
          {f.markAll(unread.length)}
        </button>
      </div>
      <div className="news-feed-scroll">
        <NewsList
          key={`${filter}:${includeRead}`}
          notices={selected}
          sessions={sessions}
          privacy={privacy}
          onReceipt={onReceipt}
          onSelect={onSelect}
          emptyText={f.empty[filter]}
          emptyDetail={f.emptyDetail[filter]}
        />
      </div>
    </div>
  );
}
export function NewsInbox({
  notices,
  sessions,
  privacy,
  onReceipt,
  onSelect,
  onClose,
}: {
  notices: OfficeNotice[];
  sessions: Session[];
  privacy: boolean;
  onReceipt: ReceiptHandler;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const i = t.news.inbox;
  const unread = unreadNoticeCount(notices);
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
