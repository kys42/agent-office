import type { Mood, Session } from '../shared/types';
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
