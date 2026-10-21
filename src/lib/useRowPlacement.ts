import { useEffect, useMemo, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';
import type { RowLayout } from '../shared/office-layout';
import {
  positionRow,
  readRowPositions,
  rememberRowPositions,
  type RowPositions,
} from '../shared/row-placement';
import { ROW_SCALE } from '../shared/dock-geometry';

type Point = { x: number; y: number };
type Gesture = {
  id: number;
  key: string;
  element: HTMLElement;
  origin: number;
  startX: number;
  scroll: number;
  point: Point;
  positions: RowPositions;
  moved: boolean;
  /**
   * A grab from a desk (tiny) waits for the pointer to travel before it becomes a drag, so a
   * plain click still opens the card. Until then nothing moves and the dock is not held.
   */
  armed: boolean;
  /** Started by `grab()` on a clickable desk, whose click must then be swallowed. */
  grabbed: boolean;
};

/** Screen px a desk grab travels before it moves the zone; a shorter press stays a click. */
const GRAB_THRESHOLD = 5;

export function useRowPlacement({
  base,
  available,
  track,
  storageKey,
  onArrange,
  onSaveFailed,
  scale = ROW_SCALE,
}: {
  base: RowLayout;
  available: number;
  track: React.RefObject<HTMLDivElement | null>;
  storageKey: string;
  onArrange?: (active: boolean, point?: Point) => void;
  onSaveFailed: () => void;
  /** The scene's current scale (screen px per station px). */
  scale?: number;
}) {
  const [positions, setPositions] = useState(() => {
    try {
      return readRowPositions(localStorage.getItem(storageKey));
    } catch {
      return {};
    }
  });
  const [moving, setMoving] = useState<{ key: string; x: number; positions: RowPositions } | null>(
    null,
  );
  const gesture = useRef<Gesture | null>(null);
  // A desk grab that moved: its release must not also open the card (`consumeClick`).
  const swallow = useRef(false);
  const layout = useMemo(
    () => positionRow(base, available, moving?.positions ?? positions, moving),
    [base, available, positions, moving],
  );
  const latest = useRef({ base, available, layout, positions, onArrange, onSaveFailed });
  latest.current = { base, available, layout, positions, onArrange, onSaveFailed };
  const save = (next: RowPositions) => {
    setPositions(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      latest.current.onSaveFailed();
    }
  };
  const wanted = (g: Gesture) =>
    g.startX + (g.point.x - g.origin + (track.current?.scrollLeft ?? g.scroll) - g.scroll) / scale;
  const finish = (keep: boolean, point?: Point) => {
    const g = gesture.current;
    if (!g) return;
    if (point) g.point = point;
    gesture.current = null;
    if (g.element.hasPointerCapture(g.id)) g.element.releasePointerCapture(g.id);
    if (!g.armed) return;
    // Only a desk grab's own click follows; a sign or flag drag leaves the next click alone.
    if (g.grabbed && g.moved) swallow.current = true;
    if (keep && g.moved) {
      const { base, available, positions } = latest.current;
      save(
        rememberRowPositions(
          positions,
          positionRow(base, available, g.positions, { key: g.key, x: wanted(g) }),
        ),
      );
    }
    setMoving(null);
    latest.current.onArrange?.(false, g.point);
  };
  // Resize, topology changes or mode closure end the gesture rather than saving stale geometry.
  useEffect(() => {
    finish(false);
  }, [base, available, storageKey]);
  useEffect(() => {
    const blur = () => finish(false);
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || !gesture.current) return;
      // A grab still waiting to become a drag is let go quietly: Esc keeps its usual meaning.
      if (!gesture.current.armed) return finish(false);
      e.preventDefault();
      finish(false);
    };
    // Any new press starts fresh: a swallowed click belongs to the release just before it.
    const press = () => {
      swallow.current = false;
    };
    window.addEventListener('blur', blur);
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', press, true);
    return () => {
      window.removeEventListener('blur', blur);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('pointerdown', press, true);
      finish(false);
    };
  }, []);
  // Hold near an edge to keep scrolling a crowded row, without shrinking the furniture.
  useEffect(() => {
    if (!moving) return;
    let frame = 0;
    const tick = () => {
      const g = gesture.current,
        el = track.current;
      if (!g || !el) return;
      const bounds = el.getBoundingClientRect();
      const step = g.moved
        ? g.point.x < bounds.left + 32
          ? -10
          : g.point.x > bounds.right - 32
            ? 10
            : 0
        : 0;
      if (step) el.scrollLeft += step;
      // The wheel, trackpad or a track scroll can move the lane too. Preview the same
      // coordinates finish() will save, rather than jumping when the pointer is released.
      const x = wanted(g);
      if (Math.abs(x - g.startX) * scale >= 5) g.moved = true;
      if (g.moved) setMoving((m) => (m && m.x !== x ? { ...m, x } : m));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [moving?.key]);
  const handle = (key: string) => ({
    'data-row-drag': true,
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || !e.isPrimary || gesture.current) return;
      const zone = latest.current.layout.zones.find((z) => z.key === key);
      if (!zone) return;
      e.preventDefault();
      e.currentTarget.focus({ preventScroll: true });
      const snapshot = rememberRowPositions(latest.current.positions, latest.current.layout);
      gesture.current = {
        id: e.pointerId,
        key,
        element: e.currentTarget,
        origin: e.clientX,
        startX: zone.x,
        scroll: track.current?.scrollLeft ?? 0,
        point: { x: e.clientX, y: e.clientY },
        positions: snapshot,
        moved: false,
        armed: true,
        grabbed: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      setMoving({ key, x: zone.x, positions: snapshot });
      latest.current.onArrange?.(true);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (!g || g.id !== e.pointerId) return;
      g.point = { x: e.clientX, y: e.clientY };
      if (Math.abs(wanted(g) - g.startX) * scale >= 5) g.moved = true;
      if (g.moved) setMoving((m) => m && { ...m, x: wanted(g) });
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
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (
        !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) ||
        gesture.current ||
        e.altKey ||
        e.metaKey ||
        e.ctrlKey
      )
        return;
      e.preventDefault();
      const { layout, base, available, positions } = latest.current;
      const zone = layout.zones.find((z) => z.key === key);
      if (!zone) return;
      const step = e.shiftKey ? 64 : 16;
      const x =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? layout.width - zone.width
            : zone.x + (e.key === 'ArrowLeft' ? -step : step);
      const snapshot = rememberRowPositions(positions, layout);
      save(rememberRowPositions(positions, positionRow(base, available, snapshot, { key, x })));
    },
  });
  /**
   * Pointer handlers that let any element (a tiny desk, its name) carry its zone: past a few
   * pixels the press becomes the same drag as the sign's, while a still press stays a click.
   * Pair with `consumeClick` in the element's click handler.
   */
  const grab = (key: string) => ({
    'data-zone-grab': '',
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || !e.isPrimary || gesture.current) return;
      const zone = latest.current.layout.zones.find((z) => z.key === key);
      if (!zone) return;
      swallow.current = false;
      gesture.current = {
        id: e.pointerId,
        key,
        element: e.currentTarget,
        origin: e.clientX,
        startX: zone.x,
        scroll: track.current?.scrollLeft ?? 0,
        point: { x: e.clientX, y: e.clientY },
        positions: rememberRowPositions(latest.current.positions, latest.current.layout),
        moved: false,
        armed: false,
        grabbed: true,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (!g || g.id !== e.pointerId) return;
      g.point = { x: e.clientX, y: e.clientY };
      if (!g.armed) {
        if (Math.abs(e.clientX - g.origin) < GRAB_THRESHOLD) return;
        g.armed = true;
        g.moved = true;
        setMoving({ key: g.key, x: wanted(g), positions: g.positions });
        latest.current.onArrange?.(true);
        return;
      }
      setMoving((m) => m && { ...m, x: wanted(g) });
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
  });
  const reset = () => {
    finish(false);
    setPositions({});
    try {
      localStorage.removeItem(storageKey);
    } catch {
      latest.current.onSaveFailed();
    }
  };
  return {
    layout,
    dragging: moving?.key,
    handle,
    grab,
    /**
     * True (once) when the click ends a desk grab that moved the zone (or was cancelled after
     * moving). A keyboard click (`detail` 0) never is.
     */
    consumeClick: (e?: { detail: number }) => {
      const was = swallow.current && e?.detail !== 0;
      swallow.current = false;
      return was;
    },
    reset,
    customized: Object.keys(positions).length > 0,
  };
}
