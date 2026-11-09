/** No Electron import: unit tests drive it with a fake window. */
export interface Size {
  width: number;
  height: number;
}

/** What a card window must offer to have its size remembered (a `BrowserWindow` fits). */
export interface SizedWindow {
  on(event: 'resize' | 'resized' | 'closed', listener: () => void): unknown;
  isDestroyed(): boolean;
  getSize(): number[];
}

/** The card a window shows: `placed` is the size the app last gave it, `pinned` keeps its own. */
export interface SizedCard {
  placed: Size;
  pinned: boolean;
}

/** How long `resize` must be still on Linux before the new size counts as settled. */
export const CARD_RESIZE_SETTLE_MS = 300;

/**
 * The size ordinary (preview) cards open at, as the person last resized one. A side only changes
 * when the person changed it: a placement the app made (`placed`) is not the person's choice.
 *
 * macOS and Windows report a finished resize (`resized`), once. Linux has no `resized`, only
 * `resize`, which fires for every step of an edge drag: there the size is taken once it stops.
 * One of the two is listened to, never both, so a resize is saved once.
 */
export class CardSizeMemory {
  constructor(
    public size: Size,
    private save: (size: Size) => void,
    private platform: NodeJS.Platform,
    private settleMs = CARD_RESIZE_SETTLE_MS,
  ) {}

  watch(window: SizedWindow, card: SizedCard) {
    const settled = () => this.settled(window, card);
    if (this.platform === 'darwin' || this.platform === 'win32') {
      window.on('resized', settled);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    window.on('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(settled, this.settleMs);
    });
    window.on('closed', () => clearTimeout(timer));
  }

  private settled(window: SizedWindow, card: SizedCard) {
    // A pinned card's bounds are remembered with the pinned cards, not as the opening size.
    if (window.isDestroyed() || card.pinned) return;
    const [width, height] = window.getSize();
    const next = {
      width: width !== card.placed.width ? width : this.size.width,
      height: height !== card.placed.height ? height : this.size.height,
    };
    card.placed = { width, height };
    if (next.width === this.size.width && next.height === this.size.height) return;
    this.size = next;
    this.save(next);
  }
}
