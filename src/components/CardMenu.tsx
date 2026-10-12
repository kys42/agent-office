import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

/**
 * The card's menu button: actions that used to take a whole row (hand-off, jump, reveal,
 * archive…) in a small menu. Opening it focuses the first item; arrows, Home and End move;
 * Esc, Tab, a click outside or choosing an item closes it (Esc never also closes the card), and
 * focus comes back to the button unless the chosen action takes it somewhere.
 */
export function CardMenu({
  label,
  children,
}: {
  label: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = () =>
    [...(box.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].filter(
      (b) => !b.disabled,
    );
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const to =
      e.key === 'ArrowDown'
        ? (at + 1) % list.length
        : e.key === 'ArrowUp'
          ? (at - 1 + list.length) % list.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? list.length - 1
              : -1;
    if (e.key === 'Tab') setOpen(false);
    if (to < 0 || !list.length) return;
    e.preventDefault();
    list[to].focus();
  };
  return (
    <div className="card-menu" ref={box}>
      <button
        ref={trigger}
        className="icon-btn"
        aria-label={label}
        data-tip={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="card-menu-list" role="menu" aria-label={label} onKeyDown={move}>
          {children(() => close())}
        </div>
      )}
    </div>
  );
}
