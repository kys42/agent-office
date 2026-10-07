import { useEffect, useRef, useState } from 'react';
import { MOODS, type Mood, type Session } from '../shared/types';
import { sessionName } from '../shared/office';
import { Furniture } from './Furniture';
import { Sprite } from './Sprite';

/** A real subagent/child at its own low desk beside the colleague it works for. */
export function HelperDesk({
  session: s,
  parentId,
  at,
  mood,
  working,
  news,
  privacy,
  className = '',
  onClick,
}: {
  session: Session;
  parentId: string;
  at: { x: number; y: number };
  mood: Mood;
  working: boolean;
  news: boolean;
  privacy: boolean;
  className?: string;
  onClick: () => void;
}) {
  const responded = s.runtime?.phase === 'responded' && !working;
  return (
    <button
      className={`helper-desk ${working ? 'helper-working' : ''} ${className}`}
      data-session-id={s.id}
      data-parent-id={parentId}
      data-furniture="helper-desk"
      data-solid
      style={{ transform: `translate(${at.x}px, ${at.y}px)` }}
      aria-label={`${privacy ? s.provider : sessionName(s)}, 보조 동료${responded ? ', 결과 남김' : ''}`}
      title={privacy ? undefined : `${sessionName(s)} · ${s.relation?.role || '보조 동료'}`}
      onClick={onClick}
    >
      <Sprite provider={s.provider} mood={mood} size={44} />
      <Furniture kind="helper" />
      {responded && (
        <span className="helper-result" title="응답을 남겼어요 · 메인의 다음 요청까지 머물러요">
          ✓
        </span>
      )}
      <b>{privacy ? '보조 동료' : s.relation?.role || sessionName(s)}</b>
      {news && <i className="helper-news" />}
    </button>
  );
}

/**
 * Many helpers on one colleague share one stacked desk ("×N"): the one that most needs
 * attention sits in front, and the list keeps every helper one click away.
 */
export function HelperStack({
  members,
  parentId,
  at,
  pose,
  news,
  privacy,
  className = '',
  onOpen,
}: {
  members: Session[];
  parentId: string;
  at: { x: number; y: number };
  pose: (s: Session) => { mood: Mood; working: boolean };
  news: (s: Session) => boolean;
  privacy: boolean;
  className?: string;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  const calling = (s: Session) => s.status === 'call' || s.status === 'error';
  const lead = [...members].sort(
    (a, b) =>
      Number(calling(b)) - Number(calling(a)) ||
      Number(pose(b).working) - Number(pose(a).working) ||
      b.updatedAt - a.updatedAt,
  )[0];
  const anyCalling = members.some(calling);
  const anyNews = members.some(news);
  const name = (s: Session) => (privacy ? '보조 동료' : s.relation?.role || sessionName(s));
  const count = members.length;
  return (
    <div
      ref={box}
      className={`helper-stack ${open ? 'is-open' : ''}`}
      data-parent-id={parentId}
      style={{ transform: `translate(${at.x}px, ${at.y}px)` }}
    >
      <button
        className={`helper-desk helper-stack-desk ${members.some((s) => pose(s).working) ? 'helper-working' : ''} ${className}`}
        data-session-id={lead.id}
        data-furniture="helper-desk"
        data-solid
        aria-expanded={open}
        aria-label={`보조 동료 ${count}명${anyCalling ? ', 부르는 보조 있음' : ''} · 명단 보기`}
        title={privacy ? undefined : members.map(name).join('\n')}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="helper-stack-back" aria-hidden="true">
          <i />
          <i />
        </span>
        <Sprite provider={lead.provider} mood={pose(lead).mood} size={44} />
        <Furniture kind="helper" />
        <em className="helper-stack-count">×{count}</em>
        {anyCalling && <span className="helper-stack-bang">!</span>}
        <b>보조 {count}명</b>
        {anyNews && <i className="helper-news" />}
      </button>
      {open && (
        <ul className="helper-stack-list" data-solid aria-label="보조 동료 명단">
          {members.map((s) => (
            <li key={s.id}>
              <button
                data-session-id={s.id}
                onClick={() => {
                  setOpen(false);
                  onOpen(s.id);
                }}
              >
                <Sprite provider={s.provider} mood={pose(s).mood} size={22} />
                <span className="helper-stack-name">{name(s)}</span>
                <i style={{ background: MOODS[s.status].color }} title={MOODS[s.status].label} />
                {news(s) && <em className="helper-news" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
