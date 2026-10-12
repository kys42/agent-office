import { drawn, type Screen } from './screen.js';
import { containsLines } from './backup.js';

export { drawn };
import {
  holdsText,
  readyToType,
  type ClearResult,
  type ComposerAdapter,
  type ComposerHost,
  type ComposerKey,
  type ComposerState,
} from './types.js';

/** A box border: dashes, or dashes around a session title that may fill the pane. */
const RULE = /^─+(?: .* ─+)?$/;
/**
 * Footer hints of a screen where Enter goes elsewhere: dialogs and pickers, the agents view
 * ("enter to create · esc to clear"), the transcript, history search, and a prompt where Enter
 * would interrupt the turn. The main prompt's own hints ("esc to interrupt", "ctrl+t to hide
 * tasks", "shift+tab to cycle") are not among them.
 */
const FOOT =
  /do you want|esc to (?:cancel|clear|close|return)|\benter to\b|space to reply|ctrl\+o to toggle|search prompts:|no matching prompt/i;
/** What an empty prompt shows in place of text: examples, and queued-message help. */
export const HINT = /^(?:Try "[\s\S]*"|Press (?:up|Enter) to [\s\S]*)$/;
const PASTED = /^\[Pasted text #\d+[^\]]*\]$/;

interface PromptBox {
  lines: string[];
  /** Rows of the rules above and below the prompt. */
  top: number;
  bottom: number;
  typed: string;
}

const asScreen = (screen: string | Screen): Screen =>
  typeof screen === 'string' ? { text: screen } : screen;

function promptBox(screen: Screen): PromptBox | null {
  const lines = screen.text.split('\n').map((line) => line.trimEnd());
  const bottom = lines.findLastIndex((line) => RULE.test(line));
  const top = lines.findLastIndex((line, i) => i < bottom && RULE.test(line));
  if (top < 0) return null;
  const box = lines.slice(top + 1, bottom);
  if (!/^❯(\s|$)/.test(box[0] ?? '')) return null;
  // A host that reports the composer apart (Orca's `draft`) leaves only the marker on screen.
  const typed =
    screen.composer ??
    box
      .map((line) => line.trim())
      .join('\n')
      .replace(/^❯\s?/, '');
  // A slash command typed in full selects its own row: Enter then runs exactly that command.
  const command = /^\/\S+$/.test(typed) ? typed : null;
  // List rows are indented; queued messages and the person's turns sit at column 0.
  const picks = (line: string) => {
    const row = /^\s{2,}❯\s+(\S+)/.exec(line);
    return !!row && row[1] !== command;
  };
  const below = lines.slice(bottom + 1);
  // Joined, so a hint wrapped across rows in a narrow pane still reads whole.
  if (
    FOOT.test(below.join(' ').replace(/\s+/g, ' ')) ||
    below.some((line) => /^\s*❯/.test(line) && (!command || picks(` ${line}`)))
  )
    return null;
  // The list touching the box (rows, wrapped descriptions) up to a blank line; older output
  // that merely looks like a list is no list.
  const start = lines.slice(0, top).findLastIndex((line) => !line.trim());
  const list = lines.slice(Math.max(start + 1, top - 30), top);
  if (list.some((line) => /^\s{2,}◇\s/.test(line) || picks(line))) return null;
  return { lines, top, bottom, typed };
}

/**
 * What Claude Code's main prompt holds, read from the rendered screen: the last box, a `❯`
 * line between two rules, with nothing below that offers Enter to something else. A permission
 * prompt, plan approval or question replaces the box, `!` shell mode changes its marker, and
 * the agents view, menus and completion lists announce themselves around it; any of those is
 * `null` (closed). Measured on Claude Code 2.1.296.
 */
export function readPrompt(screen: string | Screen): string | null {
  return promptBox(asScreen(screen))?.typed ?? null;
}

/**
 * The prompt holds exactly `text`. When the prompt was verified empty before typing, two
 * shapes also count (both measured on 2.1.296): the placeholder a long paste collapses into
 * (`[Pasted text #N …]`: from 4 lines, or over 800 characters), and the end of a long text
 * when the box shows only its last rows (a pane too short for it). `strict` accepts the exact
 * text only: after clearing, whatever the keys could not reach must never pass as a match.
 */
export function promptHolds(screen: string | Screen, text: string, strict = false): boolean {
  const typed = readPrompt(screen);
  if (typed === null) return false;
  const shown = drawn(typed);
  if (shown === drawn(text)) return true;
  return !strict && (PASTED.test(typed) || (shown.length >= 40 && drawn(text).endsWith(shown)));
}

/**
 * The composer's state from one screen. Claude Code draws its prompt suggestion (offered after
 * a reply) and the empty-box examples faint (SGR 2) right after `❯ `, with the cursor at the
 * start of the box; typed and pasted text is drawn plain, the cursor after it (measured on
 * 2.1.296 in tmux, `capture-pane -e`). So on tmux plain text is a draft even when it reads like
 * an example (`Try "…"`). Without styles (Orca) a suggestion reads exactly like a draft (Orca's
 * `draft` holds it too), so any text there is `unknown`; the examples' wording alone still
 * marks an empty prompt there.
 */
export function classifyPrompt(screen: Screen): ComposerState {
  const box = promptBox(screen);
  if (!box) return { kind: 'closed' };
  const text = box.typed;
  if (!text.trim()) return { kind: 'empty' };
  // Orca's `draft` holds only what sits in the box (the examples stay on screen): any text
  // there may be typed, even text that reads like an example.
  if (screen.composer !== undefined) return { kind: 'unknown', text };
  if (!screen.faint) return HINT.test(text) ? { kind: 'empty' } : { kind: 'unknown', text };
  let faint = 0;
  let plain = 0;
  for (let row = box.top + 1; row < box.bottom; row++) {
    const line = box.lines[row];
    const flags = screen.faint[row] ?? [];
    // The marker's own style changes (grey while working); only what follows it counts.
    const from = row === box.top + 1 ? line.indexOf('❯') + 1 : 0;
    for (let i = from; i < line.length; i++)
      if (line[i].trim()) {
        if (flags[i]) faint++;
        else plain++;
      }
  }
  if (plain > 0 || faint === 0) return { kind: 'draft', text };
  return HINT.test(text) ? { kind: 'empty' } : { kind: 'suggestion', text };
}

async function inspect(host: ComposerHost): Promise<ComposerState> {
  return (await look(host)).state;
}

interface Look {
  state: ComposerState;
  /** The box's rows of text (marker and indent cut), when the box is on screen. */
  rows?: string[];
  /** The cursor's row among `rows` and its column within the row (cells). */
  cursor?: { row: number; col: number };
}

async function look(host: ComposerHost): Promise<Look> {
  const screen = await host.read();
  if (!screen) return { state: { kind: 'unreadable' } };
  const state = classifyPrompt(screen);
  const box = promptBox(screen);
  if (!box || screen.composer !== undefined) return { state };
  const rows = box.lines.slice(box.top + 1, box.bottom).map((line) => line.slice(2));
  const at = screen.cursor;
  const row = at ? at.y - (box.top + 1) : -1;
  return row >= 0 && row < rows.length && at!.x >= 2
    ? { state, rows, cursor: { row, col: at!.x - 2 } }
    : { state, rows };
}

/**
 * Cells a character takes. Wide (Hangul, CJK, fullwidth, emoji) is 2. Where it matters most —
 * the box's top row, whose start may be off screen — `cautious` counts every non-ASCII
 * character as 2, so fewer characters are ever taken for "left of the cursor".
 */
function cells(char: string, cautious: boolean): number {
  const code = char.codePointAt(0)!;
  if (code < 0x7f) return 1;
  if (cautious) return 2;
  if (/\p{Mn}|\p{Me}/u.test(char) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
    ? 2
    : 1;
}

/** How many characters of `row` sit left of column `col`. */
function leftOf(row: string, col: number, cautious: boolean): number {
  let used = 0;
  let count = 0;
  for (const char of row) {
    used += cells(char, cautious);
    if (used > col) break;
    count += char.length;
  }
  return count;
}

/**
 * One step of deletion and what the composer must look like after it. `tails`: after the step
 * the composer, as drawn, ends with one of these — whatever comes before is text that scrolled
 * into view at the top (a draft taller than the box) and goes to the backup first.
 */
interface Step {
  keys: ComposerKey[];
  tails: string[];
}

/**
 * With the cursor known (tmux): delete only what is on screen left of the cursor on its row —
 * Backspace once per character — and, below the top row, the break into the row above, which is
 * on screen too. At the start of the top row (text before it, if any, is off screen) Ctrl+K
 * deletes forward instead. Never a key that can reach text the box does not show.
 */
function stepAtCursor(rows: string[], cursor: { row: number; col: number }): Step | null {
  const { row, col } = cursor;
  const shown = rows[row] ?? '';
  // Spaces before the cursor at the end of a row are not drawn (a word-wrapped row ends in
  // one, measured): they are there all the same.
  const width = [...shown].reduce((sum, char) => sum + cells(char, row === 0), 0);
  const line = shown + ' '.repeat(Math.max(0, col - width));
  let count = leftOf(line, col, row === 0);
  if (!count && col > 0 && line) count = 1;
  const before = drawn(rows.slice(0, row).join(''));
  const after = drawn(line.slice(count) + rows.slice(row + 1).join(''));
  if (count && row === 0) return { keys: Array(count).fill('BSpace'), tails: [after] };
  if (row > 0)
    return {
      keys: Array(count + 1).fill('BSpace'),
      // The break was a line break (or a wrapped space), or the row above's last character.
      tails: [before + after, before.slice(0, -1) + after],
    };
  return line || rows.length > 1 ? { keys: ['C-k'], tails: [] } : null;
}

/** The part of `now` above what was expected to remain, or null when `now` is no such thing. */
function revealed(now: string, tails: string[]): string | null {
  for (const tail of tails) if (now.endsWith(tail)) return now.slice(0, now.length - tail.length);
  return null;
}

/** The first rows of `text` that make up `head` (as drawn): what scrolled into view. */
function headRows(text: string, head: string): string {
  const out: string[] = [];
  let left = head.length;
  for (const row of text.split('\n')) {
    if (left <= 0) break;
    const size = drawn(row).length;
    if (size <= left) out.push(row);
    else {
      // Cut inside the row, after `left` drawn characters.
      let seen = 0;
      let i = 0;
      for (; i < row.length && seen < left; i++) if (drawn(row[i])) seen++;
      out.push(row.slice(0, i));
    }
    left -= size;
  }
  return out.join('\n');
}

/** Rounds of deletion before giving up, and how long the prompt gets to redraw. */
const CLEAR_ROUNDS = 120;
const REDRAW_MS = 120;

/**
 * Claude Code in a terminal (tmux or Orca). Esc is never used: mid-turn it interrupts the turn,
 * and twice on an empty prompt it opens rewind. A suggestion comes back as soon as the box is
 * empty and deletion keys never touch it. Measured on 2.1.296 (tmux, and Orca 1.4.216).
 *
 * Every step deletes only text that was on screen, and so already backed up:
 * - tmux reports the cursor: Backspace once per character left of it on its row (plus the break
 *   into the row above, when there is one on screen), Ctrl+K at the start of the top row. A box
 *   too short for the draft shows its end; deleting there brings earlier rows into view at the
 *   top, and those go to the backup before the next step.
 * - Orca reports no cursor but hands the whole composer as `draft`: one Ctrl+K·Ctrl+U pair
 *   (deletes a line wherever the cursor is; with it at the end, n lines take 2n−1 steps), and
 *   the draft must only shrink.
 * Anything else showing up — text going on differently from what was there — is someone typing:
 * the clearing stops and the person is asked again.
 */
export const claudeCodeComposer: ComposerAdapter = {
  agent: 'Claude',
  capabilities: (host) => ({
    delivery: 'terminal',
    canInspect: !!host,
    canDetectSuggestion: !!host?.styled,
    canClear: !!host,
  }),
  inspect,
  async clear(host, from, backup): Promise<ClearResult> {
    const canTell = claudeCodeComposer.capabilities(host).canDetectSuggestion;
    let saved = from.text;
    await backup(saved);
    let current = await look(host);
    // Texts seen before the one now in the box: what the draft was made of.
    const seen: string[] = [from.text];
    let unchanged = 0;
    let identical = 0;
    let moved = false;
    if (holdsText(current.state) && drawn(current.state.text) !== drawn(from.text))
      return { status: 'changed', text: current.state.text, saved };
    for (let round = 0; round < CLEAR_ROUNDS; round++) {
      const state = current.state;
      if (readyToType(state)) return { status: 'cleared', state, saved };
      if (!holdsText(state)) return { status: 'failed', state, saved };
      const text = drawn(state.text);
      // On tmux the cursor must be in the box; without it (a host that cannot say) one pair.
      const step: Step | null = current.cursor
        ? stepAtCursor(current.rows!, current.cursor)
        : host.styled
          ? null
          : { keys: ['C-k', 'C-u'], tails: [] };
      if (!step) return { status: 'failed', state, saved };
      await host.press(step.keys);
      await host.wait(REDRAW_MS);
      const next = await look(host);
      const shown = next.state;
      if (!holdsText(shown)) {
        // Emptied (or a dialog took the screen): the next round decides.
        current = next;
        continue;
      }
      const now = drawn(shown.text);
      // Progress the step accounts for: `head` is what scrolled into view above what remains.
      let head: string | null;
      if (step.keys.length === 1 && step.keys[0] === 'C-k')
        // Deleted forward from the start of the top row: what is left is the end of before.
        head = text.endsWith(now) && now.length < text.length ? '' : null;
      else if (step.tails.length) head = revealed(now, step.tails);
      else if (shown.text === state.text) head = null;
      else {
        // Orca: the whole composer, deleted from the cursor's line, only shrinks. Text going on
        // from what was there is typing; anything else (the suggestion back in the emptied box)
        // is saved before the next step.
        let common = 0;
        while (common < now.length && now[common] === text[common]) common++;
        head = text.startsWith(now) ? '' : common > 0 ? null : now;
        if (head === null) return { status: 'changed', text: shown.text, saved };
      }
      // The same screen again. Accounted for only when rows repeat (one paragraph of the same
      // words): a row went, an equal one scrolled in. Taken whole, nothing moved.
      const same = shown.text === state.text;
      if (same && head === now) head = null;
      identical = same ? identical + 1 : 0;
      if (identical >= 20) return { status: 'failed', state: shown, saved };
      if (head === null && same) {
        // Untouched twice in a row. Where suggestions show as such, the keys failed. On a plain
        // screen it is Claude's suggestion back in the emptied box — only once the keys were
        // seen to delete (text that never moved may mean they never arrived), and never any
        // part of the draft text seen so far.
        if (++unchanged >= 2) {
          const draftPart = seen.some((earlier) => containsLines(earlier, shown.text));
          if (!canTell && moved && !draftPart)
            return {
              status: 'cleared',
              state: { kind: 'suggestion', text: shown.text, inferred: true },
              saved,
            };
          if (unchanged >= 6 || canTell) return { status: 'failed', state: shown, saved };
        }
        current = next;
        continue;
      }
      if (head === null) return { status: 'changed', text: shown.text, saved };
      unchanged = 0;
      moved = true;
      if (head) {
        saved = `${headRows(shown.text, head)}\n${saved}`;
        await backup(saved);
      }
      seen.push(state.text);
      current = next;
    }
    return { status: 'failed', state: current.state, saved };
  },
};
