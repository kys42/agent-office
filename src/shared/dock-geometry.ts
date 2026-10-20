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
/**
 * See-through room above the scene (where the tools sat before the pill), so a stacked answer
 * + request bubble fits: a bubble's bottom sits ROW_TOP + 58 = 162px below the scene's top,
 * which leaves it 206px to the window's top. The desks stand on the window's bottom edge; the
 * dock pill floats over the bottom of the scene instead of lifting it.
 */
export const ROW_TOP_ROOM = 44;
export const ROW_HEIGHT = Math.ceil(ROW_SCENE_HEIGHT * ROW_SCALE) + ROW_TOP_ROOM;
/**
 * Floor version: no zone rugs or name cards under the desks, so the scene ends where the desk
 * legs meet the work area's bottom edge (FLOOR_TOP + 188) plus their contact shadow.
 */
export const FLOOR_SCENE_HEIGHT = 296;
export const FLOOR_HEIGHT = Math.ceil(FLOOR_SCENE_HEIGHT * ROW_SCALE) + ROW_TOP_ROOM;

/**
 * Tiny (쪼꼬미) row and floor: the whole scene at about helper-desk size (68 of 164), with no
 * bubbles, flags, rugs or name cards — just the desks, their status and a contentless dot.
 */
export const TINY_SCALE = 68 / 164;
/**
 * Tiny drops the bubble headroom: stations sit this far above the scene's top (a negative
 * station row), so it starts just above the heads (pet at 62) with room for the dot.
 */
export const TINY_TOP = -36;
/** Desk legs meet the floor at 188 (DESK_FOOT), plus their contact shadow. */
export const TINY_FEET = 188 + 4;
/**
 * The tiny name tag sits over the desk's front (bench at 134, legs to 188): station-space top
 * and height of its band (about 14px on screen: a 9px name in a small see-through chip). The
 * desks keep standing on the window's bottom edge.
 */
export const TINY_NAME_TOP = 150;
export const TINY_NAME_ROOM = 34;
/**
 * Without rugs and name cards the office row ends at the desk legs like the floor, so both
 * tiny looks share one scene height (and one window height).
 */
export const TINY_SCENE_HEIGHT = TINY_TOP + TINY_FEET;
/**
 * See-through room above the tiny desks (the tiny pill floats over their feet). The desks keep
 * the full size's effects, shrunk with the scene, so this leaves room for the highest of them:
 * the arriving papers set off about 58 station units above a station (112 − 170, ≈ −94 in
 * scene space, 39px on screen) and the full-heat flames reach above the head. The extra room is
 * transparent and lets clicks through; the desks still stand on the window's bottom edge.
 */
export const TINY_TOP_ROOM = 44;
export const TINY_HEIGHT = Math.ceil(TINY_SCENE_HEIGHT * TINY_SCALE) + TINY_TOP_ROOM;
/** The dock window's height for the office row or the floor, normal or tiny. */
export const dockHeight = (floor: boolean, tiny: boolean) =>
  tiny ? TINY_HEIGHT : floor ? FLOOR_HEIGHT : ROW_HEIGHT;

/**
 * The dock pill's spot: its centre as a fraction of the window's width, so it keeps its place
 * on a wider or narrower screen. Anything unreadable is home.
 *
 * Home is the right end, where the tools sat before the pill. The pill floats over the desks'
 * feet, and the desks (with their zone signs along the bottom) are centred in the window, so a
 * centred pill would sit on a sign every time; the right end is usually empty. The person can
 * still park it anywhere, and every look (row, floor, tiny) shares that one saved spot.
 */
export const PILL_HOME = 1;
export function readPillSpot(raw: unknown): number {
  const p = raw as { v?: unknown; x?: unknown } | null;
  return p && typeof p === 'object' && p.v === 1 && typeof p.x === 'number' && Number.isFinite(p.x)
    ? Math.min(1, Math.max(0, p.x))
    : PILL_HOME;
}
/** Breathing room between the pill and the window's sides. */
export const PILL_MARGIN = 8;
/** The pill's left edge (px) for a centre fraction, kept whole inside the window. */
export function pillLeft(spot: number, width: number, pill: number, margin = PILL_MARGIN): number {
  const max = Math.max(margin, width - pill - margin);
  return Math.round(Math.min(max, Math.max(margin, spot * width - pill / 2)));
}

/** Read `dock.json` (`{ v: 1, tiny }`); anything else is the normal size. */
export function readDockPrefs(raw: unknown): { tiny: boolean } {
  const p = raw as { v?: unknown; tiny?: unknown } | null;
  return { tiny: !!p && typeof p === 'object' && p.v === 1 && p.tiny === true };
}

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
export const CARD_SIZE = { width: 480, height: 760 };
/** The smallest the person can resize the card to (it still holds a header, a chat and a box). */
export const CARD_MIN = { width: 380, height: 480 };
/** A remembered card size (`card-size.json`), or null when it is not a sane one. */
export function readCardSize(v: unknown): { width: number; height: number } | null {
  const p = v as { width?: unknown; height?: unknown } | null;
  const ok = (n: unknown, min: number) =>
    typeof n === 'number' && Number.isFinite(n) && n >= min && n <= 4000;
  return p && ok(p.width, CARD_MIN.width) && ok(p.height, CARD_MIN.height)
    ? { width: Math.round(p.width as number), height: Math.round(p.height as number) }
    : null;
}
/** Shorter than this, the card would be cramped above a desk; it opens beside it instead.
 * The window's own minimum: a shorter placement would be grown down over the desk. */
export const CARD_MIN_HEIGHT = 480;
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
