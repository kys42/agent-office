import { Eye, EyeOff } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { DOCK_RECLAIM } from '../lib/useDockPill';

/** 잠깐 숨기기: the dock's own toggle, held by DeskDock for this window (any look). */
export interface DockPeekControls {
  on: boolean;
  toggle: () => void;
  /** Shows everything again (someone newly needs the person, in the pet). */
  off: () => void;
}

/**
 * 👁 잠깐 숨기기 · 다시 보기: the desks, the pet, their bubbles and signs step aside (faded out
 * and click-through, so the desktop behind is usable), leaving the pill — its numbers still say
 * who waits. Not the app's privacy (화면 내용 숨기기), which hides names and content.
 */
export function DockPeek({
  peek,
  size = 14,
  blocked,
}: {
  peek?: DockPeekControls;
  size?: number;
  /** Why it cannot hide now (a reply being written would be lost with its desk): the tip says. */
  blocked?: string;
}) {
  const { t } = useI18n();
  const on = !!peek?.on;
  const stopped = !on && !!blocked;
  return (
    <button
      type="button"
      className={`icon-btn dock-peek-button ${on ? 'is-on' : ''}`}
      aria-label={on ? t.dock.peek.show : t.dock.peek.hide}
      // Not `disabled`: it still shows its tip on hover and keeps the focus where it is.
      aria-disabled={stopped || undefined}
      data-tip={on ? t.dock.peek.showTip : stopped ? blocked : t.dock.peek.hideTip}
      onClick={() => {
        if (stopped) return;
        peek?.toggle();
        // What was under a still pointer is gone (or back): let the window judge clicks again.
        requestAnimationFrame(() => window.dispatchEvent(new Event(DOCK_RECLAIM)));
      }}
    >
      {on ? <Eye size={size} /> : <EyeOff size={size} />}
    </button>
  );
}
