/** Window geometry for the desk pet and the desk row. Pure so Electron and tests share it. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type Point = Pick<Rect, 'x' | 'y'>;

export const PET_SIZE = { width: 132, height: 148 };
/**
 * The row draws the office's own 164×238 stations at a fixed scale: more colleagues never
 * shrink the desks, the row scrolls (arrows / trackpad) instead.
 */
export const ROW_SCALE = 1;
/** Station-space height of the row scene (tall-bubble headroom + station + zone label). */
export const ROW_SCENE_HEIGHT = 328;
/** A see-through band above the scene for the row's tools, so they never cover a bubble. */
export const ROW_TOOLS_BAND = 44;
export const ROW_HEIGHT = Math.ceil(ROW_SCENE_HEIGHT * ROW_SCALE) + ROW_TOOLS_BAND;

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
