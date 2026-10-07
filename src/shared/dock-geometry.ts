/** Window geometry for the desk pet and the desk row. Pure so Electron and tests share it. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type Point = Pick<Rect, 'x' | 'y'>;

/** The pet window leaves room above the pet for a speech bubble (transparent, click-through). */
export const PET_SIZE = { width: 300, height: 350 };
/**
 * The row draws the office's own 164×238 stations at a fixed scale: more colleagues never
 * shrink the desks, the row scrolls (arrows / trackpad) instead.
 */
export const ROW_SCALE = 1;
/** Station-space height of the row scene (tall-bubble headroom + station + zone label). */
export const ROW_SCENE_HEIGHT = 376;
/** A see-through band above the scene for the row's tools, so they never cover a bubble. */
export const ROW_TOOLS_BAND = 44;
export const ROW_HEIGHT = Math.ceil(ROW_SCENE_HEIGHT * ROW_SCALE) + ROW_TOOLS_BAND;
/**
 * Floor version: no zone rugs or name cards under the desks, so the scene ends where the desk
 * legs meet the work area's bottom edge (FLOOR_TOP + 188) plus their contact shadow.
 */
export const FLOOR_SCENE_HEIGHT = 296;
export const FLOOR_HEIGHT = Math.ceil(FLOOR_SCENE_HEIGHT * ROW_SCALE) + ROW_TOOLS_BAND;

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

/** Where the pet stands: the bottom-centre of its window, stable when the window resizes. */
export const petFeet = (b: Rect): Point => ({
  x: Math.round(b.x + b.width / 2),
  y: b.y + b.height,
});

/** The window around a saved standing spot, or the bottom-right corner the first time. */
export function petBounds(feet: Point | null | undefined, area: Rect, size = PET_SIZE): Rect {
  const at = feet ?? {
    x: area.x + area.width - size.width / 2 - 32,
    y: area.y + area.height - 24,
  };
  return clampInto({ x: at.x - size.width / 2, y: at.y - size.height, ...size }, area);
}

/**
 * Read `desk-pet.json`: v2 stores the standing spot; the first format stored the top-left
 * of the original 132×148 window, converted here so upgrades keep the pet in place.
 */
export function readPetSpot(raw: unknown): Point | null {
  const p = raw as { v?: number; x?: unknown; y?: unknown } | null;
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return p.v === 2 ? { x: p.x, y: p.y } : { x: p.x + 66, y: p.y + 148 };
}

/** The dock card: the colleague card (same as the big office's right panel) in its own window. */
export const CARD_SIZE = { width: 420, height: 680 };
/** Shorter than this, the card would be cramped above a desk; it opens beside it instead. */
export const CARD_MIN_HEIGHT = 420;
const CARD_GAP = 10;
const CARD_MARGIN = 12;

/**
 * Where the dock card opens for a clicked desk or bubble (`anchor`, screen coordinates): above
 * it and centred — shortened to the room there — or beside it when there is not even room for
 * a short card above; always inside the work area.
 */
export function cardBounds(anchor: Rect, area: Rect, size = CARD_SIZE): Rect {
  const inside: Rect = {
    x: area.x + CARD_MARGIN,
    y: area.y + CARD_MARGIN,
    width: area.width - CARD_MARGIN * 2,
    height: area.height - CARD_MARGIN * 2,
  };
  const width = Math.min(size.width, inside.width);
  const room = anchor.y - CARD_GAP - inside.y;
  if (room >= Math.min(CARD_MIN_HEIGHT, size.height)) {
    const height = Math.min(size.height, room);
    return clampInto(
      {
        x: anchor.x + anchor.width / 2 - width / 2,
        y: anchor.y - CARD_GAP - height,
        width,
        height,
      },
      inside,
    );
  }
  const height = Math.min(size.height, inside.height);
  const right = anchor.x + anchor.width + CARD_GAP;
  const x = right + width <= inside.x + inside.width ? right : anchor.x - CARD_GAP - width;
  return clampInto({ x, y: anchor.y + anchor.height / 2 - height / 2, width, height }, inside);
}
