import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, Copy, Terminal, Clock3, MessageSquare, ArrowDown } from 'lucide-react';
import type { OfficeEvent, OfficeNotice, Session } from '../shared/types';
import { PROVIDERS } from '../shared/types';
import { parseArtifact } from '../shared/office';
import {
  conversationKind,
  retainedConversation,
  CONVERSATION_LABELS,
  type ConversationFilter,
} from '../shared/conversation';
import { time, date } from '../lib/format';
import { api, isDesktop } from '../lib/api';
function Message({
  event,
  provider,
  notify,
  expanded,
  onExpand,
}: {
  event: OfficeEvent;
  provider: Session['provider'];
  notify: (s: string) => void;
  expanded: boolean;
  onExpand: () => void;
}) {
  const work = event.kind === 'tool' || event.kind === 'result';
  const limit = work ? 200 : 300;
  const long = event.text.length > limit || event.text.split('\n').length > 12;
  const text =
    expanded || !long
      ? event.text
      : event.text.slice(0, limit).split('\n').slice(0, 12).join('\n') + '…';
  const label =
    event.kind === 'user'
      ? '나'
      : event.kind === 'assistant'
        ? PROVIDERS[provider].name
        : event.kind === 'tool'
          ? '도구 사용'
          : event.kind === 'result'
            ? '작업 결과'
            : '진행 소식';
  return (
    <article
      className={`conversation-message message-${event.kind} category-${conversationKind(event)}`}
      data-message-category={conversationKind(event)}
    >
      <div className="message-meta">
        <b>{label}</b>
        <span className={`message-category category-${conversationKind(event)}`}>
          {CONVERSATION_LABELS[conversationKind(event)]}
        </span>
        <time title={date(event.at)}>{time(event.at)}</time>
        <button
          aria-label="메시지 복사"
          onClick={() =>
            navigator.clipboard
              .writeText(event.text)
              .then(() => notify('메시지를 복사했어요'))
              .catch(() => notify('복사 권한을 확인해 주세요'))
          }
        >
          <Copy size={12} />
        </button>
      </div>
      <div className="message-bubble">
        {event.excerpt && (
          <small
            className="retained-excerpt"
            title="현재 원문 수집 구간 밖의 메시지예요. 저장해 둔 공개 발췌를 표시합니다."
          >
            보관된 발췌 · 원문 일부
          </small>
        )}
        <div className="message-text">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => {
                const link = href ? parseArtifact(href) : null;
                return link ? (
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => {
                      if (isDesktop) {
                        e.preventDefault();
                        void api.openArtifact(link.url).catch((e) => notify(e.message));
                      }
                    }}
                  >
                    {children}
                  </a>
                ) : (
                  <span>{children}</span>
                );
              },
              img: () => null,
            }}
          >
            {text}
          </ReactMarkdown>
        </div>
        {long && (
          <button className="message-expand" aria-expanded={expanded} onClick={onExpand}>
            {expanded ? '접기' : `더 보기 · ${event.text.length.toLocaleString()}자`}
            <ChevronDown size={13} />
          </button>
        )}
      </div>
    </article>
  );
}
export function Conversation({
  session,
  notices,
  notify,
}: {
  session: Session;
  notices: OfficeNotice[];
  notify: (s: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [count, setCount] = useState(24);
  const [newBelow, setNewBelow] = useState(false);
  const [filter, setFilter] = useState<ConversationFilter>('all');
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const [tools, setTools] = useState(false);
  const [expanded, setExpanded] = useState(new Set<string>());
  const events = useMemo(
    () => retainedConversation(session.events, notices),
    [session.events, notices],
  );
  const counts = Object.fromEntries(
    ['request', 'progress', 'reply', 'message', 'work'].map((kind) => [
      kind,
      events.filter((e) => conversationKind(e) === kind).length,
    ]),
  );
  const groups = useMemo(() => {
    const out: { id: string; events: OfficeEvent[]; work: boolean }[] = [];
    for (const e of events) {
      const category = conversationKind(e);
      const work = category === 'work';
      if (work ? !tools || filter !== 'all' : filter !== 'all' && category !== filter) continue;
      const last = out.at(-1);
      if (work && last?.work) last.events.push(e);
      else out.push({ id: e.id, events: [e], work });
    }
    return out;
  }, [events, filter, tools]);
  const toggleMessage = (id: string) =>
    setExpanded((old) => {
      const next = new Set(old);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const last = groups.at(-1)?.events.at(-1)?.id;
  // Our own scroll events arrive a frame later; by then content above may have grown, so they
  // must not be mistaken for the person scrolling up (which turns following off).
  const programmaticAt = useRef(0);
  const scrollBottom = () => {
    const scroller = root.current?.closest('.inspector-scroll');
    if (!scroller) return;
    programmaticAt.current = performance.now();
    if (filterRef.current === 'all') {
      scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    const messages = root.current?.querySelectorAll('.conversation-message');
    const lastMessage = messages?.[messages.length - 1];
    const toolbar = root.current?.querySelector('.conversation-toolbar');
    if (lastMessage && toolbar)
      scroller.scrollTop +=
        lastMessage.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        toolbar.getBoundingClientRect().height -
        12;
  };
  useEffect(() => {
    const scroller = root.current?.closest('.inspector-scroll');
    if (!scroller) return;
    const onScroll = () => {
      if (performance.now() - programmaticAt.current < 250) {
        if (follow.current) scrollBottom();
        return;
      }
      follow.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
      if (follow.current) setNewBelow(false);
    };
    scroller.addEventListener('scroll', onScroll);
    const observer = new ResizeObserver(() => {
      if (follow.current) scrollBottom();
    });
    observer.observe(scroller);
    // Context cards above the conversation mount asynchronously; follow them too.
    const observeChildren = () => {
      for (const child of Array.from(scroller.children)) observer.observe(child);
    };
    observeChildren();
    const mutations = new MutationObserver(observeChildren);
    mutations.observe(scroller, { childList: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      observer.disconnect();
      mutations.disconnect();
    };
  }, []);
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (follow.current) scrollBottom();
      else setNewBelow(true);
    });
    return () => cancelAnimationFrame(raf);
  }, [last]);
  useEffect(() => {
    const raf = requestAnimationFrame(scrollBottom);
    return () => cancelAnimationFrame(raf);
  }, [filter]);
  return (
    <div
      className="conversation"
      ref={root}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('.message-expand, summary')) follow.current = false;
      }}
    >
      <div className="conversation-toolbar">
        <div className="conversation-filters" role="group" aria-label="대화 종류">
          {(
            [
              'all',
              'request',
              'progress',
              'reply',
              ...(counts.message ? ['message'] : []),
            ] as ConversationFilter[]
          ).map((kind) => (
            <button
              key={kind}
              aria-pressed={filter === kind}
              className={filter === kind ? 'active' : ''}
              onClick={() => {
                follow.current = true;
                setNewBelow(false);
                setCount(24);
                setFilter(kind);
              }}
            >
              {kind === 'all' ? '전체' : CONVERSATION_LABELS[kind]}
              <span>
                {kind === 'all'
                  ? events.filter((e) => conversationKind(e) !== 'work').length
                  : counts[kind]}
              </span>
            </button>
          ))}
        </div>
        <label className="conversation-tools-toggle">
          <input
            type="checkbox"
            checked={tools}
            disabled={filter !== 'all'}
            onChange={(e) => setTools(e.target.checked)}
          />
          도구 기록 포함<span>{counts.work}</span>
        </label>
      </div>
      <div className="conversation-range">
        <Clock3 size={12} />
        {session.partial ? '처음·최근 구간에서 가져온 대화' : '이 세션에 남은 대화'}
        <span>읽기 전용</span>
      </div>
      {groups.length > count && (
        <button
          className="older-messages"
          onClick={() => {
            follow.current = false;
            setCount(count + 24);
          }}
        >
          이전 대화 {Math.min(24, groups.length - count)}개 더 보기
        </button>
      )}
      {groups.slice(-count).map((g) =>
        g.work ? (
          <details className="work-group" key={g.id}>
            <summary>
              <Terminal size={14} />
              <span>
                {g.events.find((e) => e.kind === 'tool')?.tool?.replace(/^.*__/, '') ||
                  '작업 진행 기록'}
              </span>
              <small>{g.events.length}개 기록</small>
              <ChevronDown size={13} />
            </summary>
            <div>
              {g.events.map((e, i) => (
                <Message
                  event={e}
                  provider={session.provider}
                  notify={notify}
                  key={e.id + i}
                  expanded={expanded.has(e.id)}
                  onExpand={() => toggleMessage(e.id)}
                />
              ))}
            </div>
          </details>
        ) : (
          <Message
            key={g.id}
            event={g.events[0]}
            provider={session.provider}
            notify={notify}
            expanded={expanded.has(g.id)}
            onExpand={() => toggleMessage(g.id)}
          />
        ),
      )}
      {!groups.length && (
        <div className="empty-small">
          <MessageSquare size={26} />
          <p>
            {filter === 'all'
              ? '아직 읽을 수 있는 대화가 없어요.'
              : `${CONVERSATION_LABELS[filter]} 기록이 아직 없어요.`}
          </p>
          {filter === 'reply' && (
            <small>진행 메시지나 구분 없는 응답은 완료로 표시하지 않아요.</small>
          )}
        </div>
      )}
      <div className="conversation-end" ref={bottom}>
        {['work', 'think'].includes(session.status) ? (
          <>
            <span className="typing-dots">
              <i />
              <i />
              <i />
            </span>{' '}
            동료가 작업하고 있어요
          </>
        ) : (
          <>마지막 기록 · {time(session.updatedAt)}</>
        )}
      </div>
      {newBelow && (
        <button
          className="new-messages"
          onClick={() => {
            follow.current = true;
            scrollBottom();
            setNewBelow(false);
          }}
        >
          새 기록 보기 <ArrowDown size={14} />
        </button>
      )}
    </div>
  );
}
