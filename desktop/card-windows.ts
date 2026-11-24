import { app, BrowserWindow, nativeTheme, screen, type WebContents } from 'electron';
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
import {
  cardActivatesApp,
  cardFloats,
  cardLeftBehind,
  cardOwnWindow,
  cardPinOfAction,
  popupBounds,
  readCardPosition,
  readPinnedCards,
  type CardPin,
  type OtherAppWindow,
  type PinnedCard,
} from '../src/shared/card-windows.js';
import { floatLayer } from '../src/shared/popup-window.js';
import { m } from '../src/shared/i18n/index.js';
import { CardSizeMemory } from './card-size.js';
import { quiet } from './quiet.js';
import { cardWindowStyle, dropAppMenu, type CardMaterial } from './window-style.js';

export type { CardMaterial };

interface Entry {
  window: BrowserWindow;
  target: CardTarget | null;
  /**
   * How it is kept (`CardPin`): the replaceable preview, pinned, pinned on top, or in its own app
   * window. Its own window or a card panel is fixed when the window is made (`cardOwnWindow`).
   */
  pin: CardPin;
  /** Kept open: not the replaceable preview. */
  readonly pinned: boolean;
  shownAt: number;
  askedAt: number;
  dialogs: number;
  placed: { width: number; height: number };
  openingBounds?: Rect;
  /** Brought back at start: shown without taking the focus from what the person is doing. */
  restored?: boolean;
  /** A restored card's saved spot, kept until the person moves or resizes it. */
  savedBounds?: Rect;
  hide?: ReturnType<typeof setTimeout>;
  drag?: ReturnType<typeof setInterval>;
  /**
   * The card's window before it moved to this one (`transfer`) and whose card moved: it goes once
   * this one shows (`cardLeftBehind`).
   */
  replaces?: { entry: Entry; id: string };
}

/**
 * One replaceable preview, plus independent, explicitly pinned colleague windows (each pinned as
 * an ordinary window, on top, or taken out into an app window of its own). Pinned cards are
 * written down as they change, and come back where they were when the app starts again
 * (`restore`).
 */
export class CardWindows {
  private entries = new Set<Entry>();
  private preview: Entry | null = null;
  private position: Point | null;
  private sizes: CardSizeMemory;
  private writes: Promise<unknown> = Promise.resolve();
  /** The app is quitting: its windows closing is not the person closing pinned cards. */
  private quitting = false;
  /**
   * Pinned cards from the last run whose colleague is not in the office yet (a federated peer
   * still connecting, a collector still reading): kept in the file and tried again as snapshots
   * arrive, until `giveUp`.
   */
  private pending: PinnedCard[] | null = null;
  private resizeWrite?: ReturnType<typeof setTimeout>;

