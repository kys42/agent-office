import type { Rect } from '../src/shared/dock-geometry.js';
import type { TermTarget } from '../src/shared/term-view.js';
import { m } from '../src/shared/i18n/index.js';
import { PopupWindows, type PopupKind, type PopupOptions } from './popup-windows.js';

/** First size of the terminal manager; the person's own resize is remembered after that. */
export const TERM_MANAGER_SIZE = { width: 960, height: 600 };
/** Still a narrow list and a few lines of a terminal. */
export const TERM_MANAGER_MIN = { width: 560, height: 320 };

export const termManagerKind: PopupKind = {
  label: 'Terminal manager window',
  hash: 'terms',
  sizeFile: 'term-manager-size.json',
  size: TERM_MANAGER_SIZE,
  min: TERM_MANAGER_MIN,
  max: 1,
  window: () => ({
    backgroundColor: '#1c1c1e',
    title: m().shell.manager.title,
  }),
};

const KEY = 'manager';

/**
 * The terminal manager (터미널 관리 창, docs/development/TERM-HOST.md): one window over every
 * session of the built-in terminal. Main keeps which session it shows (`selected`): the window
 * chooses one through main (which checks the daemon lists it), and its view attaches only that
 * one. Closing it detaches; every session keeps running.
 */
export class TermManagerWindow extends PopupWindows<null> {
  private chosen: TermTarget | null = null;

  constructor(options: PopupOptions) {
    super(termManagerKind, options);
  }

  /** The session the manager shows now (null: none chosen yet, or the window is closed). */
  get selected() {
    return this.has(KEY) ? this.chosen : null;
  }

  /** The window chose this session (already checked against the daemon's list). */
  select(target: TermTarget) {
    this.chosen = target;
  }

  /**
   * Opens the manager beside `anchor` (or brings it forward). With a session, it is chosen and
   * the window, if already open, is told to switch to it.
   */
  show(anchor: Rect, target?: TermTarget, options?: { float?: boolean }) {
    if (!this.has(KEY)) this.chosen = null;
    if (target) this.chosen = target;
    const how = this.open(KEY, null, anchor, options);
    if (how === 'reopened' && target) this.send(KEY, 'office:term-manager-select', target.session);
    return how;
  }
}
