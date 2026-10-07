import type { Mood, Session } from '../shared/types';
import { sessionName } from '../shared/office';
import { Furniture } from './Furniture';
import { Sprite } from './Sprite';
import { useI18n } from '../lib/i18n';

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
  const { t } = useI18n();
  const responded = s.runtime?.phase === 'responded' && !working;
  return (
    <button
      className={`helper-desk ${working ? 'helper-working' : ''} ${className}`}
      data-session-id={s.id}
      data-parent-id={parentId}
      data-furniture="helper-desk"
      data-solid
      style={{ transform: `translate(${at.x}px, ${at.y}px)` }}
      aria-label={t.desk.helper.label(privacy ? s.provider : sessionName(s), responded)}
      title={privacy ? undefined : `${sessionName(s)} · ${s.relation?.role || t.desk.helper.name}`}
      onClick={onClick}
    >
      <Sprite session={s} provider={s.provider} mood={mood} size={44} />
      <Furniture kind="helper" />
      {responded && (
        <span className="helper-result" title={t.desk.helper.result}>
          ✓
        </span>
      )}
      <b>{privacy ? t.desk.helper.name : s.relation?.role || sessionName(s)}</b>
      {news && <i className="helper-news" />}
    </button>
  );
}
