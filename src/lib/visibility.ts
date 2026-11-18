/**
 * Whether this page is out of sight. In the browser that is the tab's visibility; a hidden
 * Electron window can still report `document.hidden === false`, so the desktop app says when
 * its window shows and hides. Clocks, polls and lookups rest while hidden and catch up on return.
 */
let windowHidden = false;
// The desktop app answers whether its window is on screen; until then this page does not know.
let settled = false;
const listeners = new Set<() => void>();
const notify = () => {
  // Every animation rests while the page is out of sight (see `.page-hidden` in tokens.css).
  if (typeof document !== 'undefined')
    document.documentElement.classList.toggle('page-hidden', isPageHidden());
  listeners.forEach((f) => f());
};
const office = typeof window === 'undefined' ? undefined : window.office;
settled = !office?.visible;
office?.onVisibility?.((shown) => {
  windowHidden = !shown;
  settled = true;
  notify();
});
void office
  ?.visible?.()
  .then((shown) => {
    windowHidden = !shown;
    settled = true;
    notify();
  })
  .catch(() => {
    settled = true;
    notify();
  });
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', notify);

export const isPageHidden = () => windowHidden || document.hidden;
/** Known to be in sight: what the person is looking at (e.g. a card that reads its replies). */
export const isPageShown = () => settled && !isPageHidden();
/** Called whenever the page is shown or hidden. */
export function onPageVisibility(callback: () => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
