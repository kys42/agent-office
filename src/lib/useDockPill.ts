import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { PILL_HOME, pillLeft, readPillSpot } from '../shared/dock-geometry';
import type { DockPillVisibility } from '../shared/types';
import { resetDue } from '../shared/view-prefs';

type Point = { x: number; y: number };
type Gesture = {
  id: number;
  element: HTMLElement;
  origin: number;
  start: number;
  point: Point;
  moved: boolean;
};

/** One spot for the row, the floor and tiny: the pill is the same dock in every look. */
export const PILL_STORAGE_KEY = 'office:dock-pill:v1';
/** A click that wobbles a little is still a click, not a move. */
const DRAG_SLOP = 4;
/** `hover` visibility: how close (px) the pointer must come to the hidden pill to bring it up. */
export const PILL_REACH = 24;
/** `hover` visibility: the window's bottom strip (px) that brings the pill up from anywhere. */
export const PILL_EDGE_STRIP = 10;

/**
 * The dock pill floats over the bottom of the desks, slides left and right, and remembers where
 * it was left (its centre as a fraction of the width, so a different screen keeps the idea) —
 * so the person can park it in an empty spot. Until then it sits at home (the right end).
 * Like the zone handles, a drag holds the pointer and, once it really moves, tells the dock
 * (`onArrange`) so the window keeps taking the mouse even when the pointer leaves the pill.
 *
 * `visibility` is the person's choice (#228): `always` solid, `subdued` faint until hovered (CSS
 * :hover), or `hover` — hidden until the pointer comes near. Hidden must also mean click-through,
 * so then the pill drops `[data-solid]` and `pointer-events`; but the desktop dock window only
 * takes the mouse over `[data-solid]` things (setIgnoreMouseEvents with `forward`), so CSS :hover
 * on the hidden pill would never fire there. Mouse *moves* are still forwarded to the page,
 * though, so `revealed` comes from the forwarded pointer's distance to the pill's box (or the
 * window's bottom strip, like an auto-hiding Dock) instead. Keyboard focus (:focus-visible, CSS)
 * and a drag keep it up too.
 *
 * `resetAt` (the `dockPillResetAt` preference) sends a spot saved before it back home: the reset
 * button lives in the settings window, another renderer than this dock.
 */
