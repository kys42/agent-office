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
};

export function useRowPlacement({
  base,
  available,
  track,
  storageKey,
  onArrange,
  onSaveFailed,
}: {
  base: RowLayout;
  available: number;
  track: React.RefObject<HTMLDivElement | null>;
  storageKey: string;
  onArrange?: (active: boolean, point?: Point) => void;
  onSaveFailed: () => void;
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
    g.startX +
    (g.point.x - g.origin + (track.current?.scrollLeft ?? g.scroll) - g.scroll) / ROW_SCALE;
  const finish = (keep: boolean, point?: Point) => {
    const g = gesture.current;
    if (!g) return;
    if (point) g.point = point;
    gesture.current = null;
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
    if (g.element.hasPointerCapture(g.id)) g.element.releasePointerCapture(g.id);
    latest.current.onArrange?.(false, g.point);
  };
  // Resize, topology changes or mode closure end the gesture rather than saving stale geometry.
  useEffect(() => {
    finish(false);
  }, [base, available, storageKey]);
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
      const before = el.scrollLeft;
      if (step) el.scrollLeft += step;
      if (el.scrollLeft !== before) setMoving((m) => m && { ...m, x: wanted(g) });
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
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      setMoving({ key, x: zone.x, positions: snapshot });
      latest.current.onArrange?.(true);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (!g || g.id !== e.pointerId) return;
      g.point = { x: e.clientX, y: e.clientY };
      if (Math.abs(wanted(g) - g.startX) * ROW_SCALE >= 5) g.moved = true;
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
    reset,
    customized: Object.keys(positions).length > 0,
  };
}
