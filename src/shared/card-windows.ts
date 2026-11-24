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
 * A card window's pin. The pin button cycles the first three: `off` is the replaceable preview (it
 * closes once focus leaves), `pinned` keeps it open as an ordinary window other windows may cover,
 * and `top` keeps it open and always on top. `window` is the card taken out into an app window of
 * its own (its own button, 창으로 띄우기): kept open like `pinned`, and a real window of the system
 * besides — titled with the colleague's name, in Mission Control and ⌘` window cycling, staying on
 * the desktop (Space) it was opened on and moved to another like any app window.
 */
export type CardPin = 'off' | 'pinned' | 'top' | 'window';

/** The card IPC actions that put a card window in each pin (`cardPinAction`, `cardPinOfAction`). */
const PIN_ACTIONS = {
  off: 'pin-off',
  pinned: 'pin-on',
  top: 'pin-top',
  window: 'pin-window',
} as const satisfies Record<CardPin, string>;
export type CardPinAction = (typeof PIN_ACTIONS)[CardPin];

/**
 * The pin button's fixed cycle: off → pinned → on top → off. A card in its own window shows no pin
 * button; were it asked, it goes back in as a pinned card (`cardWindowToggle`).
 */
export function nextCardPin(pin: CardPin): CardPin {
  return pin === 'off' ? 'pinned' : pin === 'pinned' ? 'top' : pin === 'top' ? 'off' : 'pinned';
}

/**
 * The 창으로 띄우기 button: a card goes out into its own window, and one in its own window comes
 * back in as a pinned card (kept open where it was, not the preview that closes on the next click
 * elsewhere).
 */
export function cardWindowToggle(pin: CardPin): CardPin {
  return pin === 'window' ? 'pinned' : 'window';
}

/**
 * Whether a card in `pin` is an app window of its own rather than a card panel. macOS fixes a
 * panel (`type: 'panel'`) when it is made, so a card crossing this line moves to a new window.
 */
export function cardOwnWindow(pin: CardPin) {
  return pin === 'window';
}

/** Another window of the app, as `cardActivatesApp` weighs it. */
export interface OtherAppWindow {
  visible: boolean;
  minimized: boolean;
  /** Shown on every Space (`isVisibleOnAllWorkspaces`): the desk panel, a floating card. */
  allSpaces: boolean;
}

/**
 * macOS: whether bringing a card forward also activates the whole app (`app.focus({ steal })`).
 * A card in its own window always does: an ordinary app window takes the keys only while its app
 * is active. A card panel (`type: 'panel'`, non-activating) made key while another app is active
 * only blinks its cursor: the keys (and Korean composition) still go to that app. So a panel
 * activates the app too, unless that could move the screen: activating shows the Space of the
 * app's other windows (the big office's), so only when every other window shown is on every Space
 * or none is shown (the desk panel alone, the big office hidden). Otherwise the panel stays as it
 * is and takes the keys once pressed.
 */
export function cardActivatesApp(pin: CardPin, others: readonly OtherAppWindow[]) {
  if (cardOwnWindow(pin)) return true;
  return others.every((w) => !w.visible || w.minimized || w.allSpaces);
}

/**
 * A card moved to a new window across `cardOwnWindow`: what becomes of its old window once the new
 * one shows. While the new one loads the old window is out of the preview's reuse (another
 * colleague opened meanwhile gets a preview of its own), so it still shows the colleague that
 * moved unless the person took it elsewhere from inside it: then it stays. An ordinary card left
 * behind is the preview again when no other preview opened meanwhile (kept for reuse); otherwise
 * it is let go for good.
 */
export function cardLeftBehind(
  old: { pinned: boolean; id: string | null },
  moved: string,
  previewOpen: boolean,
) {
  return { close: old.id === moved, preview: !old.pinned && !previewOpen };
}

/** The card IPC action that puts a card window in `pin`. */
export function cardPinAction(pin: CardPin): CardPinAction {
  return PIN_ACTIONS[pin];
}

/** The pin a card IPC action asks for, or null when it is not a pin action. */
export function cardPinOfAction(action: unknown): CardPin | null {
  for (const pin of Object.keys(PIN_ACTIONS) as CardPin[])
    if (PIN_ACTIONS[pin] === action) return pin;
  return null;
}

/**
 * How a card shows the colleague it just handed bubbles to (#377). The replaceable preview turns
 * to that colleague (`select`); a kept card — pinned, on top, or in its own window — stays on the
 * conversation the person kept there, and the colleague comes forward beside it (`reveal`: its
 * own kept card, else the preview).
 */
export function cardHandAction(pin: CardPin): 'select' | 'reveal' {
  return pin === 'off' ? 'select' : 'reveal';
}

/**
 * Whether a card window floats over other apps: the preview does (it goes away as soon as they
 * take focus) and so does a card pinned on top. A plain pinned card and a card in its own window
 * are ordinary windows.
 */
export function cardFloats(pin: CardPin) {
  return pin === 'off' || pin === 'top';
}

const PINS: readonly unknown[] = Object.keys(PIN_ACTIONS);

/** A card's pin from its window state; a state without one is read from `pinned`. */
export function readCardPin(state: { pin?: unknown; pinned?: unknown }): CardPin {
  if (PINS.includes(state.pin)) return state.pin as CardPin;
  return state.pinned === true ? 'pinned' : 'off';
}

/**
 * A pinned card to bring back when the app starts again: whose, how pinned (a card in its own
 * window too), and where. Which desktop (Space) it was on is not brought back: Electron cannot put
 * a window on a given Space, so it opens on the current one.
 */
export interface PinnedCard {
  /** Whose card only: a bubble's or bookmark's one-time navigation is not brought back. */
  target: { id: string };
  pin: Exclude<CardPin, 'off'>;
  bounds: Rect;
}
/** At most this many cards come back (more would bury the screen after a restart). */
export const PINNED_CARDS_MAX = 8;

const finite = (n: unknown, limit = 100_000): n is number =>
  typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= limit;

/**
 * Read `pinned-cards.json`: anything malformed is dropped, never trusted. Files written before
 * cards had their own window read the same (still `v: 1`); an older app reading a newer file drops
 * only the cards in their own window.
 */
export function readPinnedCards(raw: unknown): PinnedCard[] {
  const file = raw as { v?: unknown; cards?: unknown } | null;
  if (file?.v !== 1 || !Array.isArray(file.cards)) return [];
  const cards: PinnedCard[] = [];
  for (const c of file.cards as Record<string, any>[]) {
    const id = c?.target?.id;
    const b = c?.bounds;
    if (
      typeof id !== 'string' ||
      !id.length ||
      id.length > 400 ||
      (c.pin !== 'pinned' && c.pin !== 'top' && c.pin !== 'window') ||
      !b ||
      !finite(b.x) ||
      !finite(b.y) ||
      !finite(b.width, 10_000) ||
      !finite(b.height, 10_000) ||
      b.width <= 0 ||
      b.height <= 0 ||
      cards.some((k) => k.target.id === id)
    )
      continue;
    cards.push({
      target: { id },
      pin: c.pin,
      bounds: {
        x: Math.round(b.x),
        y: Math.round(b.y),
        width: Math.round(b.width),
        height: Math.round(b.height),
      },
    });
    if (cards.length >= PINNED_CARDS_MAX) break;
  }
  return cards;
}
