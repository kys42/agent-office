import type { OfficeAPI } from '../shared/types';

/**
 * The desktop-only settings (terminal send, answering) are not in the shared snapshot, so each
 * window re-reads them when the main process says one changed, and on focus as a cheap
 * fallback (a change missed while the window was being created). Returns the unsubscribe.
 */
export function followDesktopSettings(
  api: Pick<OfficeAPI, 'onDesktopSettings'>,
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  reload: () => void,
): () => void {
  const off = api.onDesktopSettings?.(reload);
  target.addEventListener('focus', reload);
  return () => {
    off?.();
    target.removeEventListener('focus', reload);
  };
}
