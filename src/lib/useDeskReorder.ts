import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { RowLayout } from '../shared/office-layout';
import { planDeskDrop } from '../shared/desk-order';
import { isRemoteId } from '../shared/federation';

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
  /** The edge marked, and the zone's local desks in the order a drop there sends. */
  target: { id: string; side: Side; ids: string[] } | null;
  /** Removes the listeners that live as long as the gesture. */
  detach: () => void;
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
  /**
   * The desk of the same zone under the pointer, which half of it, and what a drop there does.
   * A remote desk is no target, and neither is a place that leaves the order as it is.
   */
  const locate = (g: Gesture): Gesture['target'] => {
    const zone = zoneOf(g);
    const root = track.current;
    if (!zone || !root) return null;
    for (const st of zone.stations) {
      const el = root.querySelector(`[data-station-id="${CSS.escape(st.id)}"]`);
      const box = el?.getBoundingClientRect();
      if (!box || g.point.x < box.left || g.point.x >= box.right) continue;
      const bench = benchOf(zone);
      const plan = planDeskDrop(
        zone.stations.map(({ id }) => ({
          id,
          bench: bench.get(id) ?? id,
          remote: isRemoteId(id),
        })),
        g.id,
        st.id,
        g.point.x < box.left + box.width / 2 ? 'before' : 'after',
      );
      return plan && { ...plan.marker, ids: plan.ids };
    }
    return null;
  };
  const retarget = (g: Gesture, force = false) => {
    const target = locate(g);
    if (force || target?.id !== g.target?.id || target?.side !== g.target?.side) {
      g.target = target;
      setDrag({ id: g.id, target });
    }
  };
  const finish = (keep: boolean) => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    g.detach();
    setDrag(null);
    // Gone from the page (re-keyed, hidden, left the zone): nothing under the pointer to judge.
    const present = g.element.isConnected;
    if (present && g.element.hasPointerCapture(g.pointer))
      g.element.releasePointerCapture(g.pointer);
    if (!g.moved) return;
    // A cancelled drag's release must not open the card either (`consumeClick`).
    swallow.current = true;
    latest.current.onArrange?.(false, present ? g.point : undefined);
    if (keep && g.target) latest.current.onReorder(g.target.ids);
  };
  /** Listeners for the gesture's lifetime: they go when it ends, however it ends. */
  const attach = (g: Gesture) => {
    const root = track.current;
    // The row scrolling under a still pointer (wheel, trackpad) moves the desks beneath it.
    const scrolled = () => {
      if (gesture.current === g && g.moved) retarget(g);
    };
    // The desk's own element hears its release, but not once it has left the page; the window
    // still does then (React's handlers run first and end the gesture before this one).
    const released = (e: globalThis.PointerEvent) => {
      if (gesture.current !== g || e.pointerId !== g.pointer) return;
      if (e.type === 'pointerup' && g.element.isConnected) {
        g.point = { x: e.clientX, y: e.clientY };
        if (g.moved) g.target = locate(g);
        finish(true);
      } else finish(false);
    };
    root?.addEventListener('scroll', scrolled, { passive: true });
    window.addEventListener('pointerup', released);
    window.addEventListener('pointercancel', released);
    return () => {
      root?.removeEventListener('scroll', scrolled);
      window.removeEventListener('pointerup', released);
      window.removeEventListener('pointercancel', released);
    };
  };
  // A new floor plan without the dragged desk (it left the zone or the office, a persona's run
  // took over its desk) ends the drag: its element and its release may never come back.
  useEffect(() => {
    const g = gesture.current;
    if (g && !zoneOf(g)?.stations.some((st) => st.id === g.id)) finish(false);
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
            const g: Gesture = {
              pointer: e.pointerId,
              id,
              zone,
              element: e.currentTarget,
              start: point,
              point,
              moved: false,
              target: null,
              detach: () => {},
            };
            g.detach = attach(g);
            gesture.current = g;
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
            retarget(g, first);
          },
          onPointerUp: (e: PointerEvent<HTMLElement>) => {
            const g = gesture.current;
            if (g?.pointer !== e.pointerId) return;
            // Where it is let go decides, not where the pointer last moved (the row may have
            // scrolled under it since).
            g.point = { x: e.clientX, y: e.clientY };
            if (g.moved) g.target = locate(g);
            finish(true);
          },
          // Grab cursor and no touch scrolling of the row: the character is the drag handle.
          'data-desk-handle': '',
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
    /**
     * True (once) when the click is the end of a drag. A keyboard click (`detail` 0) never is,
     * even if a cancelled drag's release landed elsewhere and left the flag up.
     */
    consumeClick: (e?: { detail: number }) => {
      const was = swallow.current && e?.detail !== 0;
      swallow.current = false;
      return was;
    },
  };
}
