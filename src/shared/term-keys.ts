/**
 * The in-app terminals' macOS keys (MiniShellPanel, TermPanel): what a Mac terminal sends for
 * the editing keys xterm.js 6 leaves alone, and the app shortcuts a terminal window keeps for
 * itself. Pure, so the panels only wire it up and tests can read it.
 */

/** The parts of a `KeyboardEvent` the mapping reads. */
export interface KeyLike {
  type?: string;
  key: string;
  code?: string;
  keyCode?: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

/** A key still being composed by an input method (Korean, Japanese…) belongs to the IME. */
export const composing = (e: KeyLike) => e.isComposing === true || e.keyCode === 229;

/**
 * The bytes a Mac terminal (Terminal.app, iTerm2 "Natural text editing") sends for an editing
 * key, or `null` to leave the key to xterm. xterm 6 sends Option+←/→ as `ESC[1;3D`/`ESC[1;3C`,
 * which neither zsh nor Claude Code's input box read as a word jump; readline's own keys are
 * understood everywhere.
 */
export function macTermKey(e: KeyLike): string | null {
  if (e.type !== undefined && e.type !== 'keydown') return null;
  if (composing(e) || e.ctrlKey || e.shiftKey) return null;
  // Exactly one of Option or Command: both together is someone else's shortcut.
  if (e.altKey === e.metaKey) return null;
  const option = e.altKey;
  switch (e.key) {
    case 'ArrowLeft':
      return option ? '\x1bb' : '\x01'; // backward-word · beginning-of-line
    case 'ArrowRight':
      return option ? '\x1bf' : '\x05'; // forward-word · end-of-line
    case 'Backspace':
      return option ? '\x1b\x7f' : '\x15'; // backward-kill-word · kill to line start
    case 'Delete':
      return option ? '\x1bd' : null; // kill-word
    default:
      return null;
  }
}

export type TermShortcut =
  'copy' | 'paste' | 'find' | 'select-all' | 'font-bigger' | 'font-smaller' | 'font-reset';

/**
 * A ⌘ shortcut the terminal window handles itself (never sent to the program). ⌘C with nothing
 * selected is still `copy`: the panel then does nothing, so it never becomes ^C.
 */
export function termShortcut(e: KeyLike): TermShortcut | null {
  if (e.type !== undefined && e.type !== 'keydown') return null;
  if (composing(e) || !e.metaKey || e.ctrlKey || e.altKey) return null;
  // Layout-independent where it matters: `code` is the physical key, `key` what it types.
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (!e.shiftKey) {
    if (key === 'c' || e.code === 'KeyC') return 'copy';
    if (key === 'v' || e.code === 'KeyV') return 'paste';
    if (key === 'f' || e.code === 'KeyF') return 'find';
    if (key === 'a' || e.code === 'KeyA') return 'select-all';
    if (key === '0' || e.code === 'Digit0') return 'font-reset';
    if (key === '-' || e.code === 'Minus') return 'font-smaller';
  }
  // ⌘= and ⌘+ (⇧= on most layouts) both make the text bigger.
  if (key === '=' || key === '+' || e.code === 'Equal') return 'font-bigger';
  return null;
}

/** Terminal font sizes, in CSS px. */
export const TERM_FONT = { min: 9, max: 28, default: 12 } as const;

export const clampFontSize = (n: unknown): number => {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return TERM_FONT.default;
  return Math.min(TERM_FONT.max, Math.max(TERM_FONT.min, Math.round(v)));
};

/** The size after a font shortcut (`font-reset` goes back to `base`, the saved default). */
export function nextFontSize(
  size: number,
  action: 'font-bigger' | 'font-smaller' | 'font-reset',
  base: number = TERM_FONT.default,
): number {
  if (action === 'font-reset') return clampFontSize(base);
  return clampFontSize(size + (action === 'font-bigger' ? 1 : -1));
}

/** One path as a single POSIX shell word: single-quoted, with `'` written as `'\''`. */
export const shellQuote = (path: string): string => `'${path.replaceAll("'", `'\\''`)}'`;

/** Dropped files as shell words, space-separated, with a trailing space to keep typing. */
export function shellQuotePaths(paths: readonly string[]): string {
  const words = paths.filter((p) => p.length > 0).map(shellQuote);
  return words.length ? `${words.join(' ')} ` : '';
}