export function useDockPill({
  root,
  pill,
  onArrange,
  onSaveFailed,
  visibility = 'subdued',
  resetAt = null,
}: {
  root: RefObject<HTMLElement | null>;
  pill: RefObject<HTMLElement | null>;
  onArrange?: (active: boolean, point?: Point) => void;
  onSaveFailed: () => void;
  visibility?: DockPillVisibility;
  resetAt?: number | null;
}) {
  // When the saved spot was chosen (0: before #228 or never), so a later reset wins.
  const savedAt = useRef(0);
  const [spot, setSpot] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(PILL_STORAGE_KEY) ?? 'null');
      savedAt.current = typeof raw?.at === 'number' ? raw.at : 0;
      return readPillSpot(raw);
    } catch {
      return PILL_HOME;
    }
  });
  const [size, setSize] = useState({ width: 0, pill: 0 });
  const [moving, setMoving] = useState<number | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const latest = useRef({ spot, size, onArrange, onSaveFailed });
  latest.current = { spot, size, onArrange, onSaveFailed };

  // The pill's width changes with its contents (a hidden-colleague chip, tiny); keep it whole.
  useLayoutEffect(() => {
    const box = root.current,
      el = pill.current;
    if (!box || !el) return;
    const measure = () => setSize({ width: box.clientWidth, pill: el.offsetWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shown = moving ?? spot;
  const left = pillLeft(shown, size.width, size.pill);
  // What the person sees is what is saved: a spot pushed past an edge stays at that edge.
  const effective = (s: number) => {
    const { width, pill: w } = latest.current.size;
    return width > 0 ? (pillLeft(s, width, w) + w / 2) / width : s;
  };
  const save = (next: number | null) => {
    setSpot(next ?? PILL_HOME);
    try {
      if (next === null) localStorage.removeItem(PILL_STORAGE_KEY);
      else {
        savedAt.current = Date.now();
        localStorage.setItem(
          PILL_STORAGE_KEY,
          JSON.stringify({ v: 1, x: next, at: savedAt.current }),
        );
      }
    } catch {
      latest.current.onSaveFailed();
    }
  };
  const wanted = (g: Gesture) => {
    const width = latest.current.size.width || window.innerWidth;
    return Math.min(1, Math.max(0, g.start + (g.point.x - g.origin) / width));
  };
  const finish = (keep: boolean, point?: Point) => {
    const g = gesture.current;
    if (!g) return;
    if (point) g.point = point;
    gesture.current = null;
    if (keep && g.moved) save(effective(wanted(g)));
    setMoving(null);
    if (g.element.hasPointerCapture(g.id)) g.element.releasePointerCapture(g.id);
    // Only a real drag claimed the window; a plain press leaves it as the hover set it.
    if (g.moved) latest.current.onArrange?.(false, g.point);
  };
  // Leaving the window or Esc puts the pill back where the drag began.
  useEffect(() => {
    const blur = () => finish(false);
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && gesture.current) {
        e.preventDefault();
        finish(false);
      }
    };
    window.addEventListener('blur', blur);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('blur', blur);
      window.removeEventListener('keydown', key, true);
      finish(false);
    };
  }, []);

  // 'pill 위치 초기화' in settings: a stamp newer than the saved spot sends the pill home.
  useEffect(() => {
    if (!resetDue(resetAt, savedAt.current)) return;
    savedAt.current = resetAt!;
    finish(false);
    save(null);
  }, [resetAt]);

  // `hover`: up while the (forwarded) pointer is near the pill or on the bottom strip.
  const [near, setNear] = useState(false);
  useEffect(() => {
    setNear(false);
    if (visibility !== 'hover') return;
    const move = (e: globalThis.MouseEvent) => {
      const box = pill.current?.getBoundingClientRect();
      const over =
        !!box &&
        box.width > 0 &&
        e.clientX >= box.left - PILL_REACH &&
        e.clientX <= box.right + PILL_REACH &&
        e.clientY >= box.top - PILL_REACH &&
        e.clientY <= box.bottom + PILL_REACH;
      setNear(over || window.innerHeight - e.clientY <= PILL_EDGE_STRIP);
    };
    const leave = () => setNear(false);
    window.addEventListener('mousemove', move, { passive: true });
    document.documentElement.addEventListener('mouseleave', leave);
    return () => {
      window.removeEventListener('mousemove', move);
      document.documentElement.removeEventListener('mouseleave', leave);
    };
  }, [visibility]);

  /** Buttons keep their clicks; the pill's body and its grip carry it. */
  const grabbable = (e: { target: EventTarget }) =>
    !(e.target instanceof Element) ||
    !e.target.closest('button, a, input') ||
    !!e.target.closest('[data-pill-grip]');
  const handlers = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || !e.isPrimary || gesture.current || !grabbable(e)) return;
      e.preventDefault();
      // preventDefault keeps the press from focusing anything: focus the grip like a zone
      // handle, so ← → afterwards move the pill instead of paging the desks.
      if (e.target instanceof Element)
        e.target.closest<HTMLElement>('[data-pill-grip]')?.focus({ preventScroll: true });
      const start = effective(latest.current.spot);
      gesture.current = {
        id: e.pointerId,
        element: e.currentTarget,
        origin: e.clientX,
        start,
        point: { x: e.clientX, y: e.clientY },
        moved: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (!g || g.id !== e.pointerId) return;
      g.point = { x: e.clientX, y: e.clientY };
      if (!g.moved) {
        if (Math.abs(g.point.x - g.origin) < DRAG_SLOP) return;
        g.moved = true;
        latest.current.onArrange?.(true);
      }
      setMoving(wanted(g));
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      if (gesture.current?.id === e.pointerId) finish(true, { x: e.clientX, y: e.clientY });
    },
    onPointerCancel: (e: PointerEvent<HTMLElement>) => {
      if (gesture.current?.id === e.pointerId) finish(false);
    },
    onLostPointerCapture: (e: PointerEvent<HTMLElement>) => {
      if (gesture.current?.id === e.pointerId) finish(false);
    },
    // Double-click the body or grip: back home (the right end).
    onDoubleClick: (e: MouseEvent<HTMLElement>) => {
      if (!grabbable(e)) return;
      finish(false);
      save(null);
    },
  };
  /** The grip moves the pill from the keyboard too (← →, Shift for big steps, Home/End). */
  const onGripKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (
      !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) ||
      gesture.current ||
      e.altKey ||
      e.metaKey ||
      e.ctrlKey
    )
      return;
    // Handled here, so the row does not also page its desks.
    e.preventDefault();
    const step = e.shiftKey ? 0.1 : 0.02;
    const from = effective(latest.current.spot);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? 1
          : Math.min(1, Math.max(0, from + (e.key === 'ArrowLeft' ? -step : step)));
    save(effective(next));
  };
  const dragging = moving !== null;
  return {
    left,
    dragging,
    handlers,
    onGripKeyDown,
    /** `hover` visibility: the pill hides (and lets clicks through) unless `revealed`. */
    autoHide: visibility === 'hover',
    revealed: visibility !== 'hover' || near || dragging,
  };
}
