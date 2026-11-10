import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Building2,
  Check,
  Expand,
  Flag,
  Minimize2,
  PawPrint,
  Rows3,
  Settings,
  Users,
} from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { isPageHidden, onPageVisibility } from '../lib/visibility';
import { DOCK_RECLAIM } from '../lib/useDockPill';
import { dockViewChecked, type DockLook, type DockViewChoice } from '../shared/dock-look';
import type { DockMode } from '../shared/types';

export type DockViewPick = DockViewChoice | 'main' | 'settings';
/** What the dock hands its pill and its pet for the 보기 menu. */
export interface DockViewControls {
  look: DockLook;
  onPick: (choice: DockViewPick) => void;
  /** Whether there is a settings window to open (the desktop app only). */
  settings: boolean;
  /**
   * Opens the list of colleagues (lounge and archive included) as its own window. Only when
   * given does the menu offer it, above the big office.
   */
  onRoster?: () => void;
  /**
   * Room for the menu: the desktop dock window grows upward while it is open (the pet's and a
   * tiny strip's window are too short for it). Resolves once the window has grown.
   */
  room?: (on: boolean) => Promise<void>;
}

/** Gap between the button and the menu, and the menu's least distance to the window's edges. */
const GAP = 6;
const MARGIN = 6;

type Place = { side: 'above' | 'below'; style: CSSProperties };

/**
 * The dock's one 보기 (view) button: a menu above it (below only when there is no room) with
 * the three looks, the tiny toggle and the big office / settings. It only draws: the dock
 * decides what a choice does. Without `controls` (the settings preview) it is a picture.
 */
