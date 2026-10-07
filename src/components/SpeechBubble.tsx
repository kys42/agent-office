import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  BellRing,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Cloud,
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
}) {
  const { bubble, activity, text, label, markdown, tone } = speech;
  const Icon = TONE_ICONS[tone];
  // The person's request and thinking read as themselves; others keep their precise label.
  const heading = tone === 'mine' || tone === 'thought' ? TONE_LABELS[tone] : label;
  const body = useRef<HTMLElement>(null);
  const [ownOpen, setOwnOpen] = useState(false);
  const open = expanded ?? ownOpen;
  const setOpen = (next: boolean | ((v: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(open) : next;
    if (expanded === undefined) setOwnOpen(value);
    onExpandedChange?.(value);
  };
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, markdown, open, privacy]);
  const exposure = bubble ? noticeExposure(bubble) : null;
  return (
    <div
      data-tone={tone}
      className={`speech-bubble tone-${tone} bubble-${s.status} ${bubble ? `bubble-kind-${bubble.kind === 'reply' && bubble.phase !== 'final' ? 'message' : bubble.kind}` : 'bubble-live'} ${bubble && !bubble.seenAt ? 'unread' : ''} ${bubble?.viewedAt || bubble?.seenAt ? 'bubble-opened' : 'bubble-new'} ${open ? 'is-expanded' : ''} ${peek ? 'is-peek' : ''}`}
    >
      <button
        className="speech-open"
        onClick={(e) => onOpen(e.currentTarget.closest<HTMLElement>('.speech-bubble')!)}
        title={privacy ? '내용 숨김' : `${exposure ? `${exposure} · ` : ''}${text}`}
      >
        <span className="speech-copy">
          <small>
            <span className="bubble-label">
              <Icon size={9} strokeWidth={2.6} aria-hidden="true" />
              {privacy ? '내용 숨김' : heading}
              {tone === 'progress' && (
                <i className="bubble-typing" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </i>
              )}
            </span>
            <em>
              {peek && <span className="bubble-peek">지난 말풍선</span>}
              {exposure && <span className="bubble-exposure">{exposure}</span>}
              {ago(bubble?.at ?? activity.at)}
              {!privacy && activity.tool ? ` · ${toolLabel(activity.tool.name)}` : ''}
            </em>
          </small>
          <b ref={body}>
            {privacy ? MOODS[s.status].label : markdown ? <InlineMarkdown text={markdown} /> : text}
          </b>
          {detail && <span className="speech-detail">{detail}</span>}
        </span>
      </button>
      {(long || open || detail) && (
        <button
          className="bubble-expand"
          aria-label={open ? '말풍선 짧게 보기' : '말풍선 전체 보기'}
          aria-expanded={open}
          title={open ? '짧게 보기' : '전체 보기'}
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
          aria-label={`${sessionName(s)}에게 바로 답장`}
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
          aria-label={`${privacy ? '동료' : sessionName(s)} 말풍선 접기`}
          title="말풍선만 접기 · 미확인 소식은 남아요"
          onClick={onDismiss}
        >
          <X size={11} strokeWidth={2.6} />
        </button>
      )}
    </div>
  );
}
