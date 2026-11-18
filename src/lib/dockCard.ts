import { api } from './api';

/**
 * Dock: open a colleague's card right where it was clicked (desktop), instead of jumping to
 * the big office. The anchor is the clicked bubble, else the colleague's desk on screen.
 * A browser preview has no card window, so it opens the big office view as before.
 * `conversation`: a bubble asked for it — the card shows the conversation, even if open already.
 */
export function openColleague(
  id: string,
  options: { anchor?: Element | null; conversation?: boolean } = {},
) {
  const anchor = options.anchor ?? document.querySelector(`[data-session-id="${CSS.escape(id)}"]`);
  if (!api.card || !anchor) return api.window('main', id);
  const r = anchor.getBoundingClientRect();
  return api.card(
    'open',
    { id, ...(options.conversation && { conversation: true }) },
    { x: window.screenX + r.left, y: window.screenY + r.top, width: r.width, height: r.height },
  );
}
