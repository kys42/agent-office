import { app, BrowserWindow, screen, type WebContents } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import type { CardTarget, CardWindowState } from '../src/shared/types.js';
import {
  CARD_MIN,
  CARD_SIZE,
  readCardSize,
  clampInto,
  type Point,
  type Rect,
} from '../src/shared/dock-geometry.js';
import { popupBounds, readCardPosition } from '../src/shared/card-windows.js';
import { m } from '../src/shared/i18n/index.js';
import { quiet } from './quiet.js';
import { dropAppMenu } from './window-style.js';

interface Entry {
  window: BrowserWindow;
  target: CardTarget | null;
  pinned: boolean;
  shownAt: number;
  askedAt: number;
  dialogs: number;
  placed: { width: number; height: number };
  openingBounds?: Rect;
  hide?: ReturnType<typeof setTimeout>;
  drag?: ReturnType<typeof setInterval>;
}

/** One replaceable preview, plus independent, explicitly pinned colleague windows. */
export class CardWindows {
  private entries = new Set<Entry>();
  private preview: Entry | null = null;
  private position: Point | null;
  private size: { width: number; height: number };
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private options: {
      index: string;
      preload: string;
      dir: string;
      secure: (window: BrowserWindow) => void;
      watch: (window: BrowserWindow) => void;
      /** A window that counts as "still here" for a preview card (its mini terminal window). */
      companion?: () => boolean;
    },
  ) {
    this.position = readCardPosition(this.read('card-position.json'));
    this.size = readCardSize(this.read('card-size.json')) ?? CARD_SIZE;
  }

  private read(file: string): unknown {
    try {
      return JSON.parse(readFileSync(path.join(this.options.dir, file), 'utf8'));
    } catch {
      return null;
    }
  }

  private save(file: string, value: unknown) {
    const write = async () => {
      await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
      const dest = path.join(this.options.dir, file);
      await writeFile(`${dest}.tmp`, JSON.stringify(value), { mode: 0o600 });
      await rename(`${dest}.tmp`, dest);
    };
    const next = this.writes.then(write);
    this.writes = next.catch(() => {});
    return next;
  }

  /** The colleagues whose card is on screen now. */
  shown() {
    return [...this.entries]
      .filter((e) => e.target && !e.window.isDestroyed() && e.window.isVisible())
      .map((e) => e.target!.id);
  }
  windows() {
    return [...this.entries].map((e) => e.window).filter((w) => !w.isDestroyed());
  }
  private entry(sender: WebContents) {
    return [...this.entries].find((e) => e.window.webContents === sender);
  }
  owns(sender: WebContents) {
    return !!this.entry(sender);
  }
  private require(sender: WebContents) {
    const e = this.entry(sender);
    if (!e) throw new Error(m().desktop.untrustedWindow);
    return e;
  }
  state(sender: WebContents): CardWindowState {
    const e = this.require(sender);
    const at = e.window.getBounds();
    return {
      pinned: e.pinned,
      target: e.target,
      positionRemembered:
        !!this.position && (!e.pinned || (at.x === this.position.x && at.y === this.position.y)),
    };
  }
  private states() {
    for (const e of this.entries)
      if (!e.window.isDestroyed())
        e.window.webContents.send('office:card-state', this.state(e.window.webContents));
  }
  private cancelHide(e: Entry) {
    if (e.hide) clearTimeout(e.hide);
    e.hide = undefined;
  }
  private focus(e: Entry, steal = true) {
    if (e.window.isDestroyed()) return;
    if (quiet) return;
    if (steal && process.platform === 'darwin') app.focus({ steal: true });
    e.window.focus();
    e.window.webContents.focus();
  }
  private revealEntry(e: Entry) {
    if (!e.target || e.window.isDestroyed()) return;
    this.cancelHide(e);
    e.window.webContents.send('office:card', e.target);
    e.window.webContents.send('office:card-state', this.state(e.window.webContents));
    e.shownAt = Date.now();
    if (quiet) e.window.showInactive();
    else e.window.show();
    this.focus(e, Date.now() - e.askedAt < 2000);
    // macOS can reposition a hidden panel while activating it.
    // Place an ordinary popup after activation; pinned cards keep their own position.
    if (e.openingBounds) {
      e.window.setBounds(e.openingBounds);
      e.openingBounds = undefined;
    }
  }
  private hide(e: Entry) {
    this.cancelHide(e);
    this.stopDrag(e);
    e.target = null;
    if (e.window.isDestroyed()) return;
    e.window.webContents.send('office:card', null);
    if (e.pinned) e.window.destroy();
    else e.window.hide();
  }
  /** A terminal jump puts away only an ordinary preview, never a pinned card. */
  afterJump(sender: WebContents) {
    const e = this.entry(sender);
    if (e && !e.pinned) this.hide(e);
  }

  /**
   * Like `open`, but never puts away a card already on screen for that colleague: it is only
   * brought forward (a notification click wants that colleague shown, not toggled).
   */
  reveal(target: CardTarget, anchor: Rect) {
    const e = this.preview;
    if (e?.window.isVisible() && e.target?.id === target.id && e.target.news === target.news) {
      this.cancelHide(e);
      e.askedAt = Date.now();
      this.revealEntry(e);
      return;
    }
    this.open(target, anchor);
  }

  open(target: CardTarget, anchor: Rect) {
    const pinned = [...this.entries].find((e) => e.pinned && e.target?.id === target.id);
    if (pinned) {
      this.cancelHide(pinned);
      if (target.bookmark || pinned.target?.news !== target.news) {
        pinned.target = target;
        this.revealEntry(pinned);
      } else {
        if (quiet) pinned.window.showInactive();
        else pinned.window.show();
        this.focus(pinned);
      }
      return;
    }
    let e = this.preview;
    if (e?.window.isVisible() && e.target?.id === target.id && e.target.news === target.news) {
      this.hide(e);
      return;
    }
    const size = this.size;
    const at = this.position ? { ...this.position, ...size } : anchor;
    const area = screen.getDisplayMatching(at).workArea;
    const bounds = popupBounds(
      anchor,
      area,
      size,
      this.position,
      [...this.entries].filter((w) => w.pinned).map((w) => w.window.getBounds()),
    );
    if (!e) e = this.create(bounds);
    else {
      this.cancelHide(e);
      this.stopDrag(e);
      e.placed = { width: bounds.width, height: bounds.height };
      e.window.setBounds(bounds);
    }
    e.placed = { width: bounds.width, height: bounds.height };
    e.openingBounds = bounds;
    e.target = target;
    e.askedAt = Date.now();
    if (!e.window.webContents.isLoadingMainFrame()) this.revealEntry(e);
  }

  private create(bounds: Rect) {
    const window = new BrowserWindow({
      ...bounds,
      show: false,
      resizable: true,
      minWidth: CARD_MIN.width,
      minHeight: CARD_MIN.height,
      maximizable: false,
      frame: false,
      transparent: true,
      fullscreenable: false,
      skipTaskbar: true,
      ...(process.platform === 'darwin'
        ? {
            vibrancy: 'under-window' as const,
            visualEffectState: 'active' as const,
            roundedCorners: true,
            type: 'panel' as const,
          }
        : {}),
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Like the big window: no app Edit menu of its own on Windows/Linux, so Ctrl keys reach the
    // page.
    dropAppMenu(window);
    const e: Entry = {
      window,
      target: null,
      pinned: false,
      shownAt: 0,
      askedAt: Date.now(),
      dialogs: 0,
      placed: bounds,
    };
    this.entries.add(e);
    this.preview = e;
    this.options.secure(window);
    this.options.watch(window);
    // A quiet run's card stays behind the person's work, on its own Space.
    if (!quiet) {
      window.setAlwaysOnTop(true, 'pop-up-menu');
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    }
    window.on('blur', () => this.blurred(e));
    window.on('closed', () => {
      this.cancelHide(e);
      this.stopDrag(e);
      this.entries.delete(e);
      if (this.preview === e) this.preview = null;
    });
    window.on('resized', () => {
      if (window.isDestroyed() || e.pinned) return;
      const [width, height] = window.getSize();
      this.size = {
        width: width !== e.placed.width ? width : this.size.width,
        height: height !== e.placed.height ? height : this.size.height,
      };
      void this.save('card-size.json', this.size).catch((error) =>
        console.error('Card size:', error),
      );
      e.placed = { width, height };
    });
    window.webContents.on('did-finish-load', () => this.revealEntry(e));
    void window.loadFile(this.options.index, { hash: 'card' });
    return e;
  }

  /** A preview card goes away once the person works elsewhere (not in its terminal window). */
  private blurred(e: Entry) {
    if (e.dialogs || e.pinned) return;
    this.cancelHide(e);
    e.hide = setTimeout(
      () => {
        e.hide = undefined;
        if (
          !e.pinned &&
          !e.dialogs &&
          !e.window.isDestroyed() &&
          !e.window.isFocused() &&
          !this.options.companion?.()
        )
          this.hide(e);
      },
      Math.max(150, e.shownAt + 500 - Date.now()),
    );
  }
  /** Focus left a companion window: a preview card that is not focused either goes away. */
  recheck() {
    const e = this.preview;
    if (e && !e.window.isDestroyed() && e.window.isVisible() && !e.window.isFocused())
      this.blurred(e);
  }

  private stopDrag(e: Entry) {
    if (e.drag) clearInterval(e.drag);
    e.drag = undefined;
  }
  private startDrag(e: Entry) {
    this.stopDrag(e);
    const cursor = screen.getCursorScreenPoint();
    const [x, y] = e.window.getPosition();
    const offset = { x: cursor.x - x, y: cursor.y - y };
    const started = Date.now();
    e.drag = setInterval(() => {
      if (e.window.isDestroyed() || Date.now() - started > 30_000) {
        this.stopDrag(e);
        return;
      }
      const at = screen.getCursorScreenPoint();
      e.window.setPosition(at.x - offset.x, at.y - offset.y);
    }, 16);
  }
  private async remember(e: Entry, on: boolean) {
    const { x, y } = e.window.getBounds();
    const point = on ? { x, y } : null;
    await this.save('card-position.json', point ? { enabled: true, ...point } : { enabled: false });
    this.position = point;
    this.states();
  }
  async action(sender: WebContents, action: string, target?: CardTarget) {
    const e = this.require(sender);
    if (action === 'focus') {
      this.cancelHide(e);
      this.focus(e);
      return;
    }
    if (action === 'close') {
      this.hide(e);
      return;
    }
    if (action === 'drag-start') {
      this.startDrag(e);
      return;
    }
    if (action === 'drag-end') {
      const moved = !!e.drag;
      this.stopDrag(e);
      if (moved && !e.pinned && this.position) await this.remember(e, true);
      else this.states();
      return;
    }
    if (action === 'position-on' || action === 'position-off')
      return this.remember(e, action === 'position-on');
    if (action === 'pin-on') {
      if (!e.target) throw new Error(m().desktop.badRequest);
      const other = [...this.entries].find(
        (w) => w !== e && w.pinned && w.target?.id === e.target!.id,
      );
      if (other) {
        this.hide(e);
        this.focus(other);
        return;
      }
      e.pinned = true;
      this.cancelHide(e);
      if (this.preview === e) this.preview = null;
      this.states();
      return;
    }
    if (action === 'pin-off') {
      if (!e.pinned) return;
      // Return this card to the replaceable preview. Leave every other pinned card alone.
      if (this.preview && this.preview !== e) {
        const old = this.preview;
        this.hide(old);
        old.window.destroy();
      }
      e.pinned = false;
      this.preview = e;
      this.states();
      return;
    }
    if (action === 'select' && target) {
      const other = [...this.entries].find(
        (w) => w !== e && w.pinned && w.target?.id === target.id,
      );
      if (other) {
        if (!e.pinned) this.hide(e);
        if (target.bookmark) {
          other.target = target;
          this.revealEntry(other);
        } else this.focus(other);
        return;
      }
      if (e.pinned && this.preview?.target?.id === target.id) this.hide(this.preview);
      e.target = target;
      e.window.webContents.send('office:card', target);
      return;
    }
    if (action === 'expand' && target) {
      if (e.target?.id !== target.id) throw new Error(m().desktop.badRequest);
      if (!e.pinned) this.hide(e);
      return target.id;
    }
    throw new Error(m().desktop.badRequest);
  }

  /** Native sheets suspend only their owning card's blur handler. */
  dialog(sender: WebContents) {
    const e = this.entry(sender);
    if (!e) return () => {};
    e.dialogs++;
    this.cancelHide(e);
    return () => {
      e.dialogs--;
      if (!e.window.isDestroyed()) this.focus(e, false);
    };
  }
  reseat() {
    for (const e of this.entries) {
      const bounds = e.window.getBounds();
      const fit = clampInto(bounds, screen.getDisplayMatching(bounds).workArea);
      e.placed = { width: fit.width, height: fit.height };
      e.window.setBounds(fit);
    }
    this.states();
  }
  dispose() {
    for (const e of this.entries) {
      this.stopDrag(e);
      this.cancelHide(e);
    }
  }
}
