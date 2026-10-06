import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Coffee, Expand, X } from 'lucide-react';
import { api } from '../lib/api';
import { MOODS } from '../shared/types';
import { hasNews, residentLabel, type OfficeModel } from '../shared/office-model';
import { deskWidth } from '../shared/dock-geometry';
import { Sprite } from './Sprite';

/** Width kept free for the end caps (title on the left, tools on the right). */
const CAPS_W = 420;

/** The expanded dock: every office colleague at one long row of desks on the screen edge. */
export function DeskRow({
  model,
  loading,
  privacy,
  onCollapse,
}: {
  model: OfficeModel;
  loading: boolean;
  privacy: boolean;
  onCollapse: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  // A mouse wheel scrolls the row sideways when there are more desks than fit.
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const { seats } = model;
  const desk = deskWidth(seats.length, width - CAPS_W);
  const lounge = model.zones.waiting.filter((s) => !s.attachedTo).length;
  return (
    <div className="desk-row">
      <div className="desk-row-floor" data-solid />
      <div className="desk-row-cap desk-row-title" data-solid>
        <button
          className="desk-row-pet"
          aria-label="펫으로 접기"
          title="펫으로 접기 · Esc"
          onClick={onCollapse}
        >
          <Sprite
            provider={model.lead?.session.provider ?? 'claude'}
            mood={model.lead?.pose.mood ?? 'idle'}
            size={36}
          />
        </button>
        <span>
          <b>
            <span className="live-dot" />
            우리 사무실
          </b>
          <small>
            동료 {seats.length}명
            {model.counts.attention ? ` · 기다려요 ${model.counts.attention}` : ''}
            {model.counts.results ? ` · 새 소식 ${model.counts.results}` : ''}
          </small>
        </span>
      </div>
      <div className="desk-row-track" ref={track}>
        <div className="desk-row-lane">
          {seats.map((v) => {
            const s = v.session;
            const label = residentLabel(s, privacy);
            return (
              <button
                key={s.id}
                className={`row-desk group-${v.group} ${v.pose.working ? 'is-working' : ''}`}
                style={{ width: desk }}
                data-solid
                data-seat={s.officeSeat}
                onClick={() => api.window('main', s.id)}
                aria-label={`${label.name} 업무 보기`}
                title={label.detail}
              >
                <span className="row-status">
                  <i style={{ background: MOODS[s.status].color }} />
                  {MOODS[s.status].label}
                </span>
                {hasNews(v) && <span className="row-news">새 소식</span>}
                <span className="row-pet">
                  <Sprite provider={s.provider} mood={v.pose.mood} size={64} />
                </span>
                <img className="row-desk-img" src="./sprites/desk.png" alt="" />
                <b className="row-name" title={privacy ? undefined : label.name}>
                  {label.name}
                </b>
                <small className="row-project">{label.project}</small>
              </button>
            );
          })}
          {!seats.length && (
            <div className="row-empty" data-solid>
              {loading ? '사무실 문을 여는 중…' : '동료들의 기록을 기다리고 있어요.'}
            </div>
          )}
        </div>
      </div>
      <div className="desk-row-cap desk-row-tools" data-solid>
        {lounge > 0 && (
          <span className="desk-row-lounge" title="대기 라운지에서 쉬는 동료">
            <Coffee size={12} />
            라운지 {lounge}
          </span>
        )}
        <button
          className="icon-btn"
          aria-label="사무실 펼치기"
          title="큰 사무실 열기"
          onClick={() => api.window('main')}
        >
          <Expand size={15} />
        </button>
        <button
          className="icon-btn"
          aria-label="책상 줄 접기"
          title="펫으로 접기 · Esc"
          onClick={onCollapse}
        >
          <ChevronDown size={16} />
        </button>
        <button
          className="icon-btn"
          aria-label="데스크 펫 숨기기"
          title="숨기기 · 트레이에서 다시 열 수 있어요"
          onClick={() => api.window('hide')}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
