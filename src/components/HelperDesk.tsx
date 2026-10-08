import { useEffect, useRef, useState } from 'react';
import { EyeOff } from 'lucide-react';
import { MOODS, type Mood, type Session } from '../shared/types';
import { sessionName } from '../shared/office';
import { stackLead } from '../shared/presentation';
import { Furniture } from './Furniture';
import { Sprite } from './Sprite';
import { VeilButton } from './VeilButton';
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
  onVeil,
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
  /** Hide just this helper (absent while it needs the person). */
  onVeil?: () => void;
}) {
  const { t } = useI18n();
  const responded = s.runtime?.phase === 'responded' && !working;
  const name = privacy ? t.desk.helper.name : s.relation?.role || sessionName(s);
  return (
    <>
      <button
        className={`helper-desk ${working ? 'helper-working' : ''} ${className}`}
        data-session-id={s.id}
        data-parent-id={parentId}
        data-furniture="helper-desk"
        data-solid
        style={{ transform: `translate(${at.x}px, ${at.y}px)` }}
        aria-label={t.desk.helper.label(privacy ? s.provider : sessionName(s), responded)}
        title={
          privacy ? undefined : `${sessionName(s)} · ${s.relation?.role || t.desk.helper.name}`
        }
        onClick={onClick}
      >
        <Sprite session={s} provider={s.provider} mood={mood} size={44} />
        <Furniture kind="helper" />
        {responded && (
          <span className="helper-result" title={t.desk.helper.result}>
            ✓
          </span>
        )}
        <b>{name}</b>
        {news && <i className="helper-news" />}
      </button>
      {/* A sibling, not inside the desk: hiding must never also open the work card. */}
      {onVeil && (
        <VeilButton
          name={name}
          onVeil={onVeil}
          className="helper-veil"
          style={{ left: at.x + 2, top: at.y - 4 }}
        />
      )}
    </>
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
  selected,
  className = '',
  onOpen,
  canVeil = () => true,
  onVeil,
}: {
  members: Session[];
  parentId: string;
  at: { x: number; y: number };
  pose: (s: Session) => { mood: Mood; working: boolean };
  news: (s: Session) => boolean;
  privacy: boolean;
  /** The selected session, marked in the list. */
  selected?: string | null;
  className?: string;
  onOpen: (id: string) => void;
  /** Hide one helper from the list (never one that needs the person). */
  canVeil?: (s: Session) => boolean;
  onVeil?: (s: Session) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const leaving = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    // Esc closes only the list: it must not also fold the dock or clear the selection.
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    // Clicks on a dock's see-through area go to the app behind it, so leaving also closes.
    const blur = () => setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
      window.removeEventListener('blur', blur);
      clearTimeout(leaving.current);
    };
  }, [open]);
  const calling = (s: Session) => s.status === 'call' || s.status === 'error';
  const lead = stackLead(members, (s) => pose(s).working);
  const responded = (s: Session) => s.runtime?.phase === 'responded' && !pose(s).working;
  const anyCalling = members.some(calling);
  const anyNews = members.some(news);
  // Helpers often share a role (e.g. "explorer"): keep each one's own name next to it.
  const role = (s: Session) => (privacy ? '' : (s.relation?.role ?? ''));
  const name = (s: Session) => (privacy ? t.desk.helper.name : sessionName(s));
  const label = (s: Session) => (role(s) ? `${role(s)} · ${name(s)}` : name(s));
  const count = members.length;
  return (
    <div
      ref={box}
      className={`helper-stack ${open ? 'is-open' : ''}`}
      data-parent-id={parentId}
      style={{ transform: `translate(${at.x}px, ${at.y}px)` }}
      // A short grace period lets the pointer cross the gap to the list.
      onMouseLeave={() => {
        if (open) leaving.current = setTimeout(() => setOpen(false), 700);
      }}
      onMouseEnter={() => clearTimeout(leaving.current)}
    >
      <button
        className={`helper-desk helper-stack-desk ${members.some((s) => pose(s).working) ? 'helper-working' : ''} ${className}`}
        data-session-id={lead.id}
        data-members={members.map((s) => s.id).join(' ')}
        data-furniture="helper-desk"
        data-solid
        aria-expanded={open}
        aria-label={t.desk.helper.stackLabel(count, anyCalling)}
        title={privacy ? undefined : members.map(label).join('\n')}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="helper-stack-back" aria-hidden="true">
          <i />
          <i />
        </span>
        <Sprite session={lead} provider={lead.provider} mood={pose(lead).mood} size={44} />
        <Furniture kind="helper" />
        <em className="helper-stack-count">×{count}</em>
        {anyCalling && <span className="helper-stack-bang">!</span>}
        <b>{t.desk.helper.stackCount(count)}</b>
        {anyNews && <i className="helper-news" />}
      </button>
      {open && (
        <ul className="helper-stack-list" data-solid aria-label={t.desk.helper.stackList}>
          {members.map((s) => {
            return (
              <li key={s.id}>
                <button
                  className="helper-stack-open"
                  data-session-id={s.id}
                  aria-current={s.id === selected || undefined}
                  onClick={() => {
                    setOpen(false);
                    onOpen(s.id);
                  }}
                >
                  <Sprite session={s} provider={s.provider} mood={pose(s).mood} size={22} />
                  <span className="helper-stack-name" title={privacy ? undefined : label(s)}>
                    {role(s) && <small>{role(s)}</small>}
                    {name(s)}
                  </span>
                  <i style={{ background: MOODS[s.status].color }} title={MOODS[s.status].label} />
                  {responded(s) && (
                    <b className="helper-stack-done" title={t.desk.helper.responded}>
                      ✓
                    </b>
                  )}
                  {news(s) && <em className="helper-news" />}
                </button>
                {onVeil && canVeil(s) && (
                  <button
                    className="helper-stack-veil"
                    aria-label={t.desk.veil.label(label(s))}
                    title={t.desk.veil.hint}
                    onClick={() => onVeil(s)}
                  >
                    <EyeOff size={11} strokeWidth={2.4} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
