import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { WebLink } from './WebLink';
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
import { useI18n } from '../lib/i18n';
import { intlLocale } from '../shared/i18n';
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
  const { t } = useI18n();
  const work = event.kind === 'tool' || event.kind === 'result';
  const limit = work ? 200 : 300;
  const long = event.text.length > limit || event.text.split('\n').length > 12;
  const text =
    expanded || !long
      ? event.text
      : event.text.slice(0, limit).split('\n').slice(0, 12).join('\n') + '…';
  const label =
    event.kind === 'user'
      ? t.conversation.you
      : event.kind === 'assistant'
        ? PROVIDERS[provider].name
        : event.kind === 'tool'
          ? t.conversation.toolUse
          : event.kind === 'result'
            ? t.conversation.toolResult
            : t.conversation.progressUpdate;
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
          aria-label={t.conversation.copyMessage}
          onClick={() =>
            navigator.clipboard
              .writeText(event.text)
              .then(() => notify(t.conversation.copied))
              .catch(() => notify(t.conversation.copyFailed))
          }
        >
          <Copy size={12} />
        </button>
      </div>
      <div className="message-bubble">
        {event.excerpt && (
          <small className="retained-excerpt" title={t.conversation.excerptTitle}>
            {t.conversation.excerpt}
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
                  // Any other web page opens in the browser; other schemes stay text.
                  <WebLink href={href}>{children}</WebLink>
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
            {expanded
              ? t.conversation.showLess
              : t.conversation.showMore(event.text.length.toLocaleString(intlLocale()))}
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
  const { t } = useI18n();
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
        <div className="conversation-filters" role="group" aria-label={t.conversation.filtersLabel}>
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
              {kind === 'all' ? t.conversation.all : CONVERSATION_LABELS[kind]}
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
          {t.conversation.includeTools}
          <span>{counts.work}</span>
        </label>
      </div>
      <div className="conversation-range">
        <Clock3 size={12} />
        {session.partial ? t.conversation.rangePartial : t.conversation.rangeFull}
        <span>{t.conversation.readOnly}</span>
      </div>
      {groups.length > count && (
        <button
          className="older-messages"
          onClick={() => {
            follow.current = false;
            setCount(count + 24);
          }}
        >
          {t.conversation.older(Math.min(24, groups.length - count))}
        </button>
      )}
      {groups.slice(-count).map((g) =>
        g.work ? (
          <details className="work-group" key={g.id}>
            <summary>
              <Terminal size={14} />
              <span>
                {g.events.find((e) => e.kind === 'tool')?.tool?.replace(/^.*__/, '') ||
                  t.conversation.workLog}
              </span>
              <small>{t.conversation.entries(g.events.length)}</small>
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
              ? t.conversation.empty
              : t.conversation.emptyFiltered(CONVERSATION_LABELS[filter])}
          </p>
          {filter === 'reply' && <small>{t.conversation.replyHint}</small>}
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
            {t.conversation.working}
          </>
        ) : (
          <>
            {t.conversation.lastEntry} · {time(session.updatedAt)}
          </>
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
          {t.conversation.newEntries} <ArrowDown size={14} />
        </button>
      )}
    </div>
  );
}
