import { app, type BrowserWindow } from 'electron';

/**
 * Quiet mode (`AGENT_OFFICE_QUIET=1`) is for local test runs beside someone's work: windows
 * still open and work, but the person never sees them, never clicks into them, and they never
 * take the person's focus or pull their screen to the app. On macOS the app also stays out of
 * the Dock and the app switcher.
 *
 * How (one place, every window, `quietStart`): each BrowserWindow the app makes (main, cards,
 * popups, settings, pet/dock) is made fully transparent (`setOpacity(0)`) and click-through
 * (`setIgnoreMouseEvents(true)`) the moment it is created, and stays so: the app's own later
 * opacity and mouse changes are kept away from it. `show()` only ever shows it inactive,
 * `focus()`/`moveTop()` and `app.focus()` do nothing.
 *
 * Everything else is real, so smokes can test it: windows are still shown (`isVisible()`),
 * placed and sized, and layered for real — `setAlwaysOnTop` with its level and
 * `setVisibleOnAllWorkspaces` apply, so `isAlwaysOnTop()` reads what the app chose. An invisible,
 * click-through window over other apps is not in anyone's way. Pages still render, so
 * `capturePage` and Playwright screenshots (which read the page's compositor, not the screen)
 * still work. What a quiet run cannot check is the OS focus (`document.hasFocus()`, which
 * window holds the keyboard): those steps run only with AGENT_OFFICE_FOCUS_TESTS=1 or in CI
 * (scripts/quiet-smoke.mjs).
 */
export const quiet = process.env.AGENT_OFFICE_QUIET === '1';

/** Makes a window invisible and untouchable for the person while it keeps working. */
export function hideFromPerson(window: BrowserWindow) {
  window.setOpacity(0);
  window.setIgnoreMouseEvents(true);
  // The app's own later changes never bring it back into view or under the pointer.
  window.setOpacity = () => {};
  window.setIgnoreMouseEvents = () => {};
  window.show = () => window.showInactive();
  window.focus = () => {};
  window.moveTop = () => {};
}

export function quietStart() {
  if (!quiet) return;
  if (process.platform === 'darwin') app.setActivationPolicy('accessory');
  app.focus = () => {};
  // Emitted from inside the BrowserWindow constructor: before any window can be shown.
  app.on('browser-window-created', (_event, window) => hideFromPerson(window));
}

/** Shows a window and gives it focus; in quiet mode only shows it, behind the person's work. */
export function present(window: BrowserWindow) {
  if (quiet) {
    if (!window.isVisible()) window.showInactive();
    return;
  }
  window.show();
  window.focus();
}
