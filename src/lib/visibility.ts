/**
 * Whether this page is out of sight. In the browser that is the tab's visibility; a hidden
 * Electron window can still report `document.hidden === false`, so the desktop app says when
 * its window shows and hides. Clocks, polls and lookups rest while hidden and catch up on return.
 */
let windowHidden = false;
const listeners = new Set<() => void>();
const notify = () => {
  // Every animation rests while the page is out of sight (see `.page-hidden` in tokens.css).
  if (typeof document !== 'undefined')
    document.documentElement.classList.toggle('page-hidden', isPageHidden());
  listeners.forEach((f) => f());
};
const office = typeof window === 'undefined' ? undefined : window.office;
office?.onVisibility?.((shown) => {
  windowHidden = !shown;
  notify();
});
void office
  ?.visible?.()
  .then((shown) => {
    windowHidden = !shown;
    notify();
  })
  .catch(() => {});
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', notify);

export const isPageHidden = () => windowHidden || document.hidden;
/** Called whenever the page is shown or hidden. */
export function onPageVisibility(callback: () => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
