import type { Terminal } from '@xterm/headless';

/**
 * Terminal input modes a screen snapshot does not carry. Serializing the buffer restores what is
 * drawn, not how keys and the mouse must be encoded: a TUI that turned on bracketed paste, mouse
 * reporting or the kitty keyboard protocol breaks after a reattach unless the new view is told
 * again (Superset #541 and #4231; Orca's terminal-mode-rehydrate-sequences).
 *
 * xterm already follows most of these from the stream (`terminal.modes`); the rest are read off
 * its parser here, without consuming anything, so split escape sequences are handled for us.
 */
export interface TerminalModes {
  applicationCursorKeys: boolean;
  applicationKeypad: boolean;
  bracketedPaste: boolean;
  focusEvents: boolean;
  mouseTracking: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
  mouseEncoding: 'default' | 'utf8' | 'sgr' | 'urxvt' | 'sgr-pixels';
  cursorVisible: boolean;
  /** The kitty keyboard protocol's flags for the active screen (0: off). */
  kittyKeyboardFlags: number;
  alternateScreen: boolean;
  /** The program is between the begin and end of a synchronized update (mode 2026). */
  synchronizedOutput: boolean;
  insertMode: boolean;
  originMode: boolean;
  reverseWraparound: boolean;
  wraparound: boolean;
  /** Scroll margins (DECSTBM), 0-based and inclusive; null when they span the whole screen. */
  scrollRegion: { top: number; bottom: number } | null;
  /** Where the cursor is on the visible screen, 0-based. */
  cursor: { x: number; y: number };
}

type TerminalWithBuffer = Terminal & {
  // The scroll margins are not in xterm's public API; read the active buffer they live on.
  _core?: { buffer?: { scrollTop?: unknown; scrollBottom?: unknown } };
};

const MOUSE_ENCODINGS = {
  1005: 'utf8',
  1006: 'sgr',
  1015: 'urxvt',
  1016: 'sgr-pixels',
} as const;
const KITTY_STACK_LIMIT = 16;

type Screen = 'normal' | 'alternate';

/** Follows the modes xterm's public `modes` leaves out. One per headless terminal. */
export class ModeTracker {
  private mouseEncodings = new Set<keyof typeof MOUSE_ENCODINGS>();
  private cursorVisible = true;
  /** The kitty protocol keeps a separate flag stack per screen. */
  private kitty: Record<Screen, number[]> = { normal: [], alternate: [] };

