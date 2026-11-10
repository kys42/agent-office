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
