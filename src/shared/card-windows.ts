import { cardBounds, clampInto, type Point, type Rect } from './dock-geometry.js';

/** The preferred opening point is local presentation state, not a colleague pin. */
export function readCardPosition(raw: unknown): Point | null {
  const p = raw as { enabled?: unknown; x?: unknown; y?: unknown } | null;
  return p?.enabled === true &&
    typeof p.x === 'number' &&
    typeof p.y === 'number' &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    Math.abs(p.x) <= 100_000 &&
    Math.abs(p.y) <= 100_000
    ? { x: Math.round(p.x), y: Math.round(p.y) }
    : null;
}

export function popupBounds(
  anchor: Rect,
  area: Rect,
  size: { width: number; height: number },
  position: Point | null,
  occupied: Rect[] = [],
): Rect {
  const base = position
    ? clampInto({ ...position, ...size }, area)
    : cardBounds(anchor, area, size);
  // Keep the existing pinned windows still and leave their headers reachable.
  for (let step = 0; step <= occupied.length + 1; step++) {
    for (const sign of [1, -1]) {
      const next = clampInto(
        { ...base, x: base.x + step * 40 * sign, y: base.y + step * 40 * sign },
        area,
      );
      if (!occupied.some((r) => Math.abs(r.x - next.x) < 24 && Math.abs(r.y - next.y) < 24))
        return next;
    }
  }
  return base;
}

/**
 * A card window's pin, cycled by its one pin button: `off` is the replaceable preview (it closes
 * once focus leaves), `pinned` keeps it open as an ordinary window other windows may cover, and
 * `top` keeps it open and always on top.
 */
export type CardPin = 'off' | 'pinned' | 'top';

/** The pin button's fixed cycle: off → pinned → on top → off. */
export function nextCardPin(pin: CardPin): CardPin {
  return pin === 'off' ? 'pinned' : pin === 'pinned' ? 'top' : 'off';
}

/** The card IPC action that puts a card window in `pin`. */
export function cardPinAction(pin: CardPin): 'pin-off' | 'pin-on' | 'pin-top' {
  return pin === 'off' ? 'pin-off' : pin === 'pinned' ? 'pin-on' : 'pin-top';
}

/**
 * Whether a card window floats over other apps: the preview does (it goes away as soon as they
 * take focus) and so does a card pinned on top. A plain pinned card is an ordinary window.
 */
export function cardFloats(pin: CardPin) {
  return pin !== 'pinned';
}

/** A card's pin from its window state; a state without one is read from `pinned`. */
export function readCardPin(state: { pin?: unknown; pinned?: unknown }): CardPin {
  if (state.pin === 'off' || state.pin === 'pinned' || state.pin === 'top') return state.pin;
  return state.pinned === true ? 'pinned' : 'off';
}