  constructor(
    private options: {
      index: string;
      preload: string;
      dir: string;
      secure: (window: BrowserWindow) => void;
      watch: (window: BrowserWindow) => void;
      /** A window that counts as "still here" for a preview card (its mini terminal window). */
      companion?: () => boolean;
      /**
       * macOS: the glass the card sits on. `under-window` is nearly solid grey; with the
       * person's own glass level (Settings › Look) cards take the clearer `popover` glass,
       * which lets the colours behind bleed through as the window moves.
       */
      material?: () => CardMaterial;
    },
  ) {
    this.position = readCardPosition(this.read('card-position.json'));
    this.sizes = new CardSizeMemory(
      readCardSize(this.read('card-size.json')) ?? CARD_SIZE,
      (size) =>
        void this.save('card-size.json', size).catch((error) => console.error('Card size:', error)),
      process.platform,
    );
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

  /** Writes down the pinned cards as they are now, for the next start. */
  private rememberPinned() {
    if (this.quitting) return;
    // Pins from the last run not brought back yet (setting off, screen sharing, a colleague still
    // missing) are kept, never overwritten by this run's.
    this.pending ??= readPinnedCards(this.read('pinned-cards.json'));
    const open: PinnedCard[] = [...this.entries].flatMap((e) =>
      e.pin === 'off' || !e.target || e.window.isDestroyed()
        ? []
        : [
            {
              target: { id: e.target.id },
              pin: e.pin,
              // Where it was saved until the person moves it: a card pulled onto the screen with
              // a display missing goes back there once the display returns.
              bounds: e.savedBounds ?? e.window.getBounds(),
            },
          ],
    );
    // Cards still waiting for their colleague stay written down too.
    const waiting = (this.pending ?? []).filter(
      (c) => !open.some((o) => o.target.id === c.target.id),
    );
    const cards = [...open, ...waiting];
    void this.save('pinned-cards.json', { v: 1, cards }).catch((error) =>
      console.error('Pinned cards:', error),
    );
  }
  /**
   * Opens again the cards pinned when the app last ran, where they were, without taking the
   * focus. A colleague the office no longer has (`exists`) stays closed; one moved to the lounge
   * or the archive still comes back, as the person pinned it.
   */
  restore(exists: (id: string) => boolean) {
    this.pending ??= readPinnedCards(this.read('pinned-cards.json'));
    if (!this.pending.length) return;
    const due = this.pending;
    this.pending = [];
    let opened = 0;
    for (const card of due) {
      if ([...this.entries].some((e) => e.pinned && e.target?.id === card.target.id)) continue;
      if (!exists(card.target.id)) {
        this.pending.push(card);
        continue;
      }
      const area = screen.getDisplayMatching(card.bounds).workArea;
      const bounds = clampInto(card.bounds, area);
      // A restored card is pinned from the start (in its own window again when it was), never the
      // replaceable preview. One in its own window opens on the current desktop: Electron cannot
      // put a window back on the Space it was on.
      const e = this.create(bounds, card.pin);
      e.restored = true;
      e.savedBounds = card.bounds;
      e.target = { id: card.target.id };
      opened++;
    }
    if (opened) this.rememberPinned();
  }
  /** The person moved or resized a pinned card: remember where once it settles. */
  private rememberSoon(e: Entry) {
    if (this.quitting) return;
    e.savedBounds = undefined;
    clearTimeout(this.resizeWrite);
    this.resizeWrite = setTimeout(() => this.rememberPinned(), 300);
  }
  /** Whether some pinned cards from the last run still wait for their colleague. */
  restoring() {
    return this.pending === null || this.pending.length > 0;
  }
  /** Long enough: colleagues still missing are gone, and their cards with them. */
  giveUp() {
    if (!this.pending?.length) return;
    this.pending = [];
    this.rememberPinned();
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
  /** The glass choice changed: every card swaps its material in place. */
  setMaterial(material: CardMaterial) {
    if (process.platform !== 'darwin') return;
    for (const w of this.windows()) w.setVibrancy(material);
  }
  private entry(sender: WebContents) {
    return [...this.entries].find(
      (e) => !e.window.isDestroyed() && e.window.webContents === sender,
    );
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
      pin: e.pin,
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
  /**
   * The preview floats over other apps (it closes as soon as they take focus), and so does a card
   * pinned on top; a plain pinned card and a card in its own window are ordinary windows
   * (`cardFloats`), the latter on the one desktop it is on. A quiet run layers for real: its
   * windows are invisible and click-through (desktop/quiet.ts).
   */
  private layer(window: BrowserWindow, pin: CardPin) {
    if (window.isDestroyed()) return;
    const layer = floatLayer(cardFloats(pin));
    window.setAlwaysOnTop(layer.alwaysOnTop, layer.level);
    window.setVisibleOnAllWorkspaces(layer.allSpaces, {
      visibleOnFullScreen: layer.allSpaces,
      skipTransformProcessType: true,
    });
  }
  private cancelHide(e: Entry) {
    if (e.hide) clearTimeout(e.hide);
    e.hide = undefined;
  }
  /**
   * Gives the card the keyboard. `steal` (asked just now, not a late load or a closed sheet) lets
   * it activate the app first (`cardActivatesApp`): always for a card in its own window, and for a
   * card panel when that cannot leave this Space for the big office's (opened from the desk panel
   * with the big office hidden). A panel made key without it only blinks its cursor while the
   * keys go to the app in front.
   */
  private focus(e: Entry, steal = true) {
    if (e.window.isDestroyed()) return;
    if (quiet) return;
    // A card in its own window may be minimized to the Dock or taskbar: brought back first.
    if (e.window.isMinimized()) e.window.restore();
    if (steal && process.platform === 'darwin' && cardActivatesApp(e.pin, otherWindows(e.window)))
      app.focus({ steal: true });
    e.window.focus();
    e.window.webContents.focus();
  }
  private revealEntry(e: Entry) {
    if (!e.target || e.window.isDestroyed()) return;
    this.cancelHide(e);
    e.window.webContents.send('office:card', e.target);
    e.window.webContents.send('office:card-state', this.state(e.window.webContents));
    e.shownAt = Date.now();
    if (quiet || e.restored) e.window.showInactive();
    else e.window.show();
    if (!e.restored) this.focus(e, Date.now() - e.askedAt < 2000);
    e.restored = false;
    // macOS can reposition a hidden panel while activating it.
    // Place an ordinary popup after activation; pinned cards keep their own position.
    if (e.openingBounds) {
      e.window.setBounds(e.openingBounds);
      e.openingBounds = undefined;
    }
    // The card moved here from another window: that one goes now this one shows, never leaving a
    // gap on screen while this one loaded.
    if (e.replaces) {
      const { entry: old, id } = e.replaces;
      e.replaces = undefined;
      const plan = cardLeftBehind(
        { pinned: old.pinned, id: old.target?.id ?? null },
        id,
        !!this.preview,
      );
      if (plan.preview && !old.window.isDestroyed()) this.preview = old;
      if (plan.close) this.hide(old);
      this.rememberPinned();
    }
  }
  private hide(e: Entry) {
    this.cancelHide(e);
    this.stopDrag(e);
    e.target = null;
    if (e.window.isDestroyed()) return;
    e.window.webContents.send('office:card', null);
    // Only the one preview is kept, hidden, for reuse: a pinned card closes for good, and so does
    // an ordinary card left behind by a move (`cardLeftBehind`).
    if (e.pinned || e !== this.preview) e.window.destroy();
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
    if (e?.window.isVisible() && e.target?.id === target.id) {
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
      if (target.bookmark || target.conversation) {
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
    if (e?.window.isVisible() && e.target?.id === target.id) {
      // A bubble asks for the conversation: shown, not toggled away.
      if (target.conversation) {
        this.cancelHide(e);
        e.target = target;
        e.askedAt = Date.now();
        this.revealEntry(e);
      } else this.hide(e);
      return;
    }
    const size = this.sizes.size;
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

  /**
   * A card window for `pin`: the replaceable preview (`off`, the default), a pinned card, or a
   * card in its own app window. Its frame follows (`cardWindowStyle`), and is fixed from here on.
   */
  private create(bounds: Rect, pin: CardPin = 'off') {
    const window = new BrowserWindow({
      ...bounds,
      show: false,
      resizable: true,
      minWidth: CARD_MIN.width,
      minHeight: CARD_MIN.height,
      ...cardWindowStyle(
        process.platform,
        cardOwnWindow(pin),
        this.options.material?.() ?? 'under-window',
        nativeTheme.shouldUseDarkColors,
      ),
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
      pin,
      get pinned() {
        return this.pin !== 'off';
      },
      shownAt: 0,
      askedAt: Date.now(),
      dialogs: 0,
      placed: bounds,
    };
    this.entries.add(e);
    if (pin === 'off') this.preview = e;
    this.options.secure(window);
    this.options.watch(window);
    // The preview floats (in a quiet run too, where every window is invisible and click-through).
    this.layer(window, pin);
    window.on('blur', () => this.blurred(e));
    window.on('closed', () => {
      this.cancelHide(e);
      this.stopDrag(e);
      this.entries.delete(e);
      if (this.preview === e) this.preview = null;
      // The person closed a pinned card: it does not come back.
      if (e.pinned) this.rememberPinned();
    });
    // Windows logging off or shutting down closes the app without before-quit: still a quit, not
    // the person closing each pinned card.
    window.on('session-end', () => this.dispose());
    // A pinned card moved or resized (a drag, its edge, the system) is remembered there once it
    // stops moving: a drag moves it every frame.
    window.on('moved', () => {
      if (e.pinned) this.rememberSoon(e);
    });
    // `resized` is macOS/Windows only; a pinned card's size is caught on `resize` everywhere,
    // written once the edge stops moving.
    window.on('resize', () => {
      if (e.pinned) this.rememberSoon(e);
    });
    // An ordinary card resized by the person: the next ones open at that size (on Linux too,
    // where only `resize` exists).
    this.sizes.watch(window, e);
    window.webContents.on('did-finish-load', () => this.revealEntry(e));
    void window.loadFile(this.options.index, { hash: 'card' });
    return e;
  }

  /**
   * Moves a card across the line between a card panel and its own app window (`cardOwnWindow`):
   * macOS fixes a panel when it is made, so the card opens again in a new window of the other
   * kind, where it was and on that colleague, and the old window goes once the new one shows.
   * Unsent text follows: drafts are kept per run, not per window.
   */
  private transfer(e: Entry, pin: CardPin) {
    if (!e.target) throw new Error(m().desktop.badRequest);
    // Back to the preview: the one preview there is makes room, as for `pin-off`.
    if (pin === 'off' && this.preview && this.preview !== e) {
      const old = this.preview;
      this.hide(old);
      old.window.destroy();
    }
    this.cancelHide(e);
    this.stopDrag(e);
    // Out of the preview's reuse while the new window loads: a colleague opened meanwhile gets a
    // preview of its own, never this window the move is about to put away.
    if (this.preview === e) this.preview = null;
    // Where it is now; a restored card's saved spot (a display still missing) stays written down.
    const next = this.create(e.window.getBounds(), pin);
    next.savedBounds = e.savedBounds;
    next.target = { id: e.target.id };
    next.replaces = { entry: e, id: e.target.id };
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
    // A card in its own window moves natively by its header (a drag region), across desktops too.
    if (cardOwnWindow(e.pin)) return;
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
      if (moved && e.pinned) this.rememberSoon(e);
      return;
    }
    if (action === 'position-on' || action === 'position-off')
      return this.remember(e, action === 'position-on');
    const pin = cardPinOfAction(action);
    if (pin) return this.repin(e, pin);
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
      if (e.pinned) this.rememberPinned();
      return;
    }
    if (action === 'reveal' && target) {
      // A kept card handed bubbles to another colleague (#377): it stays as it is, and that
      // colleague comes forward in its own kept card, else in the preview opened beside it.
      this.reveal(target, e.window.getBounds());
      return;
    }
    if (action === 'expand' && target) {
      if (e.target?.id !== target.id) throw new Error(m().desktop.badRequest);
      if (!e.pinned) this.hide(e);
      return target.id;
    }
    throw new Error(m().desktop.badRequest);
  }

  /** Puts a card in `pin`, in a new window when it crosses into or out of its own window. */
  private repin(e: Entry, pin: CardPin) {
    if (pin === e.pin) return;
    if (pin !== 'off') {
      if (!e.target) throw new Error(m().desktop.badRequest);
      const other = [...this.entries].find(
        (w) => w !== e && w.pinned && w.target?.id === e.target!.id,
      );
      if (other) {
        this.hide(e);
        this.focus(other);
        return;
      }
    }
    if (cardOwnWindow(pin) !== cardOwnWindow(e.pin)) return this.transfer(e, pin);
    if (pin === 'off') {
      // Return this card to the replaceable preview. Leave every other pinned card alone.
      if (this.preview && this.preview !== e) {
        const old = this.preview;
        this.hide(old);
        old.window.destroy();
      }
      this.preview = e;
    } else if (this.preview === e) this.preview = null;
    e.pin = pin;
    // A pin keeps the card open: an ordinary window other apps may cover, or one that stays on
    // top when the person chose that. Neither moves the focus.
    this.layer(e.window, pin);
    if (pin !== 'off') this.cancelHide(e);
    this.states();
    this.rememberPinned();
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
    // From here on windows close because the app quits: the pinned cards stay written down.
    this.quitting = true;
    clearTimeout(this.resizeWrite);
    for (const e of this.entries) {
      this.stopDrag(e);
      this.cancelHide(e);
    }
  }
}

/** The app's other windows, for whether activating it could move the screen to another Space. */
function otherWindows(self: BrowserWindow): OtherAppWindow[] {
  return BrowserWindow.getAllWindows()
    .filter((w) => w !== self && !w.isDestroyed())
    .map((w) => ({
      visible: w.isVisible(),
      minimized: w.isMinimized(),
      allSpaces: w.isVisibleOnAllWorkspaces(),
    }));
}
