import type { ShellTarget } from '../src/shared/mini-shell.js';
import {
  SHELL_WINDOW_MAX,
  SHELL_WINDOW_MIN,
  SHELL_WINDOW_SIZE,
} from '../src/shared/shell-window.js';
import { m } from '../src/shared/i18n/index.js';
import { PopupWindows, type PopupKind, type PopupOptions } from './popup-windows.js';

export const shellKind: PopupKind = {
  label: 'Terminal window',
  hash: 'shell',
  sizeFile: 'shell-window-size.json',
  size: SHELL_WINDOW_SIZE,
  min: SHELL_WINDOW_MIN,
  max: SHELL_WINDOW_MAX,
  window: () => ({
    // The terminal is dark in both themes, like a real one: no white flash while loading.
    backgroundColor: '#1c1c1e',
    title: m().shell.title,
  }),
};

/**
 * The mini terminal's windows (docs/development/TERMINAL.md · Mini terminal): one per folder
 * shell (keyed by its tmux session name), opened beside the window it was asked from. A window
 * only draws an attachment; closing it detaches (tmux keeps the shell). Only the mini terminal's
 * IPC trusts these windows. The window rules are the common popup ones (popup-windows.ts).
 */
export class ShellWindows extends PopupWindows<ShellTarget> {
  constructor(options: PopupOptions) {
    super(shellKind, options);
  }
}
