/**
 * The bytes of an escape sequence or UTF-8 character the output stream is in the middle of.
 * A snapshot cannot show half a sequence, and the live output after it starts mid-sequence
 * (`ESC[3` | `1mRED`), so a restored view must be fed these bytes first or it prints `1mRED`.
 * Orca keeps the same "pending escape tail" for the same reason.
 *
 * A small approximation of the VT500 parser's states: enough to know where a sequence starts
 * and whether it has ended, not to interpret it.
 */
const ESC = 0x1b;
const CAN = 0x18;
const SUB = 0x1a;
/** Longer unfinished strings (a huge OSC 52 paste) are not kept; the view then drops them. */
const MAX_TAIL_BYTES = 64 * 1024;

type State = 'ground' | 'utf8' | 'esc' | 'csi' | 'string' | 'string-esc';
/** `start`: a sequence begins at this byte; `restart`: it began at the previous byte (an ESC). */
type Step = 'none' | 'start' | 'restart' | 'continue' | 'end';

export class EscapeTail {
  private state: State = 'ground';
  private need = 0;
  private parts: Buffer[] = [];
  private size = 0;
  private overflow = false;

  /** Follows one chunk, in the order the emulator parses it. */
  push(chunk: Uint8Array) {
    let start = this.state === 'ground' ? -1 : 0;
    for (let i = 0; i < chunk.length; i++) {
      const step = this.step(chunk[i]);
      if (step === 'start') {
        this.clear();
        start = i;
      } else if (step === 'restart') {
        this.clear();
        // The byte after that ESC may already have finished the new sequence.
        if (this.state === 'ground') start = -1;
        else if (i > 0) start = i - 1;
        else {
          this.keep(Buffer.from([ESC]));
          start = 0;
        }
      } else if (step === 'end') {
        this.clear();
        start = -1;
      }
    }
    if (start >= 0) this.keep(Buffer.from(chunk.subarray(start)));
  }

  /** What a view restored from a snapshot taken now must be fed before the next chunk. */
  pending(): Buffer {
    if (this.state === 'ground' || this.overflow || this.size === 0) return Buffer.alloc(0);
    return this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
  }

  private keep(bytes: Buffer) {
    if (this.overflow) return;
    this.size += bytes.length;
    if (this.size > MAX_TAIL_BYTES) {
      this.overflow = true;
      this.parts = [];
      return;
    }
    this.parts.push(bytes);
  }

  private clear() {
    this.parts = [];
    this.size = 0;
    this.overflow = false;
  }

  private step(b: number): Step {
    switch (this.state) {
      case 'ground':
        if (b === ESC) return this.to('esc', 'start');
        if (b >= 0xc2 && b <= 0xf4) {
          this.need = b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : 1;
          return this.to('utf8', 'start');
        }
        return 'none';
      case 'utf8':
        if ((b & 0xc0) === 0x80) return --this.need === 0 ? this.to('ground', 'end') : 'continue';
        // Not a continuation byte: the character was cut short; this byte starts afresh.
        this.state = 'ground';
        return this.step(b) === 'none' ? 'end' : 'start';
      case 'esc':
        if (b === ESC) return 'start';
        if (b === CAN || b === SUB) return this.to('ground', 'end');
        if (b === 0x5b) return this.to('csi', 'continue');
        // OSC, DCS, SOS, PM, APC: strings ended by ST (or BEL for OSC).
        if (b === 0x5d || b === 0x50 || b === 0x58 || b === 0x5e || b === 0x5f) {
          return this.to('string', 'continue');
        }
        if (b >= 0x30 && b <= 0x7e) return this.to('ground', 'end');
        return 'continue';
      case 'csi':
        if (b === ESC) return this.to('esc', 'start');
        if (b === CAN || b === SUB || (b >= 0x40 && b <= 0x7e)) return this.to('ground', 'end');
        return 'continue';
      case 'string':
        if (b === 0x07 || b === CAN || b === SUB) return this.to('ground', 'end');
        if (b === ESC) return this.to('string-esc', 'continue');
        return 'continue';
      case 'string-esc':
        if (b === 0x5c) return this.to('ground', 'end');
        if (b === ESC) return this.to('esc', 'start');
        // The ESC ended the string and began a new escape sequence.
        this.state = 'esc';
        this.step(b);
        return 'restart';
    }
  }

  private to(state: State, step: Step): Step {
    this.state = state;
    return step;
  }
}
