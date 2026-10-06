import { X } from 'lucide-react';
import { MOODS, type Session } from '../shared/types';
import { sessionName } from '../shared/office';
import { noticeExposure } from '../shared/notices';
import { toolLabel } from '../shared/activity';
import type { StationSpeech } from '../shared/speech';
import { ago } from '../lib/format';

/** A desk's speech bubble. The scene decides where it sits and what opening it does. */
export function SpeechBubble({
  session: s,
  speech,
  privacy,
  onOpen,
  onDismiss,
}: {
  session: Session;
  speech: StationSpeech;
  privacy: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { bubble, activity, text, label } = speech;
  return (
    <div
      className={`speech-bubble bubble-${s.status} ${bubble ? `bubble-kind-${bubble.kind === 'reply' && bubble.phase !== 'final' ? 'message' : bubble.kind}` : 'bubble-live'} ${bubble && !bubble.seenAt ? 'unread' : ''} ${bubble?.viewedAt || bubble?.seenAt ? 'bubble-opened' : 'bubble-new'}`}
    >
      <button className="speech-open" onClick={onOpen} title={privacy ? '내용 숨김' : text}>
        <span className="speech-copy">
          <small>
            <span className="bubble-label">{privacy ? '내용 숨김' : label}</span>
            <em>
              {bubble && <span className="bubble-exposure">{noticeExposure(bubble)}</span>}
              {ago(bubble?.at ?? activity.at)}
              {!privacy && activity.tool ? ` · ${toolLabel(activity.tool.name)}` : ''}
            </em>
          </small>
          <b>{privacy ? MOODS[s.status].label : text}</b>
        </span>
      </button>
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
