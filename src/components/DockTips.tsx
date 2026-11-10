import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

const GAP = 6;
const MARGIN = 4;
const HOVER_DELAY = 350;

/**
 * Short labels for the dock's icon buttons (`data-tip`), drawn by the app: native tooltips do
 * not show reliably in the dock's transparent, mostly unfocused window. Above the button (the
 * pill sits on the window's bottom edge), below only when there is no room, always kept inside
 * the window. On hover after a moment, or right away on keyboard focus. Screen readers keep
 * the buttons' own labels; the tip is for the eyes only.
 */
export function DockTips() {
  const [tip, setTip] = useState<{ text: string; el: HTMLElement } | null>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;
    const find = (t: EventTarget | null) =>
      t instanceof Element ? t.closest<HTMLElement>('[data-tip]') : null;
    const hide = () => {
      clearTimeout(timer);
      current = null;
      setTip(null);
    };
    const show = (el: HTMLElement, delay: number) => {
      clearTimeout(timer);
      // An open menu says it all: no tip over it.
      if (el.getAttribute('aria-expanded') === 'true') return hide();
      if (el !== current) setTip(null);
      current = el;
      timer = setTimeout(() => {
        const text = el.dataset.tip;
        if (current === el && el.isConnected && text) setTip({ text, el });
      }, delay);
    };
    const over = (e: MouseEvent) => {
      const el = find(e.target);
      if (el === current) return;
      if (el) show(el, HOVER_DELAY);
      else hide();
    };
    const focusIn = (e: FocusEvent) => {
      const el = find(e.target);
      if (el && el.matches(':focus-visible')) show(el, 0);
    };
    const focusOut = (e: FocusEvent) => {
      if (find(e.target) === current) hide();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    document.addEventListener('mouseover', over);
    document.addEventListener('focusin', focusIn);
    document.addEventListener('focusout', focusOut);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', key, true);
    document.documentElement.addEventListener('mouseleave', hide);
    window.addEventListener('blur', hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mouseover', over);
      document.removeEventListener('focusin', focusIn);
      document.removeEventListener('focusout', focusOut);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', key, true);
      document.documentElement.removeEventListener('mouseleave', hide);
      window.removeEventListener('blur', hide);
    };
  }, []);
  useLayoutEffect(() => {
    setStyle(null);
  }, [tip]);
  useLayoutEffect(() => {
    if (!tip || style || !box.current) return;
    const r = tip.el.getBoundingClientRect();
    const w = box.current.offsetWidth;
    const h = box.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const above = r.top - GAP - h;
    const below = r.bottom + GAP;
    const top = above >= MARGIN || below + h > vh - MARGIN ? Math.max(MARGIN, above) : below;
    const left = Math.min(
      Math.max(MARGIN, r.left + r.width / 2 - w / 2),
      Math.max(MARGIN, vw - w - MARGIN),
    );
    setStyle({ left: Math.round(left), top: Math.round(top) });
  }, [tip, style]);
  if (!tip) return null;
  return createPortal(
    <div
      ref={box}
      className="dock-tip"
      role="tooltip"
      aria-hidden="true"
      style={style ?? { left: 0, top: 0, visibility: 'hidden' }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
