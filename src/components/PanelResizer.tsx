import { useEffect, useRef } from 'react';

/**
 * The edge between two columns, dragged to set one column's width (the left menu or the right
 * column). Arrow keys move it too; a double click (or Enter) goes back to the default width.
 * The caller keeps the width, fitted to the window, and decides where the edge sits.
 */
export function PanelResizer({
  edge,
  width,
  min,
  max,
  label,
  hint,
  controls,
  onWidth,
  onReset,
}: {
  /** Which column it sizes: 'left' grows to the right, 'right' grows to the left. */
  edge: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  label: string;
  /** How to use it, shown on hover (not read with the name every time). */
  hint: string;
  controls?: string;
  onWidth: (width: number) => void;
  onReset: () => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.min(Math.max(w, min), Math.max(min, max)));
  const stop = () => {
    start.current = null;
    document.body.classList.remove('is-resizing');
  };
  // Gone mid-drag (the column closed): the page must not stay in the dragging cursor.
  useEffect(() => stop, []);
  return (
    <div
      className={`panel-resizer is-${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={Math.max(min, max)}
      tabIndex={0}
      title={`${label} · ${hint}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width };
        document.body.classList.add('is-resizing');
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const moved = e.clientX - start.current.x;
        onWidth(clamp(start.current.width + (edge === 'left' ? moved : -moved)));
      }}
      onLostPointerCapture={stop}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        const grow = edge === 'left' ? 'ArrowRight' : 'ArrowLeft';
        const shrink = edge === 'left' ? 'ArrowLeft' : 'ArrowRight';
        if (e.key === grow) onWidth(clamp(width + step));
        else if (e.key === shrink) onWidth(clamp(width - step));
        else if (e.key === 'Home') onWidth(clamp(min));
        else if (e.key === 'End') onWidth(clamp(max));
        else if (e.key === 'Enter') onReset();
        else return;
        e.preventDefault();
      }}
    />
  );
}
