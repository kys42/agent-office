import {
  Fragment,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { MessageMarkdown } from './MessageMarkdown';
import {
  ChevronDown,
  Copy,
  Terminal,
  Clock3,
  MessageSquare,
  ArrowDown,
  Bookmark,
  BookmarkCheck,
} from 'lucide-react';
import type { OfficeEvent, OfficeNotice, Session } from '../shared/types';
import { PROVIDERS } from '../shared/types';
import {
  conversationKind,
  retainedConversation,
  CONVERSATION_LABELS,
  type ConversationFilter,
} from '../shared/conversation';
import { time, date } from '../lib/format';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { intlLocale } from '../shared/i18n';
function Message({
  event,
  provider,
  notify,
  expanded,
  onExpand,
  group,
  marked = false,
  onMark,
  focused = false,
  name,
  continued = false,
}: {
  event: OfficeEvent;
  provider: Session['provider'];
  name?: string;
  notify: (s: string) => void;
  expanded: boolean;
  onExpand: () => void;
  /** Set on a message shown on its own: where the reading position is kept. */
  group?: string;
  /** The message is bookmarked; `onMark` (absent where nothing is kept) toggles it. */
  marked?: boolean;
  onMark?: (on: boolean) => void;
  /** Just opened from its bookmark. */
  focused?: boolean;
  /** Follows a message from the same side and kind: who and when only show on hover. */
  continued?: boolean;
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
        ? (name ?? PROVIDERS[provider].name)
        : event.kind === 'tool'
          ? t.conversation.toolUse
          : event.kind === 'result'
            ? t.conversation.toolResult
            : t.conversation.progressUpdate;
  return (
    <article
      className={`conversation-message message-${event.kind} category-${conversationKind(event)}${marked ? ' is-bookmarked' : ''}${focused ? ' is-focused' : ''}${continued ? ' is-continued' : ''}`}
      data-message-category={conversationKind(event)}
      data-group-id={group}
      data-event-id={event.id}
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
        {onMark && event.kind !== 'lifecycle' && (
          <button
            className={`message-bookmark ${marked ? 'is-on' : ''}`}
            aria-pressed={marked}
            aria-label={marked ? t.conversation.unbookmark : t.conversation.bookmark}
            title={marked ? t.conversation.unbookmark : t.conversation.bookmark}
            onClick={() => onMark(!marked)}
          >
            {marked ? <BookmarkCheck size={12} /> : <Bookmark size={12} />}
          </button>
        )}
      </div>
      <div className="message-bubble">
        {event.excerpt && (
          <small className="retained-excerpt" title={t.conversation.excerptTitle}>
            {t.conversation.excerpt}
          </small>
        )}
        <div className="message-text">
          <MessageMarkdown text={text} notify={notify} />
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
  older = false,
  loadingOlder = false,
  onOlder,
  bookmarked = [],
  onBookmark,
  focus,
  onFocused,
  compact = false,
  hideProgress = false,
  onShowProgress,
  name,
  filtersOpen,
  sent = [],
  onDismissSent,
}: {
  session: Session;
  notices: OfficeNotice[];
  notify: (s: string) => void;
  /** Older messages wait to be read: `onOlder` reads the page before the first one. */
  older?: boolean;
  loadingOlder?: boolean;
  onOlder?: () => void;
  /** Ids of the bookmarked messages; `onBookmark` (absent where nothing is kept) toggles one. */
  bookmarked?: string[];
  onBookmark?: (eventId: string, on: boolean) => void;
  /** A message to bring into view and mark for a moment (a bookmark being opened). */
  focus?: { eventId: string; at: number; key: number; ready: boolean } | null;
  /** The focused message was brought into view (or found missing): the opening is done. */
  onFocused?: () => void;
  /** The card's chat: filters fold behind a small button, the range note goes away. */
  compact?: boolean;
  /** Progress notes left out of the whole conversation (the card's switch). */
  hideProgress?: boolean;
  /** A bookmarked progress note is being opened while they are left out: show them again. */
  onShowProgress?: () => void;
  /** Who answers, as the office calls them (the card's chat); else the tool's name. */
  name?: string;
  /** The card opens its filters from a button beside its tabs. */
  filtersOpen?: boolean;
  /**
   * What the person just sent that the record does not show yet (a busy Claude reads queued
   * input only when it gets to it): drawn as their own bubbles, marked as waiting.
   */
  sent?: { id: string; text: string; at: number }[];
  /** Hides a temporary local receipt only; never cancels a submitted message. */
  onDismissSent?: (id: string) => void;
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
  // Excerpts fill gaps only within what is loaded: an older notice waits for its page, so a
  // message not yet read is never shown as if the record had lost it.
  const events = useMemo(() => {
    const first = older ? session.events[0]?.at : undefined;
    return retainedConversation(
      session.events,
      first === undefined ? notices : notices.filter((n) => n.at >= first),
    );
  }, [session.events, notices, older]);
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
      if (hideProgress && category === 'progress' && filter === 'all') continue;
      const last = out.at(-1);
      if (work && last?.work) last.events.push(e);
      else out.push({ id: e.id, events: [e], work });
    }
    return out;
  }, [events, filter, tools, hideProgress]);
  const shown = useMemo(() => groups.slice(-count), [groups, count]);
  // In the card's chat a run from the same side and kind reads as one, like a messenger: only
  // its first message says who and when. A long pause, or a new day, gets a time line between.
  const runs = useMemo(() => {
    const info = new Map<string, { continued: boolean; pause: number | null }>();
    if (!compact) return info;
    let prev: { side: string; kind: string; at: number } | null = null;
    for (const g of shown) {
      const e = g.events[0];
      const pause =
        prev &&
        (e.at - prev.at >= 15 * 60_000 ||
          new Date(e.at).toDateString() !== new Date(prev.at).toDateString())
          ? e.at
          : null;
      if (g.work) {
        // Folded work sits inside a run without breaking it.
        info.set(g.id, { continued: false, pause });
        // After a pause the next message starts afresh.
        if (pause) prev = null;
        else if (prev) prev.at = g.events.at(-1)!.at;
        continue;
      }
      const side = e.kind === 'user' ? 'you' : e.kind === 'lifecycle' ? 'system' : 'agent';
      const kind = conversationKind(e);
      info.set(g.id, {
        continued: !pause && !!prev && prev.side === side && prev.kind === kind,
        pause,
      });
      prev = { side, kind, at: e.at };
    }
    return info;
  }, [compact, shown]);
  const pauseLabel = (at: number) =>
    new Date(at).toDateString() === new Date().toDateString()
      ? time(at)
      : `${date(at)} ${time(at)}`;
  const toggleMessage = (id: string) =>
    setExpanded((old) => {
      const next = new Set(old);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const last = `${groups.at(-1)?.events.at(-1)?.id}:${sent.length}`;
  // A delayed scroll event belongs to us only while it still matches the position we set.
  // Time-based grace periods also swallow the person's first wheel/keyboard input.
  const programmaticTop = useRef<number | null>(null);
  const moveScroll = (scroller: Element, top: number) => {
    scroller.scrollTop = top;
    programmaticTop.current = scroller.scrollTop;
  };
  const scrollBottom = () => {
    const scroller = root.current?.closest('.inspector-scroll');
    if (!scroller) return;
    if (filterRef.current === 'all') {
      moveScroll(scroller, scroller.scrollHeight);
      return;
    }
    const messages = root.current?.querySelectorAll('.conversation-message');
    const lastMessage = messages?.[messages.length - 1];
    // The sticky filters cover the top; folded away (the card's chat), nothing does.
    // The filter row covers the top while open (the card's folded filters cover nothing).
    const toolbar = root.current?.querySelector('.conversation-toolbar');
    if (lastMessage)
      moveScroll(
        scroller,
        scroller.scrollTop +
          lastMessage.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          (toolbar?.getBoundingClientRect().height ?? 0) -
          12,
      );
  };
  // Showing older messages keeps the one the person was reading where it was.
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const keepPosition = () => {
    const scroller = root.current?.closest('.inspector-scroll');
    const top = scroller?.getBoundingClientRect().top ?? 0;
    const el = Array.from(
      root.current?.querySelectorAll<HTMLElement>('[data-group-id]') ?? [],
    ).find((el) => el.getBoundingClientRect().bottom > top);
    anchor.current = el ? { id: el.dataset.groupId!, top: el.getBoundingClientRect().top } : null;
  };
  useLayoutEffect(() => {
    const a = anchor.current;
    const scroller = root.current?.closest('.inspector-scroll');
    const el =
      a && root.current?.querySelector<HTMLElement>(`[data-group-id="${CSS.escape(a.id)}"]`);
    if (!a || !el || !scroller) return;
    const moved = el.getBoundingClientRect().top - a.top;
    if (!moved) return;
    moveScroll(scroller, scroller.scrollTop + moved);
    a.top = el.getBoundingClientRect().top;
  }, [groups, count]);
  // Something the person just sent: follow it to the bottom.
  const sentCount = sent.length;
  const sentBefore = useRef(sentCount);
  useEffect(() => {
    if (sentCount > sentBefore.current) {
      follow.current = true;
      setNewBelow(false);
      requestAnimationFrame(() => scrollBottom());
    }
    sentBefore.current = sentCount;
  }, [sentCount]);
  const canShowOlder = groups.length > count || older;
  const showOlder = () => {
    follow.current = false;
    keepPosition();
    // Shown ones first; the page before them once fewer than a step remain.
    if (groups.length - count < 24 && older) onOlder?.();
    setCount((previous) => previous + 24);
  };
  // Scrolling up to the top brings the earlier conversation in by itself (the button stays for
  // the keyboard and as the sign that there is more).
  // When the "earlier" button comes into view (scrolled up to it), the earlier part comes in by
  // itself — one step at a time: the page in flight and the kept position settle first.
  const olderButton = useRef<HTMLButtonElement>(null);
  const loadedAt = useRef(0);
  const topTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only after the person has scrolled: opening the card never reads further back by itself.
  const scrolledByPerson = useRef(false);
  const reachTop = useEffectEvent(() => {
    if (topTimer.current) clearTimeout(topTimer.current);
    topTimer.current = null;
    if (!scrolledByPerson.current || !canShowOlder || loadingOlder) return;
    const button = olderButton.current;
    const scroller = root.current?.closest('.inspector-scroll');
    if (!button || !scroller) return;
    const bounds = button.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    if (bounds.bottom < viewport.top - 400 || bounds.top > viewport.bottom) return;
    const wait = 800 - (performance.now() - loadedAt.current);
    if (wait > 0) {
      topTimer.current = setTimeout(() => reachTop(), wait + 20);
      return;
    }
    loadedAt.current = performance.now();
    showOlder();
  });
  // Still at the top once a page settled or the pause passed (the observer only tells changes):
  // look again, so staying up there keeps reading back.
  useEffect(() => {
    reachTop();
    return () => {
      if (topTimer.current) clearTimeout(topTimer.current);
      topTimer.current = null;
    };
  }, [loadingOlder, count, groups.length, canShowOlder, session.events[0]?.id]);
  useEffect(() => {
    const button = olderButton.current;
    const scroller = root.current?.closest('.inspector-scroll');
    if (!button || !scroller) return;
    const seen = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && reachTop(),
      { root: scroller, rootMargin: '400px 0px 0px 0px' },
    );
    seen.observe(button);
    return () => seen.disconnect();
  }, [canShowOlder]);
  useEffect(() => {
    const scroller = root.current?.closest('.inspector-scroll');
    if (!scroller) return;
    const onScroll = () => {
      const expected = programmaticTop.current;
      if (expected !== null && Math.abs(scroller.scrollTop - expected) < 1) return;
      programmaticTop.current = null;
      // The person scrolls on their own: their position is theirs again.
      scrolledByPerson.current = true;
      follow.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
      if (follow.current) setNewBelow(false);
      if (follow.current) anchor.current = null;
      else keepPosition();
      reachTop();
    };
    const readBack = () => {
      programmaticTop.current = null;
      follow.current = false;
      scrolledByPerson.current = true;
      keepPosition();
      // A short/filtered page cannot emit a scroll event, but upward input still reads back.
      reachTop();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) readBack();
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable="true"]')) return;
      if (
        ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ||
        (event.key === ' ' && event.shiftKey)
      )
        readBack();
    };
    const onTouch = () => {
      programmaticTop.current = null;
      follow.current = false;
    };
    scroller.addEventListener('scroll', onScroll);
    scroller.addEventListener('wheel', onWheel as EventListener, { passive: true });
    scroller.addEventListener('keydown', onKey as EventListener);
    scroller.addEventListener('touchstart', onTouch, { passive: true });
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
      scroller.removeEventListener('wheel', onWheel as EventListener);
      scroller.removeEventListener('keydown', onKey as EventListener);
      scroller.removeEventListener('touchstart', onTouch);
      observer.disconnect();
      mutations.disconnect();
    };
  }, []);
  useEffect(() => {
    if (pending.current) return;
    const raf = requestAnimationFrame(() => {
      if (follow.current) scrollBottom();
      else setNewBelow(true);
    });
    return () => cancelAnimationFrame(raf);
  }, [last]);
  // Opening a bookmark: once its message is loaded, it is shown (all kinds, its work group
  // open, enough older ones listed) and brought into view, marked for a moment. Until then
  // nothing else moves the reading position.
  const pending = useRef<{ eventId: string; at: number } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  useEffect(() => {
    if (pending.current) return;
    const raf = requestAnimationFrame(scrollBottom);
    return () => cancelAnimationFrame(raf);
  }, [filter]);
  const marks = useMemo(() => new Set(bookmarked), [bookmarked]);
  useEffect(() => {
    // Done elsewhere or given up (its page could not be read): nothing waits any more.
    if (!focus) {
      pending.current = null;
      return;
    }
    pending.current = { eventId: focus.eventId, at: focus.at };
    follow.current = false;
    setNewBelow(false);
    setFilter('all');
  }, [focus?.key]);
  useEffect(() => {
    const want = pending.current;
    // Only once the page reaching back to it is in: what the card holds before may be dropped
    // by the newest page arriving after it.
    if (!want || filter !== 'all' || !focus?.ready) return;
    const exact = events.find((e) => e.id === want.eventId);
    // Re-read under another id, or gone from the record: near its time once the reached page
    // is in, without marking another message as it.
    const target = exact ?? events.find((e) => e.at >= want.at);
    if (!target) {
      pending.current = null;
      notify(t.conversation.bookmarkMissing);
      onFocused?.();
      return;
    }
    if (conversationKind(target) === 'work' && !tools) return setTools(true);
    if (conversationKind(target) === 'progress' && hideProgress && onShowProgress)
      return onShowProgress();
    const index = groups.findIndex((g) => g.events.some((e) => e.id === target.id));
    if (index < 0) return;
    if (groups.length - index > count) return setCount(groups.length - index + 4);
    const raf = requestAnimationFrame(() => {
      const el = root.current?.querySelector<HTMLElement>(
        `[data-event-id="${CSS.escape(target.id)}"]`,
      );
      if (!el || pending.current !== want) return;
      pending.current = null;
      const group = el.closest('details');
      if (group) group.open = true;
      follow.current = false;
      anchor.current = null;
      el.scrollIntoView({ block: 'center' });
      programmaticTop.current = root.current?.closest('.inspector-scroll')?.scrollTop ?? null;
      setNewBelow(false);
      if (exact) setFocused(target.id);
      else notify(t.conversation.bookmarkNear);
      onFocused?.();
    });
    return () => cancelAnimationFrame(raf);
  }, [events, groups, count, tools, hideProgress, filter, focus?.ready, focus?.key]);
  useEffect(() => {
    if (!focused) return;
    const timer = setTimeout(() => setFocused(null), 2400);
    return () => clearTimeout(timer);
  }, [focused]);
  const markOf = (e: OfficeEvent) => ({
    marked: marks.has(e.id),
    onMark: onBookmark && ((on: boolean) => onBookmark(e.id, on)),
    focused: focused === e.id,
  });
  return (
    <div
      className="conversation"
      ref={root}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('.message-expand, summary')) follow.current = false;
      }}
    >
      {/* One sticky block: the folded filters and, opened, the filters themselves. */}
      <div className={compact ? 'conversation-sticky' : 'conversation-filters-block'}>
        {(!compact || filtersOpen) && (
          <div className="conversation-toolbar">
            <div
              className="conversation-filters"
              role="group"
              aria-label={t.conversation.filtersLabel}
            >
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
                    // A fresh filter starts at the newest again: no reading back until scrolled.
                    scrolledByPerson.current = false;
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
        )}
      </div>
      {hideProgress && filter === 'all' && counts.progress > 0 && (
        <p className="conversation-hidden-note">
          {t.inspector.card.progressHidden(counts.progress)}
        </p>
      )}
      {!compact && (
        <div className="conversation-range">
          <Clock3 size={12} />
          {session.partial ? t.conversation.rangePartial : t.conversation.rangeFull}
          <span>{t.conversation.readOnly}</span>
        </div>
      )}
      {(groups.length > count || older) && (
        <button
          ref={olderButton}
          className="older-messages"
          disabled={loadingOlder}
          onClick={showOlder}
        >
          {loadingOlder
            ? t.conversation.loadingOlder
            : groups.length > count
              ? t.conversation.older(Math.min(24, groups.length - count))
              : t.conversation.loadOlder}
        </button>
      )}
      {shown.map((g) => (
        <Fragment key={g.id}>
          {runs.get(g.id)?.pause != null && (
            <div className="conversation-pause">
              <time title={date(runs.get(g.id)!.pause!)}>{pauseLabel(runs.get(g.id)!.pause!)}</time>
            </div>
          )}
          {g.work ? (
            <details className="work-group" key={g.id} data-group-id={g.id}>
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
                    name={name}
                    notify={notify}
                    key={e.id + i}
                    expanded={expanded.has(e.id)}
                    onExpand={() => toggleMessage(e.id)}
                    {...markOf(e)}
                  />
                ))}
              </div>
            </details>
          ) : (
            <Message
              key={g.id}
              event={g.events[0]}
              provider={session.provider}
              name={name}
              notify={notify}
              expanded={expanded.has(g.id)}
              onExpand={() => toggleMessage(g.id)}
              group={g.id}
              continued={runs.get(g.id)?.continued}
              {...markOf(g.events[0])}
            />
          )}
        </Fragment>
      ))}
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
      {filter === 'all' &&
        sent.map((p) => (
          <article
            key={p.id}
            className="conversation-message message-user message-pending"
            data-message-category="request"
          >
            <div className="message-meta">
              <span>{t.conversation.you}</span>
              <small>{t.conversation.pending}</small>
              {onDismissSent && (
                <button
                  aria-label={t.conversation.hideSent}
                  title={t.conversation.hideSentHint}
                  onClick={() => onDismissSent(p.id)}
                >
                  ×
                </button>
              )}
            </div>
            <div className="message-bubble">
              <div className="message-text">
                <p>{p.text}</p>
              </div>
            </div>
          </article>
        ))}
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
