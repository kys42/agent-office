import { api } from './api';

/**
 * Write text to the clipboard. In the desktop app this goes through main: the page's own
 * `navigator.clipboard` refuses whenever its window is not focused (a card or reader window
 * shown beside another app), which read as a missing permission. The web preview has no main.
 */
export async function writeClipboard(text: string) {
  if (api.copyText) {
    try {
      await api.copyText(text);
      return;
    } catch {
      // e.g. over main's size limit: the page's clipboard may still take it.
    }
  }
  await navigator.clipboard.writeText(text);
}
