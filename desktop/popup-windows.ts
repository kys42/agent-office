import {
  app,
  BrowserWindow,
  screen,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { clampInto, type Rect } from '../src/shared/dock-geometry.js';
import {
  floatLayer,
  popupOpenPlan,
  popupReopenFloats,
  popupWindowBounds,
  readWindowSize,
  type WindowSize,
} from '../src/shared/popup-window.js';
import { m } from '../src/shared/i18n/index.js';
import { quiet } from './quiet.js';
import { dropAppMenu } from './window-style.js';

/** One kind of popup window: what it shows, its sizes and its own options. */
export interface PopupKind {
  /** For logs ("Terminal window size: …"). */
  label: string;
  /** The renderer's route for this kind (`#shell`, `#reader`). */
  hash: string;
  /** Where the person's last size is remembered (userData), as `{width,height}` JSON. */
  sizeFile: string;
  size: WindowSize;
  min: WindowSize;
  /** Windows of this kind open at once; opening one more closes the oldest. */
  max: number;
  /** This kind's own window options (title, background …), read when a window is made. */
  window: () => BrowserWindowConstructorOptions;
}
export interface PopupOptions {
  index: string;
  preload: string;
  dir: string;
  secure: (window: BrowserWindow) => void;
  /** A window of this kind lost focus or closed (a card preview may now put itself away). */
  blurred?: () => void;
  /** A window was made (e.g. to deliver snapshots to it). */
  created?: (window: BrowserWindow) => void;
}

interface Entry<Target> {
  window: BrowserWindow;
  /** One window per key (a folder's shell, a bookmark). */
  key: string;
  target: Target;
  /**
   * Stays on top: at first like the window it was opened from (cards, the desk dock), then as
   * the person sets it with the window's own toggle (`setOnTop`).
   */
  float: boolean;
  placed: WindowSize;
  /** Take the person's focus once loaded (opened by a click, not in a quiet run). */
  steal: boolean;
  ready: boolean;
}

/**
 * The common popup pattern (docs/development/POPUP-CARDS.md · 옆에 뜨는 팝업 창): small
 * frameless windows of one kind, one per key, opened beside the window they were asked from
 * (`popupWindowBounds`, stepped aside from the same kind's windows). A window opened again by
 * its key comes forward where the person left it. The person's last size is remembered per
 * kind. Quiet runs only show them inactive. Each kind's IPC trusts only its own windows
 * (`owns`), and a window asks for what it shows (`target`) once loaded. Each window's header
 * toggles whether it stays on top (`setOnTop`, `onTop`).
 */
export class PopupWindows<Target> {
  private entries = new Set<Entry<Target>>();
  private size: WindowSize;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private kind: PopupKind,
    private options: PopupOptions,
  ) {
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(path.join(options.dir, kind.sizeFile), 'utf8'));
    } catch {
      /* first run */
    }
    this.size = readWindowSize(raw, kind.min) ?? kind.size;
  }

  // Writes run one after another, each through a temp file so a crash never leaves half a file.
  private saveSize() {
    const value = this.size;
    const write = async () => {
      await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
      const dest = path.join(this.options.dir, this.kind.sizeFile);
      await writeFile(`${dest}.tmp`, JSON.stringify(value), { mode: 0o600 });
      await rename(`${dest}.tmp`, dest);
    };
    const next = this.writes.then(write);
    this.writes = next.catch(() => {});
    return next;
  }

  private live() {
    return [...this.entries].filter((e) => !e.window.isDestroyed());
  }
  windows() {
    return this.live().map((e) => e.window);
  }
  private entry(sender: WebContents) {
    return this.live().find((e) => e.window.webContents === sender);
  }
  owns(sender: WebContents) {
    return !!this.entry(sender);
  }
  /** Whether a window of this kind has the keyboard now. */
  focused() {
    return this.live().some((e) => e.window.isFocused());
  }
  private require(sender: WebContents) {
    const e = this.entry(sender);
    if (!e) throw new Error(m().desktop.untrustedWindow);
    return e;
  }
  /** What this window shows; it asks once loaded. */
  target(sender: WebContents): Target {
    return this.require(sender).target;
  }
  /** Whether that window floats (a popup opened from it floats too). */
  floats(sender: WebContents) {
    return !!this.entry(sender)?.float;
  }

  private present(e: Entry<Target>) {
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
  private setFloat(e: Entry<Target>, float: boolean) {
    const changed = e.float !== float;
    e.float = float;
    if (e.window.isDestroyed()) return;
    // The window's own on-top toggle hears every change (a floating opener floats it again too).
    if (changed) e.window.webContents.send('office:popup-on-top', float);
    // Layered for real, quiet runs too: there the window is invisible and click-through
    // (desktop/quiet.ts), so floating it gets in nobody's way.
    const layer = floatLayer(float);
    e.window.setAlwaysOnTop(layer.alwaysOnTop, layer.level);
    e.window.setVisibleOnAllWorkspaces(layer.allSpaces, {
      visibleOnFullScreen: layer.allSpaces,
      skipTransformProcessType: true,
    });
  }

  /**
   * Opens the window for `key` beside `anchor`, or brings its window forward when it is already
   * open (it stays where the person left it).
   */
  open(key: string, target: Target, anchor: Rect, { float = false } = {}) {
    const plan = popupOpenPlan(this.live(), key, this.kind.max);
    if ('focus' in plan) {
      const open = plan.focus;
      this.setFloat(open, popupReopenFloats(open.float, float));
      open.steal = true;
      if (open.ready) this.present(open);
      return;
    }
    const area = screen.getDisplayMatching(anchor).workArea;
    const bounds = popupWindowBounds(
      anchor,
      area,
      this.size,
      this.windows().map((w) => w.getBounds()),
    );
    // Too many at once: the oldest one goes.
    plan.evict?.window.close();
    this.create(key, target, bounds, float);
  }

  private create(key: string, target: Target, bounds: Rect, float: boolean) {
    const window = new BrowserWindow({
      ...bounds,
      show: false,
      resizable: true,
      minWidth: this.kind.min.width,
      minHeight: this.kind.min.height,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      ...(process.platform === 'darwin' ? { roundedCorners: true } : {}),
      ...this.kind.window(),
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Ctrl+C, Ctrl+A … go to the page, not to the app's Edit menu (Windows/Linux).
    dropAppMenu(window);
    const e: Entry<Target> = {
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
    this.options.created?.(window);
    this.setFloat(e, float);
    window.on('blur', () => this.options.blurred?.());
    window.on('closed', () => {
      this.entries.delete(e);
      this.options.blurred?.();
    });
    // `resize` (debounced) rather than `resized`, which Linux never emits.
    let resizing: NodeJS.Timeout | undefined;
    window.on('resize', () => {
      clearTimeout(resizing);
      resizing = setTimeout(() => persist(), 300);
    });
    const persist = () => {
      if (window.isDestroyed()) return;
      const [width, height] = window.getSize();
      if (width === e.placed.width && height === e.placed.height) return;
      e.placed = { width, height };
      this.size = { width, height };
      void this.saveSize().catch((error) => console.error(`${this.kind.label} size:`, error));
    };
    window.webContents.once('did-finish-load', () => {
      e.ready = true;
      this.present(e);
    });
    void window.loadFile(this.options.index, { hash: this.kind.hash });
  }

  action(sender: WebContents, action: 'close' | 'focus') {
    const e = this.require(sender);
    if (action === 'close') e.window.close();
    else {
      e.steal = true;
      this.present(e);
    }
  }
  /**
   * That window's own on-top toggle (its header): `on` keeps it above other windows like a
   * preview card, off makes it an ordinary window. Only a window of this kind sets its own; it
   * never takes the focus. Returns what it is now.
   */
  setOnTop(sender: WebContents, on: boolean) {
    const e = this.require(sender);
    this.setFloat(e, on);
    return e.float;
  }
  /** Whether that window (of this kind only) stays on top now. */
  onTop(sender: WebContents) {
    return this.require(sender).float;
  }
  /** Closes every window of this kind. */
  closeAll() {
    for (const w of this.windows()) w.close();
  }
  /** Displays changed: each window back inside a work area. */
  reseat() {
    for (const e of this.live()) {
      const bounds = e.window.getBounds();
      const fit = clampInto(bounds, screen.getDisplayMatching(bounds).workArea);
      e.placed = { width: fit.width, height: fit.height };
      e.window.setBounds(fit);
    }
  }
}
