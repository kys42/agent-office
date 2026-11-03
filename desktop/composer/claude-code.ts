import { containsLines, mergeBackup } from './backup.js';
import { drawn, type Screen } from './screen.js';
import {
  holdsText,
  readyToType,
  type ClearResult,
  type ComposerAdapter,
  type ComposerHost,
  type ComposerState,
  type DraftSubmitOutcome,
} from './types.js';

export { drawn };

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

/** Placeholder ids as drawn: a collapsed paste, an image, a truncated input, a setup guide. */
const TOKEN_ID = /\[(?:Pastedtext|Image|\.\.\.Truncatedtext|✦Teamsetupguide)#(\d{1,10})/g;

/**
 * The ids of Claude Code's placeholders anywhere on screen (the box, Orca's `draft`, earlier turns
 * above): a collapsed paste, an image, a truncated input. Read as drawn, so a token wrapped over
 * rows still counts. Claude Code mints ids from one counter that only grows (2.1.316: `mint()`
 * after `advancePast` every id seen), so an id seen before a paste is never that paste's.
 */
export function placeholderIds(screen: string | Screen): Set<number> {
  const { text, composer } = asScreen(screen);
  const ids = new Set<number>();
  for (const m of drawn(`${text}\n${composer ?? ''}`).matchAll(TOKEN_ID)) ids.add(Number(m[1]));
  return ids;
}

/** A collapsed text paste as drawn: `[Pasted text #N]` or `[Pasted text #N +K lines]`. */
const COLLAPSED_DRAWN = /^\[Pastedtext#([1-9]\d{0,9})(?:\+([1-9]\d{0,9})lines)?\]$/;
/** Claude Code collapses a paste over this many characters even on one line (2.1.316: 800). */
const COLLAPSE_LENGTH = 800;

/**
 * `shown` (the box, or what follows the images in it) is exactly the one placeholder Claude Code
 * collapses `pasted` into, and nothing else. From the 2.1.316 bundle (the main prompt's paste
 * handler): line breaks become `\n`, tabs four spaces; K counts the line breaks (`\r\n|\r|\n`),
 * so 7 lines show `+6 lines`; a paste of more than 800 characters or more than min(rows − 10, 2)
 * line breaks collapses, and with K = 0 the placeholder is `[Pasted text #N]` (no `+0 lines`).
 * Input is shortened into `[...Truncated text #N …]` only past 10,000 characters (a send is at
 * most 4,000), so the paste stays one token: no part of it is left literal. `N` must be new (not
 * in `before`, read right before the paste), and the box holds no blank row: a line break typed
 * next to the paste would be someone else's.
 */
export function collapsedPaste(
  shown: string,
  pasted: string,
  before: ReadonlySet<number>,
): boolean {
  if (shown.split('\n').some((row) => !row.trim())) return false;
  const token = COLLAPSED_DRAWN.exec(drawn(shown));
  if (!token || before.has(Number(token[1]))) return false;
  const breaks = (pasted.match(/\r\n|\r|\n/g) ?? []).length;
  if (token[2] === undefined)
    return breaks === 0 && pasted.replaceAll('\t', '    ').length > COLLAPSE_LENGTH;
  return Number(token[2]) === breaks;
}

/**
 * The box's first row (the `❯` one) is blank while rows below hold text: a line break typed
 * ahead of them, which `readPrompt` does not keep (it takes the marker and the break after it).
 * Text reported apart (Orca's `draft`) keeps its own breaks.
 */
function blankMarkerRow(screen: Screen): boolean {
  const box = promptBox(screen);
  if (!box || screen.composer !== undefined) return false;
  return !box.lines[box.top + 1].replace(/^❯/, '').trim() && box.bottom - box.top > 2;
}

/**
 * The prompt holds exactly `text`. When the prompt was verified empty before typing, two
 * shapes also count: the one placeholder this very paste collapsed into (`collapsedPaste`: its
 * line count, an id not on screen in `before`, nothing else in the box), and (not `strict`) the
 * end of a long text when the box shows only its last rows (a pane too short for it, measured on
 * 2.1.296). `strict` accepts no shortened view: after a clearing that could only infer the box
 * was empty, a tail may sit next to whatever the keys could not reach. The placeholder needs no
 * such care — alone in the box, it is all there is — but without `before` it never counts.
 */
export function promptHolds(
  screen: string | Screen,
  text: string,
  strict = false,
  before?: ReadonlySet<number>,
): boolean {
  const typed = readPrompt(screen);
  if (typed === null) return false;
  const shown = drawn(typed);
  if (shown === drawn(text)) return true;
  if (before && !blankMarkerRow(asScreen(screen)) && collapsedPaste(typed, text, before))
    return true;
  return !strict && shown.length >= 40 && drawn(text).endsWith(shown);
}

/** `[Image #N]` as drawn (spaces taken out). */
const IMAGE_DRAWN = /^\[Image#([1-9]\d{0,9})\]/;

/**
 * What the prompt shows after `paths` were pasted, one image per path, in order: each one as
 * Claude Code's own `[Image #N]` (it reads a pasted path to an image file and attaches it), or
 * the path itself when it did not (a read it refused, an older version): then the agent gets the
 * path as text. Ids are Claude's own counter: any, but never the same twice. Returns the rest of
 * the prompt as drawn, or null when it does not start with exactly that. Measured in the
 * bundle of 2.1.310: a paste is split at spaces before `/` and at line breaks; when every part
 * is a path ending in .png/.jpg/.jpeg/.gif/.webp, each readable image becomes `[Image #N]`
 * (consecutive ones joined by a space), and nothing else is inserted.
 */
export function afterImages(typed: string, paths: readonly string[]): string | null {
  return readImages(typed, paths)?.rest ?? null;
}

/** `afterImages`, and the path the last image stayed as when Claude did not attach it. */
export function readImages(
  typed: string,
  paths: readonly string[],
): { rest: string; lastPath: string | null } | null {
  let rest = drawn(typed);
  let lastPath: string | null = null;
  const seen = new Set<string>();
  for (const file of paths) {
    const image = IMAGE_DRAWN.exec(rest);
    if (image) {
      if (seen.has(image[1])) return null;
      seen.add(image[1]);
      rest = rest.slice(image[0].length);
      lastPath = null;
      continue;
    }
    const shown = drawn(file);
    if (!shown || !rest.startsWith(shown)) return null;
    rest = rest.slice(shown.length);
    lastPath = file;
  }
  return { rest, lastPath };
}

/**
 * A path left as text runs straight into whatever is pasted after it: the text then goes in
 * after a space (see terminals.ts), and the prompt must show that break — the file's name
 * followed by a space or a row break, as drawn. A name split over rows is not proven: no match.
 */
export function separatedAfter(typed: string, file: string): boolean {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const at = typed.lastIndexOf(name);
  return at >= 0 && /\s/.test(typed[at + name.length] ?? '');
}

/**
 * The prompt holds the pasted images (see `afterImages`) and then exactly `text` — or the one
 * placeholder the text's own paste collapsed into (`collapsedPaste`, `before` read once the
 * images were shown). An image-only send holds nothing more. Any other text, an image too many or
 * too few, a blank row, is no match. Unless `strict`, the end of a long text with the images
 * scrolled out of view counts as for `promptHolds`, since the images alone were verified first.
 */
export function promptHoldsImages(
  screen: string | Screen,
  text: string,
  paths: readonly string[],
  strict = false,
  before?: ReadonlySet<number>,
): boolean {
  const typed = readPrompt(screen);
  if (typed === null) return false;
  const read = readImages(typed, paths);
  const want = drawn(text);
  if (read !== null && (!want || !read.lastPath || separatedAfter(typed, read.lastPath))) {
    if (read.rest === want) return true;
    // A path left as text puts a space before the text's paste (see terminals.ts).
    const pasted = read.lastPath ? ` ${text}` : text;
    if (
      want &&
      before &&
      !blankMarkerRow(asScreen(screen)) &&
      !typed.split('\n').some((row) => !row.trim()) &&
      collapsedPaste(read.rest, pasted, before)
    )
      return true;
  }
  const shown = drawn(typed);
  return !strict && !!want && shown.length >= 40 && want.endsWith(shown);
}

/**
 * The most rows Claude Code's box shows before it scrolls, keeping only the end in view:
 * max(3, ⌊(pane height − 10) / 2⌋) — measured on 2.1.296 at heights 12–70 (3 rows up to height
 * 16, 5 at 20, 10 at 30, 15 at 40, 20 at 50, 30 at 70). Nothing marks a scrolled box, so a box at
 * this height may be hiding the start of its text. Only the fullscreen renderer caps the box
 * (2.1.309: `max(3, ⌊rows / 2⌋ − 5)`, a window centred on the cursor row, clamped to the text),
 * so with the cursor away from the end the rows below it are hidden too.
 */
export const maxBoxRows = (height: number) => Math.max(MIN_BOX_ROWS, Math.floor((height - 10) / 2));
/** The fewest rows a box capped by the fullscreen renderer shows (both formulas clamp to it). */
const MIN_BOX_ROWS = 3;
// Below height 12 the box's lower edge is cut off (measured at 8–11): no prompt is read there
// at all, and `wholeText` never counts one whole.

/**
 * Placeholders for content the box does not show: a collapsed paste, an attached image, the
 * middle of a very long input.
 */
const PLACEHOLDER =
  /\[(?:Pasted text #\d+[^\]]*|Image #\d+[^\]]*|\.\.\.Truncated text #\d+[^\]]*)\]/;
/** The task list's own hint below the box. */
const TASKS = /ctrl\+t to (?:hide|show) tasks/i;
/** Task rows right above the box (☐ pending, ◼ in progress, ✔ done). */
const hasTaskList = (box: PromptBox) =>
  box.lines.slice(Math.max(0, box.top - 30), box.top).some((line) => /^\s*[☐☒◻◼✔]\s/.test(line));

/** Cells a text takes at most: every character but ASCII counted wide. */
const widest = (text: string) =>
  [...text].reduce((sum, char) => sum + (char.charCodeAt(0) < 0x7f ? 1 : 2), 0);

/**
 * All of the composer's text is known. tmux: the box is shorter than the most it shows (needs
 * the pane height). Orca reports the composer apart, but only what the box shows (measured:
 * 1.4.216 gave the last 1,694 of 2,499 characters) and not the pane height, so only text that
 * surely fits in fewer rows than any box shows (2, at the widest count and leaving room for
 * word wrap) is known whole. Text Orca draws on the prompt line (no styles) goes by the same rule.
 */
function wholeText(screen: Screen, box: PromptBox, text: string): boolean {
  // A collapsed paste or an attached image stands for content that is not on screen.
  if (PLACEHOLDER.test(text)) return false;
  const rows = box.bottom - box.top - 1;
  // The task list (ctrl+t) takes rows of its own; how tall the box may grow beside it was not
  // measured. A capped box still shows at least MIN_BOX_ROWS rows (both renderers clamp to it),
  // so a box drawn in fewer rows, between its two rules, is never cut short: the list above it
  // changes nothing there (Orca leaves only the marker row when it reports the text apart).
  if (
    rows >= MIN_BOX_ROWS &&
    (TASKS.test(box.lines.slice(box.bottom + 1).join(' ')) || hasTaskList(box))
  )
    return false;
  // tmux: the box's rows against the pane. Orca (styles never read) draws a short box whole.
  if (screen.faint) {
    // Claude Code's default (inline) renderer, on the main screen, never caps the box: with
    // both of its rules on screen every row is in view (2.1.309 passes `maxVisibleLines` to
    // the prompt only in fullscreen, which draws on the alternate screen). `alternate` is set
    // only when tmux would show the alternate screen at all (see Screen.alternate).
    if (screen.alternate === false) return true;
    return screen.height !== undefined && screen.height >= 12 && rows < maxBoxRows(screen.height);
  }
  const width = Math.max(...box.lines.slice(box.top, box.bottom + 1).map((line) => line.length));
  const room = width - 20;
  if (room < 10) return false;
  const needed = text
    .split('\n')
    .reduce((sum, line) => sum + Math.max(1, Math.ceil((widest(line) + 2) / room)), 0);
  return needed <= 2;
}

/**
 * A placeholder in Claude Code's exact form (2.1.316's `_qr`, the team setup guide aside): a
 * collapsed paste, an attached image, a truncated input. Only a paste or an attachment makes one;
 * the suggestion Claude offers is text it wrote, never one of these.
 */
const PASTE_TOKEN =
  /\[(?:Pasted text #[1-9]\d{0,9}(?: \+[1-9]\d{0,9} lines)?|Image #[1-9]\d{0,9}|\.\.\.Truncated text #[1-9]\d{0,9} \+\d{1,10} lines\.\.\.)\]/;

/**
 * Text read with no styles (Orca): a suggestion reads like typing, so it is `unknown` — unless it
 * holds a placeholder, which only a paste or an attachment puts there: a `draft`, shown in part.
 */
const plainKind = (text: string): 'draft' | 'unknown' =>
  PASTE_TOKEN.test(text) ? 'draft' : 'unknown';

/**
 * The composer's state from one screen. Claude Code draws its prompt suggestion (offered after
 * a reply) and the empty-box examples faint (SGR 2) right after `❯ `, with the cursor at the
 * start of the box; typed and pasted text is drawn plain, the cursor after it (measured on
 * 2.1.296 in tmux, `capture-pane -e`). Empty means exactly that: one blank row, or (tmux) only
 * faint text, or (Orca) no `draft` with a blank row or an example. Blank rows above one another
 * are typed line breaks: a draft. Without styles a suggestion reads like a draft, so text there
 * is `unknown`.
 */
export function classifyPrompt(screen: Screen): ComposerState {
  const box = promptBox(screen);
  if (!box) return { kind: 'closed' };
  const text = box.typed;
  const rows = box.bottom - box.top - 1;
  const whole = (shown: string) => wholeText(screen, box, shown);
  if (screen.composer !== undefined) {
    // Orca's `draft` holds only what sits in the box (the examples stay on screen): any text
    // there may be typed, even text that reads like an example. It is the text itself, not
    // rows of the box (as `ownText` in terminals.ts relies on too).
    if (screen.composer) {
      const known = whole(text);
      return {
        kind: plainKind(text),
        text,
        whole: known,
        rows: text,
        ...(known && { logical: text }),
      };
    }
    const shown = box.lines[box.top + 1].replace(/^❯\s?/, '').trim();
    return rows === 1 && (!shown || HINT.test(shown))
      ? { kind: 'empty' }
      : { kind: plainKind(shown), text: shown, whole: whole(shown) };
  }
  // The rules span the box; a row of text takes at most that less the `❯ ` (or indent) before
  // it. Box-drawing dashes take one cell each. Rounded up: a doubtful row break counts as typed.
  const ruled = Math.max([...box.lines[box.top]].length, [...box.lines[box.bottom]].length) - 2;
  const width = ruled > 0 ? { width: ruled } : {};
  // The rows as drawn, indents kept; and as typed, when no row break on screen could be the
  // box's wrapping (and all of it shows).
  const asTyped = (shown: string) => {
    const lines = whole(shown) ? typedLines(box, ruled) : null;
    return { rows: boxRows(box).text, ...(lines !== null && { logical: lines }) };
  };
  if (!screen.faint) {
    if (rows === 1 && (!text.trim() || HINT.test(text))) return { kind: 'empty' };
    // Orca draws the suggestion on screen with no styles (1.4.216 keeps typed text apart, in
    // `draft`; an older one draws it here too): unknown, and a short one is known whole, so it
    // can be cleared — the deletion keys take typing, the one-letter probe tells a suggestion.
    return { kind: plainKind(text), text, whole: whole(text), ...width, ...asTyped(text) };
  }
  let faint = 0;
  let plain = 0;
  /** The first character drawn after the marker is the only plain one (the cursor's cell). */
  let cursorFirst = false;
  for (let row = box.top + 1; row < box.bottom; row++) {
    const line = box.lines[row];
    const flags = screen.faint[row] ?? [];
    // The marker's own style changes (grey while working); only what follows it counts.
    const from = row === box.top + 1 ? line.indexOf('❯') + 1 : 0;
    for (let i = from; i < line.length; i++)
      if (line[i].trim()) {
        if (flags[i]) faint++;
        else if (!plain++ && !faint && row === box.top + 1) cursorFirst = true;
        else cursorFirst = false;
      }
  }
  if (!plain && !faint)
    return rows === 1
      ? { kind: 'empty' }
      : { kind: 'draft', text, whole: whole(text), ...width, ...asTyped(text) };
  // With the terminal focused, Claude Code draws the cursor on the suggestion's first character
  // (2.1.316: `invert(t[0]) + dim(t.slice(1))`, or that character plain where the terminal's own
  // cursor is used): one plain character first, all the rest faint, on one row. Typed text is
  // never drawn faint, so a box like that holds nothing typed.
  if (plain && !(plain === 1 && cursorFirst && faint && rows === 1))
    return { kind: 'draft', text, whole: whole(text), ...width, ...asTyped(text) };
  if (HINT.test(text)) return { kind: 'empty' };
  // The suggestion is drawn on one row, cut short with `…` when it does not fit (2.1.316:
  // `wrap: "truncate-end"`); accepting takes all of it, not what shows.
  return { kind: 'suggestion', text, whole: rows === 1 && !/…$/.test(text) };
}

/** Margin under the rules' width: the box's padding is not measured, so a row is held full early. */
const WRAP_MARGIN = 4;

/**
 * The box's text as typed, from its rows as drawn — or null when that cannot be told for sure.
 * Claude Code draws the first row after `❯ ` and every other row after two spaces (measured,
 * 2.1.296), its own wrapping included, and nothing on screen marks a wrapped row (tmux's `-J`
 * joins only rows the terminal itself wrapped, never ones an app draws row by row). So a row
 * break counts as typed only where the next word could not have fitted on the row: the row,
 * a space and that word, counted at their widest (every non-ASCII character as two cells), take
 * fewer cells than the box offers less a margin. Any break that could be a wrap, a row not
 * drawn after the expected indent, or no width at all: null. Rows keep their indentation past
 * the box's own; only spaces at a row's end are lost (`lines` was trimmed there).
 */
export function typedLines(box: PromptBox, ruled: number): string | null {
  const room = ruled - 2 - WRAP_MARGIN;
  if (room < 10) return null;
  const { lines, aligned } = boxRows(box);
  if (!aligned) return null;
  for (let i = 0; i + 1 < lines.length; i++) {
    // Its first word with any spaces before it: a wrap may carry a space over to the next row.
    const next = /^\s*\S+/.exec(lines[i + 1]);
    if (!lines[i].trim() || !next) continue;
    if (widest(lines[i]) + 1 + widest(next[0]) > room) return null;
  }
  return lines.join('\n');
}

/**
 * The box's rows as drawn, whitespace kept: only the frame is taken off — the `❯ ` before the
 * first row and the box's own two-column indent before the others (`aligned`: every row had
 * exactly that). Unlike `text`, whose rows are trimmed, an indent added or taken out (Python,
 * YAML) is a different string here; spaces at a row's end are not on the screen read at all.
 */
export function boxRows(box: PromptBox): { text: string; lines: string[]; aligned: boolean } {
  let aligned = true;
  const lines = box.lines.slice(box.top + 1, box.bottom).map((row, i) => {
    if (i === 0) {
      const first = /^\s*❯(?:[ \u00a0](.*))?$/.exec(row);
      if (first) return first[1] ?? '';
      aligned = false;
      return row;
    }
    if (!row.trim()) return '';
    if (row.startsWith('  ')) return row.slice(2);
    aligned = false;
    return row;
  });
  return { text: lines.join('\n'), lines, aligned };
}

async function inspect(host: ComposerHost): Promise<ComposerState> {
  const screen = await host.read();
  return screen ? classifyPrompt(screen) : { kind: 'unreadable' };
}

/**
 * `now` is `original` with one stretch taken out (as drawn): what Ctrl+K·Ctrl+U pairs leave,
 * wherever the cursor was. Anything else (text added, two stretches gone) is someone typing.
 */
export function oneStretchGone(original: string, now: string): boolean {
  if (now.length >= original.length) return false;
  let head = 0;
  while (head < now.length && now[head] === original[head]) head++;
  let tail = 0;
  while (
    tail < now.length - head &&
    now[now.length - 1 - tail] === original[original.length - 1 - tail]
  )
    tail++;
  return head + tail === now.length;
}

/**
 * Text the deletion keys never touched (a suggestion not told by its style). One letter (`PROBE`)
 * is typed: the box holding just it means the text was the suggestion (typing replaced it), so
 * the letter is deleted and the box is ready. The text with the letter put in means typing
 * arrives but deletion does not (another key mode): it is taken back and nothing more is tried.
 * Anything else (no change, a vim normal mode moving the cursor, typing meanwhile) stops: the
 * letter is a cursor move in vim's normal mode, never an edit ('.' would repeat one).
 */
const PROBE = 'l';
async function probe(
  host: ComposerHost,
  from: ComposerState & { text: string },
  stuck: ComposerState,
  proceed?: () => Promise<boolean>,
): Promise<ClearResult> {
  const original = drawn(from.text);
  // Before every key, as in the clearing: still the same Claude, in front of its terminal.
  const lost: ClearResult = { status: 'failed', state: from, lost: true };
  if (proceed && !(await proceed())) return lost;
  await host.press([PROBE]);
  await host.wait(REDRAW_MS);
  const typed = await inspect(host);
  const shown = holdsText(typed) ? drawn(typed.text) : '';
  // Nothing changed (the keys never arrive, or a normal mode moved the cursor): even a draft
  // that is just the letter is not taken for a suggestion.
  if (shown === original) return { status: 'failed', state: stuck };
  if (shown === PROBE) {
    if (proceed && !(await proceed())) return lost;
    // The letter alone, the cursor after it: one Backspace takes it (and works where the
    // deletion pairs may not).
    await host.press(['BSpace']);
    await host.wait(REDRAW_MS);
    const after = await inspect(host);
    // The emptied box shows the suggestion again (or nothing).
    if (readyToType(after) || (holdsText(after) && drawn(after.text) === original))
      return { status: 'cleared', state: { kind: 'suggestion', text: from.text, inferred: true } };
    return { status: 'failed', state: after };
  }
  // Typing arrives, deletion does not: the letter went in at the cursor, wherever that was.
  if (oneAdded(original, shown, PROBE)) {
    if (proceed && !(await proceed())) return lost;
    await host.press(['BSpace']);
    await host.wait(REDRAW_MS);
  }
  return { status: 'failed', state: stuck };
}

/** `now` is `original` with one `letter` put in somewhere. */
export function oneAdded(original: string, now: string, letter: string): boolean {
  if (now.length !== original.length + 1) return false;
  for (let i = 0; i < now.length; i++)
    if (now[i] === letter && now.slice(0, i) + now.slice(i + 1) === original) return true;
  return false;
}

/** Rounds of deletion before giving up, and how long the prompt gets to redraw. */
const CLEAR_ROUNDS = 60;
/**
 * A whole draft of n rows takes up to 2n−1 pairs (cursor at the end): the budget grows with it
 * (a whole box on the main screen may be as tall as the pane), up to a bound.
 */
const MAX_CLEAR_ROUNDS = 400;
const clearRounds = (text: string) =>
  Math.min(MAX_CLEAR_ROUNDS, Math.max(CLEAR_ROUNDS, 2 * text.split('\n').length + 20));
/** A box that hides rows is cleared row by row (Ctrl+U takes one wrapped row): more rounds. */
const PARTIAL_ROUNDS = 150;
const REDRAW_MS = 120;

/**
 * The box looks empty (`state`): one more Ctrl+K·Ctrl+U pair proves it. On a blank row the pair
 * deletes no character: Ctrl+K joins the next line, Ctrl+U the line break before — so text still
 * out of sight (rows above a box that showed one blank row, rows below the cursor) comes into
 * view instead of being lost. Text that shows up is `hidden`: it was never shown, nor saved.
 */
async function settle(
  host: ComposerHost,
  state: ComposerState,
  proceed?: () => Promise<boolean>,
): Promise<ClearResult> {
  if (proceed && !(await proceed())) return { status: 'failed', state, lost: true };
  await host.press(['C-k', 'C-u']);
  await host.wait(REDRAW_MS);
  const after = await inspect(host);
  if (readyToType(after)) return { status: 'cleared', state: after };
  if (holdsText(after)) return { status: 'changed', text: after.text, whole: false, hidden: true };
  return { status: 'failed', state: after };
}

/**
 * Claude Code in a terminal (tmux or Orca). Full drafts are backed up before the first key.
 * Partially hidden drafts use clearPartial only with explicit permission to lose hidden content. Each step is one
 * Ctrl+K·Ctrl+U pair (deletes the cursor's line, or the break next to it; with the cursor at the
 * end, n lines take 2n−1 steps); after each, the composer must be the confirmed text with one
 * stretch taken out, until it is empty. Esc is never used: mid-turn it interrupts the turn, and
 * twice on an empty prompt it opens rewind. Measured on 2.1.296 (tmux, and Orca 1.4.216).
 *
 * A suggestion comes back as soon as the box is empty, and keys never touch it. tmux shows it
 * faint. Orca (1.4.216, measured again) draws it plain on the prompt line, typed text kept apart
 * in `draft`; it was also seen in `draft` like typed text. A tmux suggestion with any character
 * not drawn faint reads as a draft as well (the likely cause of a reported tmux failure with a
 * Korean suggestion, "Claude 입력창을 비우지 못해", that Orca cleared). On either host, text the keys never move is
 * told by a one-letter probe, and text that is no part of the confirmed draft, shows up once that
 * is gone and survives two more pairs, is taken for it (`inferred`) — saved first, and the send
 * afterwards accepts only the exact typed text.
 */
export const claudeCodeComposer: ComposerAdapter = {
  agent: 'Claude',
  capabilities: (host) => ({
    delivery: 'terminal',
    canInspect: !!host,
    canDetectSuggestion: !!host?.styled,
    canClear: !!host,
    // A pasted image path becomes Claude Code's own `[Image #N]` (see afterImages).
    images: 'attach',
    // Its box is read on either host; Enter alone submits it (see submitDraft).
    canSubmitDraft: true,
    // tmux tells the suggestion by its style; Orca reads it like typing, so there only a one-line
    // text known whole goes this way, the accept key leaving typed text as it is.
    canSubmitSuggestion: true,
  }),
  inspect,
  submitDraft,
  submitSuggestion,
  async clear(host, from, backup, proceed, options): Promise<ClearResult> {
    if (!from.whole) {
      if (!options?.allowPartial) return { status: 'failed', state: from, partial: true };
      return clearPartial(host, from, backup, proceed);
    }
    const canTell = claudeCodeComposer.capabilities(host).canDetectSuggestion;
    const original = drawn(from.text);
    // Blank lines hold nothing worth keeping: the clipboard stays as it is.
    if (from.text.trim()) await backup(from.text);
    let previous = from.text;
    let unchanged = 0;
    let moved = false;
    /** Orca: text no part of the draft, maybe the suggestion back in the emptied box. */
    let stranger: string | null = null;
    const rounds = clearRounds(from.text);
    for (let round = 0; round < rounds; round++) {
      // Before every key: still the same Claude, in front of its terminal.
      if (proceed && !(await proceed())) return { status: 'failed', state: from, lost: true };
      await host.press(['C-k', 'C-u']);
      await host.wait(REDRAW_MS);
      const state = await inspect(host);
      if (readyToType(state)) {
        // The stranger was deleted after all: it was typing (saved), not the suggestion.
        if (stranger !== null) return { status: 'changed', text: stranger, whole: true };
        // tmux: proven empty with one more pair. (Orca draws its suggestion like typing, which
        // that pair could not tell from hidden text; a partial clearing settles there itself.)
        return host.styled ? settle(host, state, proceed) : { status: 'cleared', state };
      }
      if (!holdsText(state)) return { status: 'failed', state };
      // Text not known whole (someone typing a lot, a paste) is never probed: stop and ask.
      if (!state.whole) return { status: 'changed', text: state.text, whole: false };
      if (state.text === previous) {
        // Untouched. A stranger that stays is the suggestion; the draft itself gets a few tries
        // (blank lines take a step each without changing what is drawn).
        if (++unchanged >= 2 && stranger !== null)
          return {
            status: 'cleared',
            state: { kind: 'suggestion', text: stranger, inferred: true },
          };
        // Never moved at all: the suggestion (Orca draws it like typing; tmux too, when not all of
        // it is faint), or keys that never arrive. One character typed tells them apart.
        if (unchanged >= 2 && !moved && stranger === null) return probe(host, from, state, proceed);
        if (unchanged >= (moved ? 6 : 2)) return { status: 'failed', state };
        continue;
      }
      unchanged = 0;
      moved = true;
      const now = drawn(state.text);
      if (stranger === null && (oneStretchGone(original, now) || now === original)) {
        previous = state.text;
        continue;
      }
      // Something else. Where suggestions show faint, it can only be typing. On Orca it may be
      // the suggestion back in the emptied box — once, and nothing of the draft: saved first,
      // then it must stay untouched.
      if (canTell || stranger !== null || original.includes(now))
        return { status: 'changed', text: state.text, whole: state.whole };
      stranger = state.text;
      await backup(`${from.text}\n${state.text}`);
      previous = state.text;
    }
    return { status: 'failed', state: { kind: 'unknown', text: previous, whole: true } };
  },
};

/**
 * The composer's own text, submitted as it is: Enter only, while the box shows exactly what the
 * person saw in the preview, all of it. Read twice — once, then again after `proceed` (the same
 * Claude, open to input, in front of its terminal) right before the key — since a permission
 * prompt or menu may replace the box at any moment, and Enter there picks a choice. The box
 * itself rules out the rest: `!` shell mode changes its marker and completion lists, the agents
 * view and dialogs read as closed (`promptBox`). Text not known whole (a scrolled box, a
 * collapsed paste, an image) is never submitted: the person did not see all of what would go.
 */
async function submitDraft(
  host: ComposerHost,
  expected: string,
  proceed: () => Promise<boolean>,
): Promise<DraftSubmitOutcome> {
  let seen: ComposerState = { kind: 'unreadable' };
  const check = async (): Promise<DraftSubmitOutcome | null> => {
    const state = (seen = await inspect(host));
    if (state.kind === 'closed' || state.kind === 'unreadable')
      return { status: 'refused', reason: state.kind };
    // Exactly as previewed, indents and wrapping included (`rows`, untrimmed): an indent
    // changed there (Python, YAML) or a resized box re-wrapping is another text, shown again.
    if (!holdsText(state) || (state.rows ?? state.text) !== expected)
      return { status: 'changed', state };
    if (!state.whole) return { status: 'refused', reason: 'partial' };
    return null;
  };
  const first = await check();
  if (first) return first;
  if (!(await proceed())) return { status: 'refused', reason: 'lost' };
  const again = await check();
  if (again) return again;
  await host.submit();
  return { status: 'submitted', state: seen };
}

/** Reads after the accept key, for the box to show the suggestion taken in. */
const ACCEPT_READS = 3;

/**
 * The key that takes Claude Code's suggestion into the box. From the 2.1.316 bundle (the main
 * prompt's key handler): with the box empty, a suggestion shown and no agent view, Right (like
 * Tab) puts all of the suggestion in the box as typed text, the cursor after it, and submits
 * nothing. Unlike Tab, Right with text in the box does nothing but move the cursor (no binding in
 * the Chat or Global contexts, no completion), while Tab there runs completion: a partial
 * `/command`, or a file and agent search for the word before the cursor (`PQt`: `@…` or any run of
 * letters, digits, marks and `_-./\()[]~:` — so a Korean word too), opening a list when anything
 * matches, completing at once in shell mode. Enter on an empty box submits nothing
 * (`prompt_submit_empty`).
 */
const ACCEPT_KEY = 'Right';

/**
 * A box that may hold the agent's suggestion, submitted ([Send suggestion], or [Send as is] on
 * text a plain screen cannot tell from one): the accept key, then Enter as for [Send as is].
 * - tmux (styled): only while the box holds just `expected` as the suggestion, told by its
 *   style, all of it; after the key the box must hold exactly it as typed text.
 * - Orca (plain): one line, known whole, that the screen cannot tell from the suggestion. The key
 *   takes a suggestion in, and leaves typed text as it is (only the cursor moves): either way the
 *   box must still hold exactly `expected` afterwards, and Enter then sends exactly what the
 *   person saw.
 * Read twice before the key (the second right after `proceed`); after it, up to three reads for the
 * box to settle, then `submitDraft` reads twice more and presses Enter. Anything else stops with
 * nothing more pressed (`accepted` once the key went in).
 */
async function submitSuggestion(
  host: ComposerHost,
  expected: string,
  proceed: () => Promise<boolean>,
): Promise<DraftSubmitOutcome> {
  if (expected.includes('\n')) return { status: 'refused', reason: 'unsupported' };
  const exact = (state: ComposerState) =>
    holdsText(state) && state.text === expected && (state.rows ?? state.text) === expected;
  const check = async (): Promise<DraftSubmitOutcome | null> => {
    const state = await inspect(host);
    if (state.kind === 'closed' || state.kind === 'unreadable')
      return { status: 'refused', reason: state.kind };
    if (host.styled) {
      if (state.kind !== 'suggestion' || state.inferred || state.text !== expected)
        return { status: 'changed', state };
      if (!state.whole) return { status: 'refused', reason: 'partial' };
      return null;
    }
    // Plain: text the screen cannot tell from a suggestion, exactly as previewed.
    if (state.kind !== 'unknown' || !exact(state)) return { status: 'changed', state };
    if (!state.whole) return { status: 'refused', reason: 'partial' };
    return null;
  };
  const first = await check();
  if (first) return first;
  if (!(await proceed())) return { status: 'refused', reason: 'lost' };
  const again = await check();
  if (again) return again;
  await host.press([ACCEPT_KEY]);
  let state: ComposerState = { kind: 'unreadable' };
  for (let read = 0; read < ACCEPT_READS; read++) {
    await host.wait(REDRAW_MS);
    state = await inspect(host);
    // Not redrawn yet: the suggestion still shows as it was (a plain screen shows no change).
    if (!(host.styled && state.kind === 'suggestion' && state.text === expected)) break;
  }
  const taken = host.styled ? state.kind === 'draft' : holdsText(state);
  if (!taken || !exact(state) || !(state as { whole?: boolean }).whole)
    return state.kind === 'closed' || state.kind === 'unreadable'
      ? { status: 'refused', reason: state.kind, accepted: true }
      : { status: 'changed', state, accepted: true };
  const sent = await submitDraft(host, expected, proceed);
  return sent.status === 'submitted' ? sent : { ...sent, accepted: true };
}

/** Explicitly accepted loss of hidden content: collect readable fragments before each pair.
 * Nothing is sent until the composer is empty or its suggestion is verified. Once its whole
 * text fits again, the normal clearing path checks every remaining edit for concurrent typing.
 * A box that looks empty is proven so by one more pair (`settle`): a scrolled box may show only
 * one blank row while rows above or below it still hold the draft (the suspected cause of the
 * 2026-10-23 report: the reply went in next to the hidden rest, failed its check, and every
 * retry asked again).
 */
async function clearPartial(
  host: ComposerHost,
  from: Extract<ComposerState, { kind: 'draft' | 'unknown' }>,
  backup: (text: string) => Promise<void>,
  proceed?: () => Promise<boolean>,
): Promise<ClearResult> {
  let state: Extract<ComposerState, { kind: 'draft' | 'unknown' }> = from;
  let collected: string | undefined;
  let unchanged = 0;
  const keep = async (text: string) => {
    collected = mergeBackup(collected, text);
    await backup(collected);
  };
  /**
   * Text a settling pair brought into view, after a frame that looked empty. It is the accepted
   * draft (cleared like the rest) only when every line of it was seen and saved before; else it
   * may be someone typing during the redraw, which the permission to lose the hidden draft never
   * covered: saved, left alone and asked about (`changed`, hidden).
   */
  const more = async (result: ClearResult) => {
    if (result.status !== 'changed' || !result.hidden) return null;
    if (collected !== undefined && containsLines(collected, result.text))
      return { kind: 'draft', text: result.text, whole: false } as const;
    await keep(result.text);
    return null;
  };
  for (let round = 0; round < PARTIAL_ROUNDS; round++) {
    if (state.whole) {
      const result = await claudeCodeComposer.clear(host, state, keep, proceed);
      const rest = await more(result);
      if (!rest) return result;
      state = rest;
      unchanged = 0;
      continue;
    }
    if (state.text.trim()) await keep(state.text);
    if (proceed && !(await proceed())) return { status: 'failed', state, lost: true };
    await host.press(['C-k', 'C-u']);
    await host.wait(REDRAW_MS);
    const next = await inspect(host);
    if (readyToType(next)) {
      // One blank row may be all a scrolled box shows: never taken for empty unproven.
      const result = await settle(host, next, proceed);
      const rest = await more(result);
      if (!rest) return result;
      state = rest;
      unchanged = 0;
      continue;
    }
    if (!holdsText(next)) return { status: 'failed', state: next };
    unchanged = next.text === state.text ? unchanged + 1 : 0;
    if (unchanged >= 6) {
      if (!host.styled) return probe(host, state, next, proceed);
      return { status: 'failed', state: next };
    }
    state = next;
  }
  return { status: 'failed', state };
}
