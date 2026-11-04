import { api } from './api';
import type { ShellTarget } from '../shared/mini-shell';

// The mini terminal opens in its own window, one per folder shell, beside the window that asked
// (desktop/shell-windows.ts). Closing that window only detaches; tmux keeps the shell.

/** Whether this window can open terminal windows (the desktop app on macOS/Linux). */
export const canOpenMiniShell = () => !!api.shell?.window;

/** Opens the folder's terminal window, or brings it forward when it is already open. */
export function openMiniShell(target: ShellTarget): Promise<void> {
  if (!api.shell?.window) return Promise.resolve();
  return api.shell.window('open', target);
}

/** In a terminal window: closes it (the shell keeps running). */
export function closeMiniShell() {
  void api.shell?.window('close').catch(() => window.close());
}
