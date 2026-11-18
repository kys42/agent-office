/**
 * Whether the pointer still rests on one of `els`, for a hover-opened dock popover about to
 * close after its grace.
 *
 * The dock window grows upward under a still pointer (its room): the page then re-judges hover
 * at the pointer's old spot in the page, which the growth moved off the button, and fires the
 * leave events of a pointer that never moved. Its spot on the screen did not change, so it is
 * judged here from the last real move's screen position, mapped into the grown window. The
 * page's own `:hover` still counts (a browser preview's window never moves).
 */
let last: { x: number; y: number } | null = null;
if (typeof window !== 'undefined')
  window.addEventListener(
    'mousemove',
    (e) => {
      last = { x: e.screenX, y: e.screenY };
    },
    { capture: true, passive: true },
  );

export function stillPointing(...els: (Element | null | undefined)[]): boolean {
  if (els.some((el) => el?.matches(':hover'))) return true;
  if (!last) return false;
  const at = document.elementFromPoint(last.x - window.screenX, last.y - window.screenY);
  return !!at && els.some((el) => el?.contains(at));
}
