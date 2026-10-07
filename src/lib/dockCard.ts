import { api } from './api';

/**
 * Dock: open a colleague's card right where it was clicked (desktop), instead of jumping to
 * the big office. The anchor is the clicked bubble, else the colleague's desk on screen.
 * A browser preview has no card window, so it opens the big office view as before.
 */
export function openColleague(
  id: string,
  options: { anchor?: Element | null; news?: boolean } = {},
) {
  const anchor = options.anchor ?? document.querySelector(`[data-session-id="${CSS.escape(id)}"]`);
  if (!api.card || !anchor) return api.window('main', id);
  const r = anchor.getBoundingClientRect();
  return api.card(
    'open',
    { id, news: !!options.news },
    { x: window.screenX + r.left, y: window.screenY + r.top, width: r.width, height: r.height },
  );
}