export function DockViewMenu({
  controls,
  label = true,
  size = 14,
}: {
  controls?: DockViewControls;
  /** Show the word next to the icon (the pill); the pet's narrow column shows the icon only. */
  label?: boolean;
  size?: number;
}) {
  const { t } = useI18n();
  const v = t.dock.view;
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const latest = useRef(controls);
  latest.current = controls;
  // Each opening's room request; one closed meanwhile never shows when its room arrives.
  const opening = useRef(0);
  const holding = useRef(false);
  const release = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    void latest.current?.room?.(false);
  }, []);
  const close = useCallback(
    (refocus: boolean) => {
      opening.current++;
      // The room goes before whatever the choice does next (the IPC keeps this order), so a
      // new look never opens at the menu's height.
      release();
      setOpen(false);
      setReady(false);
      setPlace(null);
      if (refocus) button.current?.focus();
      // The menu's spot may sit under a still pointer: let the window judge clicks again once
      // it is gone, so the see-through area there doesn't keep swallowing them.
      requestAnimationFrame(() => window.dispatchEvent(new Event(DOCK_RECLAIM)));
    },
    [release],
  );
  useEffect(() => release, [release]);
  const show = async () => {
    const c = latest.current;
    if (!c) return;
    const token = ++opening.current;
    setOpen(true);
    if (c.room) {
      holding.current = true;
      await c.room(true).catch(() => {});
    }
    if (opening.current === token) setReady(true);
  };
  const measure = useCallback(() => {
    const b = button.current?.getBoundingClientRect();
    const m = menu.current;
    if (!b || !m) return;
    const height = m.scrollHeight;
    const width = m.offsetWidth;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const above = b.top - GAP - MARGIN;
    const below = vh - b.bottom - GAP - MARGIN;
    const up = height <= above || above >= below;
    const left = Math.round(
      Math.min(
        Math.max(MARGIN, b.left + b.width / 2 - width / 2),
        Math.max(MARGIN, vw - width - MARGIN),
      ),
    );
    // Measured from the window's bottom above the button: the window growing upward (its room
    // arriving, a re-seat) keeps it in place.
    setPlace(
      up
        ? {
            side: 'above',
            style: { left, bottom: Math.round(vh - b.top + GAP), maxHeight: Math.max(0, above) },
          }
        : {
            side: 'below',
            style: { left, top: Math.round(b.bottom + GAP), maxHeight: Math.max(0, below) },
          },
    );
  }, []);
  useLayoutEffect(() => {
    if (open && ready) measure();
  }, [open, ready, measure]);
  // Placed: focus the current look (or the first entry), as a menu does.
  const placed = !!place;
  useEffect(() => {
    if (!placed) return;
    const m = menu.current;
    const first =
      m?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      m?.querySelector<HTMLElement>('[role^="menuitem"]');
    first?.focus();
  }, [placed]);
  useEffect(() => {
    if (!open) return;
    // A press anywhere else in the window, the window losing focus or going away closes it.
    // (A click on the see-through desktop never reaches this window: Esc or 보기 again does.)
    const down = (e: PointerEvent) => {
      const at = e.target as Node | null;
      if (at && (menu.current?.contains(at) || button.current?.contains(at))) return;
      close(false);
    };
    const away = () => close(false);
    // A hidden Electron window may still say `document.hidden === false`: use the app's signal.
    const hidden = () => {
      if (isPageHidden()) close(false);
    };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('blur', away);
    window.addEventListener('resize', measure);
    const stopVisibility = onPageVisibility(hidden);
    return () => {
      stopVisibility();
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('blur', away);
      window.removeEventListener('resize', measure);
    };
  }, [open, close, measure]);
  const pick = (choice: DockViewPick) => {
    close(true);
    latest.current?.onPick(choice);
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
    else if (e.key === 'Escape') close(true);
    else if (e.key === 'Tab') {
      close(false);
      return;
    }
    // The dock's own keys (Esc folds to the pet, ← → page or pick a colleague) skip these.
    else if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
  };
  const look = controls?.look;
  const looks: { id: DockMode; icon: typeof PawPrint; name: string; hint: string }[] = [
    { id: 'pet', icon: PawPrint, name: v.pet, hint: v.petHint },
    { id: 'row', icon: Building2, name: v.row, hint: v.rowHint },
    { id: 'floor', icon: Flag, name: v.floor, hint: v.floorHint },
  ];
  const item = (
    choice: DockViewChoice,
    role: 'menuitemradio' | 'menuitemcheckbox',
    Icon: typeof PawPrint,
    name: string,
    hint: string,
  ) => {
    const checked = !!look && dockViewChecked(look, choice);
    return (
      <button
        key={choice}
        type="button"
        role={role}
        tabIndex={-1}
        aria-checked={checked}
        aria-labelledby={`${id}-${choice}`}
        aria-describedby={`${id}-${choice}-hint`}
        className={`dock-view-item ${checked ? 'is-checked' : ''}`}
        onClick={() => pick(choice)}
      >
        <span className="dock-view-icon" aria-hidden="true">
          <Icon size={15} />
        </span>
        <span className="dock-view-words">
          <b id={`${id}-${choice}`}>{name}</b>
          <small id={`${id}-${choice}-hint`}>{hint}</small>
        </span>
        <span className="dock-view-check" aria-hidden="true">
          {checked && <Check size={14} strokeWidth={2.6} />}
        </span>
      </button>
    );
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`icon-btn dock-view-button ${label ? 'has-label' : ''} ${open ? 'is-open' : ''}`}
        aria-label={v.label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-tip={v.tip}
        onClick={() => (open ? close(false) : void show())}
        onKeyDown={(e) => {
          if (open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
          e.preventDefault();
          void show();
        }}
      >
        <Rows3 size={size} />
        {label && <span>{v.button}</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={id}
            className="dock-view-menu"
            role="menu"
            aria-label={v.menu}
            data-solid
            data-side={place?.side}
            // Drawn hidden until placed (after the window's room arrives), then where it fits.
            style={place?.style ?? { visibility: 'hidden', left: 0, top: 0 }}
            onKeyDown={onMenuKey}
          >
            {looks.map((l) => item(l.id, 'menuitemradio', l.icon, l.name, l.hint))}
            {item('tiny', 'menuitemcheckbox', Minimize2, v.tiny, v.tinyHint)}
            <div className="dock-view-sep" role="separator" />
            {controls?.onRoster && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="dock-view-item is-plain"
                onClick={() => {
                  const open = latest.current?.onRoster;
                  close(true);
                  open?.();
                }}
              >
                <span className="dock-view-icon" aria-hidden="true">
                  <Users size={14} />
                </span>
                <span className="dock-view-words">
                  <b>{v.roster}</b>
                </span>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="dock-view-item is-plain"
              onClick={() => pick('main')}
            >
              <span className="dock-view-icon" aria-hidden="true">
                <Expand size={14} />
              </span>
              <span className="dock-view-words">
                <b>{v.main}</b>
              </span>
            </button>
            {controls?.settings && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="dock-view-item is-plain"
                onClick={() => pick('settings')}
              >
                <span className="dock-view-icon" aria-hidden="true">
                  <Settings size={14} />
                </span>
                <span className="dock-view-words">
                  <b>{v.settings}</b>
                </span>
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
