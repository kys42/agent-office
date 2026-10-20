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
import { PILL_CENTER, pillLeft, readPillSpot } from '../shared/dock-geometry';

type Point = { x: number; y: number };
type Gesture = { id: number; element: HTMLElement; origin: number; start: number; point: Point };

/** One spot for the row, the floor and tiny: the pill is the same dock in every look. */
export const PILL_STORAGE_KEY = 'office:dock-pill:v1';
/** A click that wobbles a little is still a click, not a move. */
const DRAG_SLOP = 4;

/**
 * The dock pill slides left and right along the band under the desks and remembers where it
 * was left (its centre as a fraction of the width, so a different screen keeps the idea).
 * Like the zone handles, a drag holds the pointer and tells the dock (`onArrange`) so the
 * window keeps taking the mouse even when the pointer leaves the pill.
 */
export function useDockPill({
  root,
  pill,
  onArrange,
  onSaveFailed,
}: {
  root: RefObject<HTMLElement | null>;
  pill: RefObject<HTMLElement | null>;
  onArrange?: (active: boolean, point?: Point) => void;
  onSaveFailed: () => void;
}) {
  const [spot, setSpot] = useState(() => {
    try {
      return readPillSpot(JSON.parse(localStorage.getItem(PILL_STORAGE_KEY) ?? 'null'));
    } catch {
      return PILL_CENTER;
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
    setSpot(next ?? PILL_CENTER);
    try {
      if (next === null) localStorage.removeItem(PILL_STORAGE_KEY);
      else localStorage.setItem(PILL_STORAGE_KEY, JSON.stringify({ v: 1, x: next }));
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
    const moved = Math.abs(g.point.x - g.origin) >= DRAG_SLOP;
    if (keep && moved) save(effective(wanted(g)));
    setMoving(null);
    if (g.element.hasPointerCapture(g.id)) g.element.releasePointerCapture(g.id);
    latest.current.onArrange?.(false, g.point);
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

  /** Buttons keep their clicks; the pill's body and its grip carry it. */
  const grabbable = (e: { target: EventTarget }) =>
    !(e.target instanceof Element) ||
    !e.target.closest('button, a, input') ||
    !!e.target.closest('[data-pill-grip]');
  const handlers = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || !e.isPrimary || gesture.current || !grabbable(e)) return;
      e.preventDefault();
      const start = effective(latest.current.spot);
      gesture.current = {
        id: e.pointerId,
        element: e.currentTarget,
        origin: e.clientX,
        start,
        point: { x: e.clientX, y: e.clientY },
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      latest.current.onArrange?.(true);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (!g || g.id !== e.pointerId) return;
      g.point = { x: e.clientX, y: e.clientY };
      if (Math.abs(g.point.x - g.origin) >= DRAG_SLOP) setMoving(wanted(g));
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
    // Double-click the body or grip: back to the middle.
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
  return { left, dragging: moving !== null, handlers, onGripKeyDown };
}
