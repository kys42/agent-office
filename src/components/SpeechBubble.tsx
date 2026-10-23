import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  BellRing,
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Cloud,
  Copy,
  MessageSquare,
  PanelRightOpen,
  PenLine,
  Pin,
  Reply,
  TriangleAlert,
  User,
  X,
  type LucideIcon,
} from 'lucide-react';
import { MOODS, PROVIDERS, type Session } from '../shared/types';
import { sessionName } from '../shared/office';
import { noticeExposure } from '../shared/notices';
import { toolLabel } from '../shared/activity';
import { TONE_LABELS, type BubbleTone, type StationSpeech } from '../shared/speech';
import { useReadingTextRevision } from '../lib/useReadingText';
import { ago } from '../lib/format';
import { BubbleMarkdown } from './BubbleMarkdown';
import { useI18n } from '../lib/i18n';
import { FilesHere, LinkifiedText } from './WebLink';
import { api } from '../lib/api';

/** A non-empty text selection inside this element (the person is selecting, not clicking). */
function selectionWithin(el: HTMLElement) {
  const selection = window.getSelection();
  return (
    !!selection &&
    !selection.isCollapsed &&
    selection.toString().trim() !== '' &&
    !!selection.anchorNode &&
    el.contains(selection.anchorNode)
  );
}

const TONE_ICONS: Record<BubbleTone, LucideIcon> = {
  mine: User,
  thought: Cloud,
  progress: PenLine,
  reply: CircleCheck,
  attention: BellRing,
  error: TriangleAlert,
  message: MessageSquare,
};

/**
 * A desk's speech bubble. Each kind of speech has its own shape (see speech.css): the
 * person's own request, a thought cloud, work notes, the final answer, a call, an error. The scene decides where it sits and what opening it does.
 * Read state is drawn (unread dot, muted border) rather than written; the words stay for
 * screen readers. Long text can be unfolded in place.
 */
