import { Eye, EyeOff } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { DOCK_RECLAIM } from '../lib/useDockPill';

/** 잠깐 숨기기: the dock's own toggle, held by DeskDock for this window (any look). */
export interface DockPeekControls {
  on: boolean;
  toggle: () => void;
}

/**
 * 👁 잠깐 숨기기 · 다시 보기: the desks, the pet, their bubbles and signs step aside (faded out
 * and click-through, so the desktop behind is usable), leaving the pill — its numbers still say
 * who waits. Not the app's privacy (화면 내용 숨기기), which hides names and content.
 */
export function DockPeek({ peek, size = 14 }: { peek?: DockPeekControls; size?: number }) {
  const { t } = useI18n();
  const on = !!peek?.on;
  return (
    <button
      type="button"
      className={`icon-btn dock-peek-button ${on ? 'is-on' : ''}`}
      aria-label={on ? t.dock.peek.show : t.dock.peek.hide}
      data-tip={on ? t.dock.peek.showTip : t.dock.peek.hideTip}
      onClick={() => {
        peek?.toggle();
        // What was under a still pointer is gone (or back): let the window judge clicks again.
        requestAnimationFrame(() => window.dispatchEvent(new Event(DOCK_RECLAIM)));
      }}
    >
      {on ? <Eye size={size} /> : <EyeOff size={size} />}
    </button>
  );
}
