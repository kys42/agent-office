import { containsLines, mergeBackup } from './backup.js';
import { drawn, type Screen } from './screen.js';
import {
  holdsText,
  readyToType,
  type ClearResult,
  type ComposerAdapter,
  type ComposerHost,
  type ComposerState,
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
 * The most rows Claude Code's box shows before it scrolls, keeping only the end in view:
 * max(3, ⌊(pane height − 10) / 2⌋) — measured on 2.1.296 at heights 12–70 (3 rows up to height
 * 16, 5 at 20, 10 at 30, 15 at 40, 20 at 50, 30 at 70). Nothing marks a scrolled box, so a box at
 * this height may be hiding the start of its text. Only the fullscreen renderer caps the box
 * (2.1.309: `max(3, ⌊rows / 2⌋ − 5)`, a window centred on the cursor row, clamped to the text),
 * so with the cursor away from the end the rows below it are hidden too.
 */
export const maxBoxRows = (height: number) => Math.max(3, Math.floor((height - 10) / 2));
// Below height 12 the box's lower edge is cut off (measured at 8–11): no prompt is read there
// at all, and `wholeText` never counts one whole.

/** Placeholders for content the box does not show: a collapsed paste, an attached image. */
const PLACEHOLDER = /\[(?:Pasted text #\d+[^\]]*|Image #\d+[^\]]*)\]/;
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
  // The task list (ctrl+t) takes rows of its own; the box's height there was not measured.
  if (TASKS.test(box.lines.slice(box.bottom + 1).join(' ')) || hasTaskList(box)) return false;
  const rows = box.bottom - box.top - 1;
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
    // there may be typed, even text that reads like an example.
    if (screen.composer) return { kind: 'unknown', text, whole: whole(text) };
    const shown = box.lines[box.top + 1].replace(/^❯\s?/, '').trim();
    return rows === 1 && (!shown || HINT.test(shown))
      ? { kind: 'empty' }
      : { kind: 'unknown', text: shown, whole: whole(shown) };
  }
  if (!screen.faint) {
    if (rows === 1 && (!text.trim() || HINT.test(text))) return { kind: 'empty' };
    // Orca draws the suggestion on screen with no styles (1.4.216 keeps typed text apart, in
    // `draft`; an older one draws it here too): unknown, and a short one is known whole, so it
    // can be cleared — the deletion keys take typing, the one-letter probe tells a suggestion.
    return { kind: 'unknown', text, whole: whole(text) };
  }
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
  if (!plain && !faint)
    return rows === 1 ? { kind: 'empty' } : { kind: 'draft', text, whole: whole(text) };
  if (plain) return { kind: 'draft', text, whole: whole(text) };
  return HINT.test(text) ? { kind: 'empty' } : { kind: 'suggestion', text };
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
  }),
  inspect,
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
    for (let round = 0; round < CLEAR_ROUNDS; round++) {
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
