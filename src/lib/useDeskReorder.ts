import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { RowLayout } from '../shared/office-layout';
import { moveDesk } from '../shared/desk-order';

type Point = { x: number; y: number };
type Side = 'before' | 'after';
type Gesture = {
  pointer: number;
  id: string;
  zone: string;
  element: HTMLElement;
  start: Point;
  point: Point;
  moved: boolean;
  target: { id: string; side: Side } | null;
};
/** A press that travels less than this stays a click (opens the card). */
const THRESHOLD = 6;

/**
 * Drag a desk along the row to change its place within its own zone. The dock window takes
 * pointer events (no HTML drag and drop through the see-through panel), so this follows the
 * pointer itself and holds the window solid through `onArrange` while a drag lasts.
 */
export function useDeskReorder({
  layout,
  track,
  enabled,
  onArrange,
  onReorder,
}: {
  layout: RowLayout;
  track: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
  onArrange?: (active: boolean, point?: Point) => void;
  onReorder: (ids: string[]) => void;
}) {
  const [drag, setDrag] = useState<{ id: string; target: Gesture['target'] } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  // The click that ends a drag must not also open the card.
  const swallow = useRef(false);
  const latest = useRef({ layout, onArrange, onReorder });
  latest.current = { layout, onArrange, onReorder };
  const zoneOf = (g: Gesture) => latest.current.layout.zones.find((z) => z.key === g.zone);
  const benchOf = (zone: RowLayout['zones'][number]) =>
    new Map(zone.benches.flatMap((b) => b.members.map((id) => [id, b.key] as const)));
  /** The desk of the same zone under the pointer, and which half of it. */
  const locate = (g: Gesture): Gesture['target'] => {
    const zone = zoneOf(g);
    const root = track.current;
    if (!zone || !root) return null;
    const bench = benchOf(zone);
    for (const st of zone.stations) {
      const el = root.querySelector(`[data-station-id="${CSS.escape(st.id)}"]`);
      const box = el?.getBoundingClientRect();
      if (!box || g.point.x < box.left || g.point.x >= box.right) continue;
      // Its own bench is where it already is: nothing to show there.
      if (bench.get(st.id) === bench.get(g.id)) return null;
      return { id: st.id, side: g.point.x < box.left + box.width / 2 ? 'before' : 'after' };
    }
    return null;
  };
  const finish = (keep: boolean) => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    setDrag(null);
    if (g.element.hasPointerCapture(g.pointer)) g.element.releasePointerCapture(g.pointer);
    if (!g.moved) return;
    // A cancelled drag's release must not open the card either.
    swallow.current = true;
    latest.current.onArrange?.(false, g.point);
    const zone = zoneOf(g);
    if (!keep || !g.target || !zone) return;
    const bench = benchOf(zone);
    const ids = zone.stations.map((st) => st.id);
    const next = moveDesk(
      ids.map((id) => ({ id, bench: bench.get(id) ?? id })),
      g.id,
      g.target.id,
      g.target.side,
    );
    if (next.some((id, i) => id !== ids[i])) latest.current.onReorder(next);
  };
  // A new floor plan or switching it off ends the drag without saving stale geometry.
  useEffect(() => {
    if (gesture.current?.moved && !zoneOf(gesture.current)) finish(false);
  }, [layout]);
  useEffect(() => {
    if (!enabled) finish(false);
  }, [enabled]);
  useEffect(() => {
    const blur = () => finish(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && gesture.current?.moved) {
        // Before the row and the dock see it: Esc cancels the drag, nothing else.
        e.preventDefault();
        e.stopPropagation();
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
  const handle = (id: string, zone: string) =>
    enabled
      ? {
          onPointerDown: (e: PointerEvent<HTMLElement>) => {
            if (e.button !== 0 || !e.isPrimary || gesture.current) return;
            const point = { x: e.clientX, y: e.clientY };
            swallow.current = false;
            gesture.current = {
              pointer: e.pointerId,
              id,
              zone,
              element: e.currentTarget,
              start: point,
              point,
              moved: false,
              target: null,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          },
          onPointerMove: (e: PointerEvent<HTMLElement>) => {
            const g = gesture.current;
            if (!g || g.pointer !== e.pointerId) return;
            g.point = { x: e.clientX, y: e.clientY };
            const first = !g.moved;
            if (first) {
              if (Math.hypot(g.point.x - g.start.x, g.point.y - g.start.y) < THRESHOLD) return;
              g.moved = true;
              latest.current.onArrange?.(true);
            }
            const target = locate(g);
            if (first || target?.id !== g.target?.id || target?.side !== g.target?.side) {
              g.target = target;
              setDrag({ id: g.id, target });
            }
          },
          onPointerUp: (e: PointerEvent<HTMLElement>) => {
            if (gesture.current?.pointer === e.pointerId) finish(true);
          },
          onPointerCancel: (e: PointerEvent<HTMLElement>) => {
            if (gesture.current?.pointer === e.pointerId) finish(false);
          },
          onLostPointerCapture: (e: PointerEvent<HTMLElement>) => {
            if (gesture.current?.pointer === e.pointerId) finish(false);
          },
        }
      : {};
  return {
    handle,
    /** Station classes: the desk being dragged, and the edge a drop would put it at. */
    marker: (id: string) =>
      drag?.id === id
        ? 'is-desk-dragging'
        : drag?.target?.id === id
          ? `drop-${drag.target.side}`
          : '',
    /** True (once) when the click is the end of a drag. */
    consumeClick: () => {
      const was = swallow.current;
      swallow.current = false;
      return was;
    },
  };
}