  constructor(private readonly terminal: Terminal) {
    const parser = terminal.parser;
    // Returning false leaves the sequence to xterm's own handlers as well.
    parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => this.decset(params, true));
    parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => this.decset(params, false));
    parser.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => this.kittyPush(params));
    parser.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => this.kittyPop(params));
    parser.registerCsiHandler({ prefix: '=', final: 'u' }, (params) => this.kittySet(params));
    // RIS (ESC c) and DECSTR (CSI ! p) put the terminal back to its defaults.
    parser.registerEscHandler({ final: 'c' }, () => this.reset(true));
    parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => this.reset(false));
  }

  read(): TerminalModes {
    const m = this.terminal.modes;
    const encoding = [1016, 1015, 1006, 1005].find((n) =>
      this.mouseEncodings.has(n as keyof typeof MOUSE_ENCODINGS),
    ) as keyof typeof MOUSE_ENCODINGS | undefined;
    const stack = this.kitty[this.screen()];
    return {
      applicationCursorKeys: m.applicationCursorKeysMode,
      applicationKeypad: m.applicationKeypadMode,
      bracketedPaste: m.bracketedPasteMode,
      focusEvents: m.sendFocusMode,
      mouseTracking: m.mouseTrackingMode,
      mouseEncoding: encoding ? MOUSE_ENCODINGS[encoding] : 'default',
      cursorVisible: this.cursorVisible,
      kittyKeyboardFlags: stack.at(-1) ?? 0,
      alternateScreen: this.screen() === 'alternate',
      synchronizedOutput: m.synchronizedOutputMode,
      insertMode: m.insertMode,
      originMode: m.originMode,
      reverseWraparound: m.reverseWraparoundMode,
      wraparound: m.wraparoundMode,
      scrollRegion: this.scrollRegion(),
      cursor: { x: this.terminal.buffer.active.cursorX, y: this.terminal.buffer.active.cursorY },
    };
  }

  private scrollRegion() {
    const buffer = (this.terminal as TerminalWithBuffer)._core?.buffer;
    const top = buffer?.scrollTop;
    const bottom = buffer?.scrollBottom;
    if (typeof top !== 'number' || typeof bottom !== 'number') return null;
    if (top === 0 && bottom === this.terminal.rows - 1) return null;
    return { top, bottom };
  }

  private screen(): Screen {
    return this.terminal.buffer.active.type === 'alternate' ? 'alternate' : 'normal';
  }

  private decset(params: (number | number[])[], on: boolean) {
    for (const p of params) {
      if (p === 25) this.cursorVisible = on;
      else if (typeof p === 'number' && p in MOUSE_ENCODINGS) {
        const n = p as keyof typeof MOUSE_ENCODINGS;
        if (on) this.mouseEncodings.add(n);
        else this.mouseEncodings.delete(n);
      }
    }
    return false;
  }

  private kittyPush(params: (number | number[])[]) {
    const stack = this.kitty[this.screen()];
    stack.push(flagsParam(params[0]));
    if (stack.length > KITTY_STACK_LIMIT) stack.shift();
    return false;
  }

  private kittyPop(params: (number | number[])[]) {
    const n = typeof params[0] === 'number' && params[0] > 0 ? params[0] : 1;
    const stack = this.kitty[this.screen()];
    stack.splice(Math.max(0, stack.length - n));
    return false;
  }

  /** `CSI = flags ; mode u`: 1 sets, 2 adds, 3 removes the given flags on the current entry. */
  private kittySet(params: (number | number[])[]) {
    const stack = this.kitty[this.screen()];
    const flags = flagsParam(params[0]);
    const mode = typeof params[1] === 'number' && params[1] > 0 ? params[1] : 1;
    const current = stack.at(-1) ?? 0;
    const next = mode === 2 ? current | flags : mode === 3 ? current & ~flags : flags;
    if (stack.length === 0) stack.push(next);
    else stack[stack.length - 1] = next;
    return false;
  }

  private reset(hard: boolean) {
    this.cursorVisible = true;
    if (hard) {
      this.mouseEncodings.clear();
      this.kitty = { normal: [], alternate: [] };
    }
    return false;
  }
}

function flagsParam(p: number | number[] | undefined) {
  return typeof p === 'number' && p > 0 ? p & 0x1f : 0;
}

const MOUSE_TRACKING_SET = { none: '', x10: '9', vt200: '1000', drag: '1002', any: '1003' };
const MOUSE_ENCODING_SET = {
  default: '',
  utf8: '1005',
  sgr: '1006',
  urxvt: '1015',
  'sgr-pixels': '1016',
};

/**
 * Sequences that put a fresh terminal (all modes at their defaults) into `modes`. Written after
 * the snapshot: none of them changes what is drawn, and the snapshot's own alternate-screen
 * switch has already happened, so the kitty flags land on the right screen's stack.
 */
export function modeSequences(modes: TerminalModes): string {
  const set: string[] = [];
  if (modes.applicationCursorKeys) set.push('1');
  if (modes.originMode) set.push('6');
  if (modes.reverseWraparound) set.push('45');
  if (modes.applicationKeypad) set.push('66');
  if (modes.focusEvents) set.push('1004');
  if (modes.bracketedPaste) set.push('2004');
  const tracking = MOUSE_TRACKING_SET[modes.mouseTracking];
  if (tracking) set.push(tracking);
  const encoding = MOUSE_ENCODING_SET[modes.mouseEncoding];
  if (encoding) set.push(encoding);
  let out = set.length > 0 ? `\x1b[?${set.join(';')}h` : '';
  if (!modes.wraparound) out += '\x1b[?7l';
  if (!modes.cursorVisible) out += '\x1b[?25l';
  if (modes.insertMode) out += '\x1b[4h';
  if (modes.kittyKeyboardFlags > 0) out += `\x1b[=${modes.kittyKeyboardFlags};1u`;
  const region = modes.scrollRegion;
  if (region) out += `\x1b[${region.top + 1};${region.bottom + 1}r`;
  // Setting margins or origin mode homes the cursor: put it back where the snapshot left it
  // (relative to the top margin while origin mode is on).
  if (region || modes.originMode) {
    const row = modes.cursor.y - (modes.originMode && region ? region.top : 0) + 1;
    out += `\x1b[${row};${modes.cursor.x + 1}H`;
  }
  return out;
}
