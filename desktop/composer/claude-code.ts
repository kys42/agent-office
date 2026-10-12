import type { Screen } from './screen.js';
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
/** Equal as drawn: no spacing or wrapping, no invisible joiners and variation selectors. */
export const drawn = (value: string) => value.normalize('NFC').replace(/[\s​-‍⁠︎️]+/g, '');

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
  if (!screen.faint || screen.composer !== undefined)
    return HINT.test(text) ? { kind: 'empty' } : { kind: 'unknown', text };
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
  const screen = await host.read();
  return screen ? classifyPrompt(screen) : { kind: 'unreadable' };
}

/** Rounds of deletion keys before giving up, and how long the prompt gets to redraw. */
const CLEAR_ROUNDS = 60;
const REDRAW_MS = 120;

const rows = (text: string) => text.split('\n').map(drawn);

/**
 * `saved` with the part of `shown` it lacks put in front. A draft taller than the box shows
 * only its end; deleting from the end brings earlier rows into view, whose last rows are the
 * first rows already saved.
 */
function prepend(saved: string, shown: string): string {
  const head = shown.split('\n');
  const have = rows(saved);
  const show = head.map(drawn);
  for (let k = Math.min(show.length, have.length); k >= 1; k--)
    if (show.slice(-k).join('') === have.slice(0, k).join(''))
      return k === head.length ? saved : `${head.slice(0, -k).join('\n')}\n${saved}`;
  return `${shown}\n${saved}`;
}

/**
 * Claude Code in a terminal (tmux or Orca). Emptying uses Ctrl+K (delete to the end of the
 * line, or the line break there) and Ctrl+U (delete to the start, or the line break before).
 * With the cursor at the end, a draft of n lines takes 2n−1 Ctrl+U; a pair reaches the same
 * wherever the cursor is, and a collapsed paste (`[Pasted text #N +k lines]`) goes in one.
 * Extra keys on an empty prompt do nothing. Esc is never used: mid-turn it interrupts the turn,
 * and twice on an empty prompt it opens rewind. A suggestion comes back as soon as the box is
 * empty and deletion keys never touch it. All measured on 2.1.296 (tmux, and Orca 1.4.216 with
 * the same bytes).
 *
 * One pair per round, then the screen again: a pair deletes at most one line, so whatever it
 * can reach was on screen — and saved — before it is pressed. A box too short for the draft
 * shows only its end; earlier rows come into view as the end goes, and are saved first.
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
    let before: ComposerState = from;
    let previous = from.text;
    let unchanged = 0;
    let moved = false;
    for (let round = 0; round < CLEAR_ROUNDS; round++) {
      if (readyToType(before)) return { status: 'cleared', state: before, saved };
      if (!holdsText(before)) return { status: 'failed', state: before, saved };
      if (!drawn(saved).includes(drawn(before.text))) {
        // Text not saved yet. Starting like what was just there but going on differently:
        // someone is typing, so stop and show it. Otherwise earlier rows of a tall draft (or,
        // on a plain screen, the suggestion back in the emptied box): saved before deleting.
        const [first] = rows(before.text);
        if (first && first === rows(previous)[0])
          return { status: 'changed', text: before.text, saved };
        saved = prepend(saved, before.text);
        await backup(saved);
      }
      await host.press(['C-k', 'C-u']);
      await host.wait(REDRAW_MS);
      const after = await inspect(host);
      if (after.kind === before.kind && holdsText(after) && after.text === before.text) {
        // Untouched twice in a row. Where suggestions show as such, the keys failed. On a plain
        // screen it is Claude's suggestion back in the emptied box — only once the keys were
        // seen to delete (text that never moved may mean they never arrived), and never what
        // is left of the confirmed draft (blank lines take a round each to go).
        if (++unchanged >= 2 && !drawn(from.text).includes(drawn(after.text)))
          return !canTell && moved
            ? {
                status: 'cleared',
                state: { kind: 'suggestion', text: after.text, inferred: true },
                saved,
              }
            : { status: 'failed', state: after, saved };
        if (unchanged >= 6) return { status: 'failed', state: after, saved };
      } else {
        unchanged = 0;
        moved = true;
      }
      previous = before.text;
      before = after;
    }
    return { status: 'failed', state: before, saved };
  },
};
