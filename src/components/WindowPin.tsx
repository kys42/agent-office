import { useEffect, useState } from 'react';
import { ArrowUp, ArrowUpToLine, Pin } from 'lucide-react';
import type { CardPin } from '../shared/card-windows';
import type { PopupOnTopAction } from '../shared/types';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';

/**
 * A card window's pin, drawn for its three states: an empty pin (the preview), a filled pin
 * (kept open, an ordinary window) and a filled pin with a small up arrow (kept open on top).
 */
export function CardPinIcon({ pin }: { pin: CardPin }) {
  if (pin === 'off') return <Pin size={15} />;
  if (pin === 'pinned') return <Pin size={15} fill="currentColor" />;
  return (
    <span className="pin-top-icon">
      <Pin size={15} fill="currentColor" />
      <ArrowUp className="pin-top-badge" size={9} strokeWidth={3} aria-hidden />
    </span>
  );
}

/**
 * A popup window's own on-top state (mini terminal, bookmark reader), read from the main process
 * once and on each change: its own toggle, or a floating opener floating it again.
 */
export function usePopupOnTop(control?: (action: PopupOnTopAction) => Promise<boolean>) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!control) return;
    let alive = true;
    const stop = api.onPopupOnTop?.((next) => alive && setOn(next));
    control('top')
      .then((next) => alive && setOn(next === true))
      .catch(() => {});
    return () => {
      alive = false;
      stop?.();
    };
  }, [control]);
  const toggle = async () => {
    if (!control || busy) return;
    setBusy(true);
    try {
      setOn((await control(on ? 'top-off' : 'top-on')) === true);
    } finally {
      setBusy(false);
    }
  };
  return { on, busy, toggle, available: !!control };
}

/** The two-state on-top toggle in a popup window's header. Says what it is and what a click does. */
export function OnTopButton({
  on,
  busy,
  onToggle,
  className,
  size = 14,
}: {
  on: boolean;
  busy: boolean;
  onToggle: () => void;
  className: string;
  size?: number;
}) {
  const { t } = useI18n();
  const o = t.common.onTop;
  const now = on ? o.states.on : o.states.off;
  const next = on ? o.states.off : o.states.on;
  return (
    <button
      type="button"
      className={`${className} on-top-toggle ${on ? 'is-on' : ''}`}
      aria-label={o.label(now, next)}
      aria-pressed={on}
      title={`${now} → ${next} · ${on ? o.hints.on : o.hints.off}`}
      disabled={busy}
      onClick={onToggle}
    >
      <ArrowUpToLine size={size} />
    </button>
  );
}
