import type { TermTarget } from '../src/shared/term-view.js';
import {
  SHELL_WINDOW_MAX,
  SHELL_WINDOW_MIN,
  SHELL_WINDOW_SIZE,
} from '../src/shared/shell-window.js';
import { m } from '../src/shared/i18n/index.js';
import { PopupWindows, type PopupKind, type PopupOptions } from './popup-windows.js';

export const termKind: PopupKind = {
  label: 'Built-in terminal window',
  hash: 'term',
  sizeFile: 'term-window-size.json',
  size: SHELL_WINDOW_SIZE,
  min: SHELL_WINDOW_MIN,
  max: SHELL_WINDOW_MAX,
  window: () => ({
    // The terminal is dark in both themes, like a real one: no white flash while loading.
    backgroundColor: '#1c1c1e',
    title: m().launch.destination.builtin,
  }),
};

/**
 * The built-in terminal's windows (#401, docs/development/TERM-HOST.md): one per session of the
 * app's terminal host, keyed by its id, opened beside the window it was asked from (a jump, a
 * launch). A window only draws its view; closing it detaches (the session keeps running). Only
 * the built-in terminal's IPC trusts these windows, and each attaches its own session only.
 */
export class TermWindows extends PopupWindows<TermTarget> {
  constructor(options: PopupOptions) {
    super(termKind, options);
  }
}
