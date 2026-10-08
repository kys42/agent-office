import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  BellRing,
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Cloud,
  Copy,
  MessageSquare,
  PenLine,
  Reply,
  TriangleAlert,
  User,
  X,
  type LucideIcon,
} from 'lucide-react';
import { MOODS, type Session } from '../shared/types';
import { sessionName } from '../shared/office';
import { noticeExposure } from '../shared/notices';
import { toolLabel } from '../shared/activity';
import { TONE_LABELS, type BubbleTone, type StationSpeech } from '../shared/speech';
import { ago } from '../lib/format';
import { InlineMarkdown } from './InlineMarkdown';
import { useI18n } from '../lib/i18n';
import { LinkifiedText } from './WebLink';
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
  expanded,
  onExpandedChange,
  quote = false,
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
  /** Controlled unfolding, for scenes where opening a bubble means reading it in place. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** While pointed at: the person's request as its own bubble right above, to recall what was asked. */
  quote?: boolean;
}) {
  const { t } = useI18n();
  const { bubble, activity, text, label, markdown, tone } = speech;
  const request = quote ? speech.request : undefined;
  const Icon = TONE_ICONS[tone];
  // The person's request and thinking read as themselves; others keep their precise label.
  const heading = tone === 'mine' || tone === 'thought' ? TONE_LABELS[tone] : label;
  const body = useRef<HTMLElement>(null);
  const [ownOpen, setOwnOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const open = expanded ?? ownOpen;
  const setOpen = (next: boolean | ((v: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(open) : next;
    if (expanded === undefined) setOwnOpen(value);
    onExpandedChange?.(value);
  };
  const [long, setLong] = useState(false);
  // The request bubble scrolls: a fade says there's more until its end is reached.
  const asked = useRef<HTMLParagraphElement>(null);
  const [more, setMore] = useState(false);
  const measure = () => {
    const el = asked.current;
    setMore(!!el && el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  };
  useLayoutEffect(measure, [request?.id, speech.requestText, privacy]);
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
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, markdown, open, privacy, request?.id]);
  const exposure = bubble ? noticeExposure(bubble) : null;
  return (
    <div
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
        <span className="speech-copy">
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
          <b ref={body}>
            {privacy ? (
              MOODS[s.status].label
            ) : markdown ? (
              <InlineMarkdown text={markdown} />
            ) : (
              <LinkifiedText text={text} />
            )}
          </b>
          {detail && <span className="speech-detail">{detail}</span>}
        </span>
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