export function SpeechBubble({
  session: s,
  speech,
  privacy,
  onOpen,
  onDismiss,
  detail,
  peek = false,
  reply,
  onPopup,
  expanded,
  onExpandedChange,
  onViewed,
  quote = false,
  onKeep,
}: {
  session: Session;
  speech: StationSpeech;
  privacy: boolean;
  /** Gets the bubble element, so a scene can open things right where it was clicked. */
  onOpen: (bubble: HTMLElement) => void;
  onDismiss: () => void;
  /** Extra facts shown when the bubble is unfolded (or hovered, where the scene allows). */
  detail?: ReactNode;
  /** A closed or expired bubble shown again while pointed at: muted, nothing to close. */
  peek?: boolean;
  /** Quick reply, offered only when the session can take a follow-up right now. */
  reply?: { title: string; open: boolean; onClick: () => void };
  /** Dock views: an unfolded bubble offers the colleague's pop-up card (the desk click is easy to miss). */
  onPopup?: (anchor: Element) => void;
  /** Controlled unfolding, for scenes where opening a bubble means reading it in place. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Unfolding the text counts as a view, including the chevron / keyboard path. */
  onViewed?: () => void;
  /** While pointed at: the person's request as its own bubble right above, to recall what was asked. */
  quote?: boolean;
  /** A peek of a read reply: keep it up again (marks it unread, for "later"). */
  onKeep?: () => void;
}) {
  const { t } = useI18n();
  const { bubble, activity, text, label, markdown, tone } = speech;
  const request = quote ? speech.request : undefined;
  const Icon = TONE_ICONS[tone];
  // The person's request and thinking read as themselves; others keep their precise label.
  const heading = tone === 'mine' || tone === 'thought' ? TONE_LABELS[tone] : label;
  const body = useRef<HTMLDivElement>(null);
  const [ownOpen, setOwnOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const open = expanded ?? ownOpen;
  const setOpen = (next: boolean | ((v: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(open) : next;
    if (value && !open && !privacy) onViewed?.();
    if (expanded === undefined) setOwnOpen(value);
    onExpandedChange?.(value);
  };
  // Unfolded, it folds back once the person turns to something else: a click outside it (its
  // reply box counts as inside) or another app (the window loses focus).
  const root = useRef<HTMLDivElement>(null);
  const fold = useEffectEvent(() => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el || root.current?.contains(el)) return;
      // Its own reply box (drawn beside it in the same desk or pet) counts as inside; another
      // desk's does not.
      const reply = el.closest('.quick-reply');
      const desk = root.current?.closest('.desk-station, .dock-pet-speech');
      if (reply && desk?.contains(reply)) return;
      fold();
    };
    const blur = () => fold();
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('blur', blur);
    };
  }, [open]);
  const [long, setLong] = useState(false);
  // A new reading size or font reflows the text inside a box that may keep its height.
  const reflow = useReadingTextRevision();
  // The request bubble scrolls: a fade says there's more until its end is reached.
  const asked = useRef<HTMLParagraphElement>(null);
  const [more, setMore] = useState(false);
  const measure = () => {
    const el = asked.current;
    setMore(!!el && el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  };
  useLayoutEffect(measure, [request?.id, speech.requestText, privacy, reflow]);
  // Shown later (the pet reveals it on hover) or resized: measure again.
  useEffect(() => {
    const el = asked.current;
    if (!el) return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [request?.id]);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || open) return;
    el.scrollTop = 0;
    const measureBody = () =>
      setLong(
        el.scrollHeight > el.clientHeight + 1 ||
          [...el.querySelectorAll<HTMLElement>('.bubble-table')].some(
            (table) => table.scrollWidth > table.clientWidth + 1,
          ),
      );
    measureBody();
    const watch = new ResizeObserver(measureBody);
    watch.observe(el);
    return () => watch.disconnect();
  }, [text, markdown, open, privacy, request?.id, reflow]);
  const exposure = bubble ? noticeExposure(bubble) : null;
  return (
    <div
      ref={root}
      data-tone={tone}
      className={`speech-bubble tone-${tone} bubble-${s.status} ${bubble ? `bubble-kind-${bubble.kind === 'reply' && bubble.phase !== 'final' ? 'message' : bubble.kind}` : 'bubble-live'} ${bubble && !bubble.seenAt ? 'unread' : ''} ${bubble?.viewedAt || bubble?.seenAt ? 'bubble-opened' : 'bubble-new'} ${open ? 'is-expanded' : ''} ${peek ? 'is-peek' : ''}`}
    >
      {tone === 'attention' && <span className="bubble-halo" aria-hidden="true" />}
      {request && (
        // Its own bubble, never cut: long requests scroll inside it.
        <div
          className={`speech-request-bubble ${more ? 'has-more' : ''}`}
          title={
            privacy
              ? t.desk.bubble.requestTitle
              : `${t.desk.bubble.requestTitle}\n${speech.requestText ?? request.text}`
          }
        >
          <small>
            <User size={9} strokeWidth={2.6} aria-hidden="true" />
            {t.desk.bubble.request}
            <em>{ago(request.at)}</em>
          </small>
          <p className="speech-request-text" ref={asked} onScroll={measure}>
            {privacy ? t.desk.hidden : (speech.requestText ?? request.text)}
          </p>
        </div>
      )}
      {/* Not a <button>: its words can be selected and copied, and links inside open. */}
      <div
        className="speech-open"
        role="button"
        tabIndex={0}
        onClick={(e) => {
          // Dragging (or double-clicking) to select words is reading, not opening.
          if (e.detail > 1 || selectionWithin(e.currentTarget)) return;
          onOpen(e.currentTarget.closest<HTMLElement>('.speech-bubble')!);
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          onOpen(e.currentTarget.closest<HTMLElement>('.speech-bubble')!);
        }}
        title={privacy ? t.desk.hidden : `${exposure ? `${exposure} · ` : ''}${text}`}
      >
        <div className="speech-copy">
          <small>
            <span className="bubble-label">
              <Icon size={9} strokeWidth={2.6} aria-hidden="true" />
              {privacy ? t.desk.hidden : heading}
              {tone === 'progress' && (
                <i className="bubble-typing" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </i>
              )}
            </span>
            <em>
              {peek && <span className="bubble-peek">{t.desk.bubble.peek}</span>}
              {exposure && <span className="bubble-exposure">{exposure}</span>}
              {ago(bubble?.at ?? activity.at)}
              {!privacy && activity.tool ? ` · ${toolLabel(activity.tool.name)}` : ''}
            </em>
          </small>
          <div className="speech-text" ref={body}>
            {privacy ? (
              MOODS[s.status].label
            ) : markdown ? (
              <FilesHere.Provider value={!s.remote}>
                <BubbleMarkdown text={markdown} />
              </FilesHere.Provider>
            ) : (
              <LinkifiedText text={text} />
            )}
          </div>
          {detail && <span className="speech-detail">{detail}</span>}
        </div>
      </div>
      {open && !privacy && (
        <button
          className="bubble-copy"
          aria-label={t.desk.bubble.copyAllLabel}
          title={copied ? t.desk.bubble.copied : t.desk.bubble.copyAll}
          onClick={(e) => {
            e.stopPropagation();
            const words = markdown ?? text;
            void (api.copyText ?? ((value: string) => navigator.clipboard.writeText(value)))(words)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => {});
          }}
        >
          {copied ? <Check size={10} strokeWidth={2.8} /> : <Copy size={10} strokeWidth={2.6} />}
        </button>
      )}
      {(long || open || detail) && (
        <button
          className="bubble-expand"
          aria-label={open ? t.desk.bubble.collapseLabel : t.desk.bubble.expandLabel}
          aria-expanded={open}
          title={open ? t.desk.bubble.collapse : t.desk.bubble.expand}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? (
            <ChevronUp size={11} strokeWidth={2.6} />
          ) : (
            <ChevronDown size={11} strokeWidth={2.6} />
          )}
        </button>
      )}
      {tone === 'thought' && (
        <span className="bubble-trail" aria-hidden="true">
          <i />
          <i />
        </span>
      )}
      {onPopup && open && (
        <button
          className="bubble-popup"
          title={t.desk.row.cardTitle}
          aria-label={t.desk.row.openCard(privacy ? PROVIDERS[s.provider].name : sessionName(s))}
          onClick={(e) => {
            e.stopPropagation();
            onPopup(e.currentTarget);
          }}
        >
          <PanelRightOpen size={10} strokeWidth={2.6} />
        </button>
      )}
      {reply && (
        <button
          className={`bubble-reply ${reply.open ? 'open' : ''}`}
          aria-label={t.terminal.replyTo(sessionName(s))}
          aria-expanded={reply.open}
          title={reply.title}
          onClick={(e) => {
            e.stopPropagation();
            reply.onClick();
          }}
        >
          <Reply size={11} strokeWidth={2.6} />
        </button>
      )}
      {onKeep && (
        <button
          className="bubble-dismiss bubble-keep"
          aria-label={t.desk.bubble.keep(privacy ? undefined : sessionName(s))}
          title={t.desk.bubble.keepTitle}
          onClick={(e) => {
            e.stopPropagation();
            onKeep();
          }}
        >
          <Pin size={10} strokeWidth={2.6} />
        </button>
      )}
      {bubble && !peek && (
        <button
          className="bubble-dismiss"
          aria-label={t.desk.bubble.dismiss(privacy ? undefined : sessionName(s))}
          title={t.desk.bubble.dismissTitle}
          onClick={onDismiss}
        >
          <X size={11} strokeWidth={2.6} />
        </button>
      )}
    </div>
  );
}
