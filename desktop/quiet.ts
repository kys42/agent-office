import { app, type BrowserWindow } from 'electron';

/**
 * Quiet mode (`AGENT_OFFICE_QUIET=1`) is for local test runs: windows still open and work, but
 * never take the person's focus or pull their screen to the app while they work elsewhere.
 * On macOS the app also stays out of the Dock and the app switcher.
 */
export const quiet = process.env.AGENT_OFFICE_QUIET === '1';

export function quietStart() {
  if (quiet && process.platform === 'darwin') app.setActivationPolicy('accessory');
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
