import { Expand, GripHorizontal, X, EyeOff } from 'lucide-react';
import type { Session, OfficeNotice } from '../shared/types';
import { MOODS } from '../shared/types';
import { Sprite } from './Sprite';
import { api } from '../lib/api';
import { isInboxNotice } from '../shared/notices';
import { presentSession } from '../shared/presentation';
import { sessionName } from '../shared/office';
import { sessionActivity, activityLabel } from '../shared/activity';
export function MiniOffice({
  sessions,
  notices,
  privacy,
  reducedMotion,
}: {
  sessions: Session[];
  notices: OfficeNotice[];
  privacy: boolean;
  reducedMotion: boolean;
}) {
  const primary = sessions
    .filter((s) => !s.attachedTo)
    .sort((a, b) => (a.officeSeat ?? 0) - (b.officeSeat ?? 0));
  return (
    <div className={`mini-office ${reducedMotion ? 'reduce-motion' : ''}`}>
      <div className="mini-bar">
        <span className="live-dot" />
        <b>우리 사무실</b>
        <span className="mini-count">
          {sessions.length}명의 동료{primary.length > 6 ? ` · 펼치면 모두 보여요` : ''}
        </span>
        <div className="drag-zone">
          <GripHorizontal size={19} />
        </div>
        <button className="icon-btn" aria-label="사무실 펼치기" onClick={() => api.window('main')}>
          <Expand size={16} />
        </button>
        <button
          className="icon-btn"
          aria-label="미니 오피스 숨기기"
          onClick={() => api.window('hide')}
        >
          <X size={16} />
        </button>
      </div>
      <div className="mini-desks">
        {primary.slice(0, 6).map((s, i) => (
          <button
            className={`mini-station ${presentSession(s).working ? 'mini-working' : ''}`}
            key={s.id}
            style={{ gridColumn: i + 1 }}
            data-seat={s.officeSeat}
            onClick={() => api.window('main', s.id)}
            aria-label={`${privacy ? s.provider : sessionName(s)} 업무 보기`}
            title={privacy ? undefined : `${activityLabel(s)} · ${sessionActivity(s).text}`}
          >
            <span className={`mini-status pill-${s.status}`}>
              <i style={{ background: MOODS[s.status].color }} />
              {MOODS[s.status].label}
            </span>
            {notices.some(
              (n) =>
                !n.seenAt &&
                isInboxNotice(n) &&
                ((s.resident?.sessionIds ?? [s.id]).includes(n.sessionId) ||
                  sessions.some((c) => c.id === n.sessionId && c.attachedTo === s.id)),
            ) && <span className="mini-unread">새 소식</span>}
            <div className="mini-pet">
              <Sprite provider={s.provider} mood={presentSession(s).mood} size={64} />
            </div>
            <img src="./sprites/desk.png" alt="" />
            <b title={privacy ? undefined : sessionName(s)}>
              {privacy ? s.provider : sessionName(s)}
            </b>
            <small className="mini-project">{privacy ? '프로젝트' : s.project}</small>
          </button>
        ))}
        {sessions.length === 0 && (
          <div className="mini-empty">동료들의 기록을 기다리고 있어요.</div>
        )}
      </div>
      <div className="mini-floor" />
    </div>
  );
}
