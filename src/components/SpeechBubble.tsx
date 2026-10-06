import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { MOODS, type Session } from '../shared/types';
import { sessionName } from '../shared/office';
import { noticeExposure } from '../shared/notices';
import { toolLabel } from '../shared/activity';
import type { StationSpeech } from '../shared/speech';
import { ago } from '../lib/format';
import { InlineMarkdown } from './InlineMarkdown';

/**
 * A desk's speech bubble. The scene decides where it sits and what opening it does.
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
}: {
  session: Session;
  speech: StationSpeech;
  privacy: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  /** Extra facts shown when the bubble is unfolded (or hovered, where the scene allows). */
  detail?: ReactNode;
}) {
  const { bubble, activity, text, label, markdown } = speech;
  const body = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, markdown, open, privacy]);
  const exposure = bubble ? noticeExposure(bubble) : null;
  return (
    <div
      className={`speech-bubble bubble-${s.status} ${bubble ? `bubble-kind-${bubble.kind === 'reply' && bubble.phase !== 'final' ? 'message' : bubble.kind}` : 'bubble-live'} ${bubble && !bubble.seenAt ? 'unread' : ''} ${bubble?.viewedAt || bubble?.seenAt ? 'bubble-opened' : 'bubble-new'} ${open ? 'is-expanded' : ''}`}
    >
      <button
        className="speech-open"
        onClick={onOpen}
        title={privacy ? '내용 숨김' : `${exposure ? `${exposure} · ` : ''}${text}`}
      >
        <span className="speech-copy">
          <small>
            <span className="bubble-label">{privacy ? '내용 숨김' : label}</span>
            <em>
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
      {bubble && (
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
