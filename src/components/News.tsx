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
  emptyText = '놓친 소식이 없어요',
  emptyDetail = '진행 상황은 대화에서 볼 수 있어요.',
}: {
  notices: OfficeNotice[];
  sessions: Session[];
  privacy: boolean;
  onReceipt: ReceiptHandler;
  onSelect?: (id: string) => void;
  emptyText?: string;
  emptyDetail?: string;
}) {
  const [limit, setLimit] = useState(30);
  const [expanded, setExpanded] = useState(new Set<string>());
  return (
    <div className="news-list">
      {!notices.length && (
        <div className="news-empty">
          <Mail size={28} />
          <h3>{emptyText}</h3>
          <p>{emptyDetail}</p>
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
                {n.background ? ' · 보조·자동' : ''}
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
                  <Sprite provider={session.provider} mood={session.status} size={22} />
                </span>
                <span>{privacy ? '숨긴 동료' : sessionName(session)}</span>
                <ArrowUpRight size={13} />
              </button>
            )}
            <p className={open ? 'expanded' : ''}>{privacy ? '소식 내용을 숨겼어요.' : n.text}</p>
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
                {open ? '접기' : '더 보기'}
              </button>
            )}
            <div className="news-actions">
              <button onClick={() => onReceipt(receipt, n.seenAt ? 'unread' : 'read')}>
                <Check size={13} />
                {n.seenAt ? '다시 미확인' : '읽음으로 표시'}
              </button>
              {!n.dismissedAt && (
                <button
                  onClick={() => onReceipt(receipt, 'dismiss')}
                  title="소식과 미확인 상태는 남아요"
                >
                  <X size={13} />
                  말풍선 접기
                </button>
              )}
              {n.dismissedAt && <small>말풍선 접힘</small>}
            </div>
          </article>
        );
      })}
      {notices.length > limit && (
        <button className="button news-load" onClick={() => setLimit((n) => n + 30)}>
          소식 더 보기 · {notices.length - limit}건
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
      <div className="news-filter-bar" role="group" aria-label="소식 종류">
        {(['final', 'attention', 'all'] as const).map((kind) => (
          <button
            key={kind}
            aria-pressed={kind === filter}
            className={kind === filter ? 'active' : ''}
            onClick={() => setFilter(kind)}
          >
            {kind === 'final' ? '최종 응답' : kind === 'attention' ? '확인 필요' : '전체 기록'}
            <span>{counts(kind)}</span>
          </button>
        ))}
      </div>
      {filter === 'final' && counts('attention') > 0 && (
        <button className="news-attention-link" onClick={() => setFilter('attention')}>
          답변이나 확인을 기다리는 소식 {counts('attention')}건 <ArrowUpRight size={13} />
        </button>
      )}
      <div className="news-review-bar">
        <label>
          <input
            type="checkbox"
            checked={includeRead}
            onChange={(e) => setIncludeRead(e.target.checked)}
          />
          읽은 소식 포함
        </label>
        <button
          disabled={!unread.length}
          title="선택한 분류의 미확인 소식 전체를 읽음으로 표시"
          onClick={() =>
            onReceipt(
              unread.map(({ id, version }) => ({ id, version })),
              'read',
            )
          }
        >
          <Check size={12} />
          미확인 {unread.length}건 읽음
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
          emptyText={
            filter === 'final'
              ? '새 최종 응답이 없어요'
              : filter === 'attention'
                ? '지금 확인할 요청이 없어요'
                : '놓친 기록이 없어요'
          }
          emptyDetail={
            filter === 'final'
              ? '진행 상황은 대화에서, 지난 소식은 전체 기록에서 볼 수 있어요.'
              : filter === 'attention'
                ? '답변이 필요한 질문과 오류는 여기에 따로 모아요.'
                : '읽은 소식 포함을 켜면 확인한 기록도 볼 수 있어요.'
          }
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
  const unread = unreadNoticeCount(notices);
  return (
    <aside className="inspector news-inbox" aria-label="소식함">
      <div className="inspector-top">
        <span className="inspector-crumb">
          <Mail size={13} /> 소식함
        </span>
        <button className="icon-btn" aria-label="소식함 닫기" title="닫기 · Esc" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <div className="inbox-heading">
        <h2>
          {unread ? (
            <>
              확인할 소식 <b>{unread}</b>건
            </>
          ) : (
            '모두 확인했어요'
          )}
        </h2>
        <p>
          동료가 남긴 최종 응답과 나를 기다리는 요청만 모아요. 진행 상황은 대화에서 볼 수 있어요.
        </p>
      </div>
      <NewsFeed
        notices={notices}
        sessions={sessions}
        privacy={privacy}
        onReceipt={onReceipt}
        onSelect={onSelect}
      />
      <p className="news-footnote">말풍선 접기와 읽음은 별개예요. 접어도 미확인 소식은 남아요.</p>
    </aside>
  );
}
