import { app, BrowserWindow, screen, type WebContents } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { clampInto, type Rect } from '../src/shared/dock-geometry.js';
import type { ShellTarget } from '../src/shared/mini-shell.js';
import {
  readShellWindowSize,
  shellWindowBounds,
  SHELL_WINDOW_MAX,
  SHELL_WINDOW_MIN,
  SHELL_WINDOW_SIZE,
} from '../src/shared/shell-window.js';
import { m } from '../src/shared/i18n/index.js';
import { quiet } from './quiet.js';
import { dropAppMenu } from './window-style.js';

interface Entry {
  window: BrowserWindow;
  /** The folder's shell (tmux session name): one window per shell. */
  key: string;
  target: ShellTarget;
  /** Floats like the card it was opened from (cards, the desk dock), or is an ordinary window. */
  float: boolean;
  placed: { width: number; height: number };
  /** Take the person's focus once loaded (opened by a click, not in a quiet run). */
  steal: boolean;
  ready: boolean;
}

/**
 * The mini terminal's windows (docs/development/TERMINAL.md · Mini terminal): one per folder
 * shell, opened beside the window it was asked from. A window only draws an attachment; closing
 * it detaches (tmux keeps the shell). Only the mini terminal's IPC trusts these windows.
 */
export class ShellWindows {
  private entries = new Set<Entry>();
  private size: { width: number; height: number };
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private options: {
      index: string;
      preload: string;
      dir: string;
      secure: (window: BrowserWindow) => void;
      /** A terminal window lost focus (a card preview may now put itself away). */
      blurred?: () => void;
    },
  ) {
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(path.join(options.dir, 'shell-window-size.json'), 'utf8'));
    } catch {
      /* first run */
    }
    this.size = readShellWindowSize(raw) ?? SHELL_WINDOW_SIZE;
  }

  private saveSize() {
    const value = this.size;
    const write = async () => {
      await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
      const dest = path.join(this.options.dir, 'shell-window-size.json');
      await writeFile(`${dest}.tmp`, JSON.stringify(value), { mode: 0o600 });
      await rename(`${dest}.tmp`, dest);
    };
    const next = this.writes.then(write);
    this.writes = next.catch(() => {});
    return next;
  }

  windows() {
    return [...this.entries].map((e) => e.window).filter((w) => !w.isDestroyed());
  }
  private entry(sender: WebContents) {
    return [...this.entries].find(
      (e) => !e.window.isDestroyed() && e.window.webContents === sender,
    );
  }
  owns(sender: WebContents) {
    return !!this.entry(sender);
  }
  /** Whether a terminal window has the keyboard now. */
  focused() {
    return [...this.entries].some((e) => !e.window.isDestroyed() && e.window.isFocused());
  }
  private require(sender: WebContents) {
    const e = this.entry(sender);
    if (!e) throw new Error(m().desktop.untrustedWindow);
    return e;
  }
  /** What this window shows; it asks once loaded. */
  target(sender: WebContents): ShellTarget {
    return this.require(sender).target;
  }
  /** Whether that window floats (a terminal opened from it floats too). */
  floats(sender: WebContents) {
    return !!this.entry(sender)?.float;
  }

  private present(e: Entry) {
    if (e.window.isDestroyed()) return;
    if (quiet) {
      e.window.showInactive();
      return;
    }
    if (e.window.isMinimized()) e.window.restore();
    e.window.show();
    if (e.steal && process.platform === 'darwin') app.focus({ steal: true });
    e.window.focus();
    e.window.webContents.focus();
    e.steal = false;
  }
  private setFloat(e: Entry, float: boolean) {
    e.float = float;
    // A quiet run's window stays behind the person's work.
    if (quiet || e.window.isDestroyed()) return;
    e.window.setAlwaysOnTop(float, 'pop-up-menu');
    e.window.setVisibleOnAllWorkspaces(float, {
      visibleOnFullScreen: float,
      skipTransformProcessType: true,
    });
  }

  /**
   * Opens the folder's terminal window beside `anchor`, or brings its window forward when it is
   * already open (it stays where the person left it).
   */
  open(key: string, target: ShellTarget, anchor: Rect, { float = false } = {}) {
    const open = [...this.entries].find((e) => e.key === key && !e.window.isDestroyed());
    if (open) {
      if (float && !open.float) this.setFloat(open, true);
      open.steal = true;
      if (open.ready) this.present(open);
      return;
    }
    const area = screen.getDisplayMatching(anchor).workArea;
    const bounds = shellWindowBounds(
      anchor,
      area,
      this.size,
      this.windows().map((w) => w.getBounds()),
    );
    // Too many at once: the oldest one goes (its shell keeps running in tmux).
    const all = [...this.entries].filter((e) => !e.window.isDestroyed());
    if (all.length >= SHELL_WINDOW_MAX) all[0].window.close();
    this.create(key, target, bounds, float);
  }

  private create(key: string, target: ShellTarget, bounds: Rect, float: boolean) {
    const window = new BrowserWindow({
      ...bounds,
      show: false,
      resizable: true,
      minWidth: SHELL_WINDOW_MIN.width,
      minHeight: SHELL_WINDOW_MIN.height,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      // The terminal is dark in both themes, like a real one: no white flash while loading.
      backgroundColor: '#1c1c1e',
      title: m().shell.title,
      ...(process.platform === 'darwin' ? { roundedCorners: true } : {}),
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Ctrl+C, Ctrl+A … go to the shell, not to the app's Edit menu (Windows/Linux).
    dropAppMenu(window);
    const e: Entry = {
      window,
      key,
      target,
      float: false,
      placed: { width: bounds.width, height: bounds.height },
      steal: true,
      ready: false,
    };
    this.entries.add(e);
    this.options.secure(window);
    this.setFloat(e, float);
    window.on('blur', () => this.options.blurred?.());
    window.on('closed', () => {
      this.entries.delete(e);
      this.options.blurred?.();
    });
    window.on('resized', () => {
      if (window.isDestroyed()) return;
      const [width, height] = window.getSize();
      if (width === e.placed.width && height === e.placed.height) return;
      e.placed = { width, height };
      this.size = { width, height };
      void this.saveSize().catch((error) => console.error('Terminal window size:', error));
    });
    window.webContents.once('did-finish-load', () => {
      e.ready = true;
      this.present(e);
    });
    void window.loadFile(this.options.index, { hash: 'shell' });
  }

  action(sender: WebContents, action: 'close' | 'focus') {
    const e = this.require(sender);
    if (action === 'close') e.window.close();
    else {
      e.steal = true;
      this.present(e);
    }
  }
  /** Closes every terminal window (each one detaches; the shells keep running). */
  closeAll() {
    for (const w of this.windows()) w.close();
  }
  reseat() {
    for (const e of this.entries) {
      if (e.window.isDestroyed()) continue;
      const bounds = e.window.getBounds();
      const fit = clampInto(bounds, screen.getDisplayMatching(bounds).workArea);
      e.placed = { width: fit.width, height: fit.height };
      e.window.setBounds(fit);
    }
  }
}
