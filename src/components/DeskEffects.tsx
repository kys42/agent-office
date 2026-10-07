import { useEffect, useState, type CSSProperties } from 'react';
import { Mail } from 'lucide-react';
import { ARRIVAL_MS } from '../shared/speech';
import { FOCUS_LABELS, FOCUS_MINUTES, MAX_PAPERS, type FocusLevel } from '../shared/presentation';

/**
 * Decorative desk effects shared by every view (big office, office row, floor desks, pet).
 * They only draw what the core already decided (`focusLevel`, `deskPapers`, `arrival`), and
 * claim nothing about throughput. All motion stops under reduced motion / paused scenes.
 */

/** True until `until`, then re-renders once to drop the effect (the model clock is coarse). */
function useUntil(until: number) {
  const [, wake] = useState(0);
  const left = until - Date.now();
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => wake((n) => n + 1), left + 50);
    return () => clearTimeout(timer);
  }, [until]);
  return left > 0;
}

/**
 * How far into the arrival this view joined (a window shown or opened late): the CSS delays
 * subtract it, so a late view skips what already played instead of restarting the flight.
 */
function useAge(receivedAt: number) {
  const [age] = useState(() => Math.min(ARRIVAL_MS, Math.max(0, Date.now() - receivedAt)));
  return { '--age': `${age}ms` } as CSSProperties;
}

/** Heat behind and around the colleague, inside the pet button (level 1–3). */
export function FocusEffects({ level }: { level: FocusLevel }) {
  if (!level) return null;
  const flames = [3, 5, 7][level - 1];
  return (
    <span className={`focus-fx fx-level-${level}`} aria-hidden="true">
      <span className="fx-flames">
        {Array.from({ length: flames }, (_, i) => (
          <i key={i} />
        ))}
      </span>
      <span className="fx-sweat">
        <i />
        {level >= 2 && <i />}
        {level >= 3 && <i />}
      </span>
      {level >= 2 && (
        <span className="fx-steam">
          <i />
          <i />
          <i />
        </span>
      )}
      {level >= 3 && (
        <span className="fx-embers">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      )}
    </span>
  );
}

/** The "작업 중" tag over the desk; its words and colour follow the focus level. */
export function WorkingBeacon({ level }: { level: FocusLevel }) {
  return (
    <span className={`working-beacon beacon-level-${level}`}>
      <i />
      <i />
      <i /> {FOCUS_LABELS[level]}
      {level > 0 && <small>{FOCUS_MINUTES[level - 1]}분+</small>}
    </span>
  );
}

/** Papers piled beside the monitor; at full heat a few sheets flutter off the top. */
export function PaperPile({ count, level = 0 }: { count: number; level?: FocusLevel }) {
  if (count <= 0) return null;
  const sheets = Math.min(MAX_PAPERS, count);
  return (
    <span
      className={`paper-pile ${level >= 3 ? 'is-fluttering' : ''}`}
      data-papers={sheets}
      aria-hidden="true"
    >
      {Array.from({ length: sheets }, (_, i) => (
        <i key={i} style={{ bottom: i * 3 }} />
      ))}
      {level >= 3 && (
        <span className="pile-flutter">
          <i />
          <i />
        </span>
      )}
    </span>
  );
}

/**
 * A just-sent request landing on the desk: sheets fly in one after another onto the pile,
 * a puff where they land, and the envelope tag. Key it by the notice so a new one replays.
 */
export function ArrivalBurst({ receivedAt }: { receivedAt: number }) {
  const age = useAge(receivedAt);
  if (!useUntil(receivedAt + ARRIVAL_MS)) return null;
  return (
    <span className="arrival-burst" style={age}>
      <span className="arrival-sheets" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="arrival-puff" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="arrival-tag">
        <Mail size={13} />
        <b>일이 도착했어요!</b>
      </span>
    </span>
  );
}

/** The collapsed pet: sheets land beside it with a "새 요청" chip (the pet stays who it is). */
export function PetArrival({ receivedAt, count }: { receivedAt: number; count: number }) {
  const age = useAge(receivedAt);
  if (!useUntil(receivedAt + ARRIVAL_MS)) return null;
  return (
    <span className="pet-arrival" style={age}>
      <span className="arrival-sheets" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="pet-arrival-chip">
        <Mail size={11} />새 요청{count > 1 ? ` ${count}` : ''}
      </span>
    </span>
  );
}
