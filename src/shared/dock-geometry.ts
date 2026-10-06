/** Window geometry for the desk pet and the desk row. Pure so Electron and tests share it. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type Point = Pick<Rect, 'x' | 'y'>;

export const PET_SIZE = { width: 132, height: 148 };
export const ROW_HEIGHT = 196;
export const DESK_MIN = 88;
export const DESK_MAX = 132;

/** Keep a window fully inside a display's work area (shrinking it only if it cannot fit). */
export function clampInto(b: Rect, area: Rect): Rect {
  const width = Math.min(b.width, area.width);
  const height = Math.min(b.height, area.height);
  return {
    width,
    height,
    x: Math.round(Math.min(Math.max(b.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(b.y, area.y), area.y + area.height - height)),
  };
}

/** A full-width strip resting on the bottom of the work area (above the macOS Dock). */
export function rowBounds(area: Rect, height = ROW_HEIGHT): Rect {
  const h = Math.min(height, area.height);
  return { x: area.x, y: area.y + area.height - h, width: area.width, height: h };
}

/** The saved pet spot, or the bottom-right corner of the work area the first time. */
export function petBounds(saved: Point | null | undefined, area: Rect, size = PET_SIZE): Rect {
  const fallback = {
    x: area.x + area.width - size.width - 32,
    y: area.y + area.height - size.height - 24,
  };
  return clampInto({ ...(saved ?? fallback), ...size }, area);
}

/** Desks share the row evenly between a readable minimum and a natural maximum. */
export function deskWidth(count: number, available: number, min = DESK_MIN, max = DESK_MAX) {
  if (count <= 0 || available <= 0) return max;
  return Math.max(min, Math.min(max, Math.floor(available / count)));
}
