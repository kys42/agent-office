import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { menuItems, moveInMenu } from './CardMenu';

/**
 * A chat bubble's right-click menu (#377), where the pointer was: "select from here" and copy.
 * Like the card's menu, it focuses its first item, the arrows move, and Esc (never also closing
 * the card), a click elsewhere, scrolling by hand or leaving the window closes it.
 */
export function BubbleMenu({
  at,
  label,
  onClose,
  children,
}: {
  at: { x: number; y: number };
  label: string;
  onClose: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Kept inside the window: near the right or bottom edge it opens towards the pointer.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(at.x, window.innerWidth - width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(at.y, window.innerHeight - height - 4))}px`;
    menuItems(el)[0]?.focus();
  }, [at.x, at.y]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const gone = () => onClose();
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    // The person scrolling, not the chat following a working colleague's new messages.
    window.addEventListener('wheel', gone, { capture: true, passive: true });
    window.addEventListener('touchmove', gone, { capture: true, passive: true });
    window.addEventListener('blur', gone);
    window.addEventListener('resize', gone);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('wheel', gone, true);
      window.removeEventListener('touchmove', gone, true);
      window.removeEventListener('blur', gone);
      window.removeEventListener('resize', gone);
    };
  }, [onClose]);
  // On the page itself: the card's glass would otherwise hold a fixed menu inside it.
  return createPortal(
    <div
      ref={box}
      className="card-menu-list bubble-menu"
      role="menu"
      aria-label={label}
      style={{ left: at.x, top: at.y }}
      onKeyDown={(e) => {
        if (e.key === 'Tab') onClose();
        moveInMenu(e, menuItems(box.current));
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children(onClose)}
    </div>,
    document.body,
  );
}
