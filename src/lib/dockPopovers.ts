/**
 * The dock's popovers (the 보기 menu, the ＋ popover, a number's list) take turns: one open at
 * a time. Each says when it opens (with how to close it) and when it closes; opening one
 * closes the others, and a hover never opens one while another is up.
 *
 * Opening order for the window's room: a popover asks for its room first (the claim is taken
 * at once, `DeskDock · room`), then announces itself, so the one it closes gives its room back
 * without the window shrinking in between.
 */
const open = new Map<string, () => void>();

/**
 * Marks a button that opens a dock popover. A press on one is not "a press elsewhere" for the
 * open popover: the new one closes it as it opens (after claiming the room), so the window does
 * not shrink and grow again in between.
 */
export const POPOVER_TRIGGER = 'data-popover-trigger';
export const isPopoverTrigger = (at: EventTarget | null) =>
  at instanceof Element && !!at.closest(`[${POPOVER_TRIGGER}]`);

/** A pointer is pressed now (a focus moving on it lands before the press's click). */
let pressed = false;
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => (pressed = true), true);
  for (const end of ['pointerup', 'pointercancel'] as const)
    window.addEventListener(end, () => (pressed = false), true);
}
export const pointerPressed = () => pressed;

export const dockPopovers = {
  opened(id: string, close: () => void) {
    open.set(id, close);
    for (const [other, shut] of [...open]) if (other !== id) shut();
  },
  closed(id: string) {
    open.delete(id);
  },
  /** Another popover is open (a hover waits for it to close). */
  busy(id: string) {
    for (const other of open.keys()) if (other !== id) return true;
    return false;
  },
};
