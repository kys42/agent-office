import type { Screen } from './screen.js';
import {
  holdsText,
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

function promptBox(screen: string): PromptBox | null {
  const lines = screen.split('\n').map((line) => line.trimEnd());
  const bottom = lines.findLastIndex((line) => RULE.test(line));
  const top = lines.findLastIndex((line, i) => i < bottom && RULE.test(line));
  if (top < 0) return null;
  const box = lines.slice(top + 1, bottom);
  if (!/^❯(\s|$)/.test(box[0] ?? '')) return null;
  const typed = box
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
export function readPrompt(screen: string): string | null {
  return promptBox(screen)?.typed ?? null;
}

/**
 * The prompt holds exactly `text`, or the placeholder a long paste collapses into. The prompt
 * was empty before typing, so a long text the composer shows only the end of counts too.
 */
export function promptHolds(screen: string, text: string): boolean {
  const typed = readPrompt(screen);
  if (typed === null) return false;
  const shown = drawn(typed);
  return (
    shown === drawn(text) ||
    PASTED.test(typed) ||
    (shown.length >= 40 && drawn(text).endsWith(shown))
  );
}

/**
 * The composer's state from one screen. Claude Code draws its prompt suggestion (offered after
 * a reply) and the empty-box examples faint (SGR 2) right after `❯ `, with the cursor at the
 * start of the box; typed and pasted text is drawn plain, the cursor after it (measured on
 * 2.1.296 in tmux, `capture-pane -e`). Without styles (Orca) a suggestion reads exactly like a
 * draft, so any text there is `unknown`.
 */
export function classifyPrompt(screen: Screen): ComposerState {
  const box = promptBox(screen.text);
  if (!box) return { kind: 'closed' };
  const text = box.typed;
  if (!text || HINT.test(text)) return { kind: 'empty' };
  if (!screen.faint) return { kind: 'unknown', text };
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
  return plain === 0 && faint > 0 ? { kind: 'suggestion', text } : { kind: 'draft', text };
}

async function inspect(host: ComposerHost): Promise<ComposerState> {
  const screen = await host.read();
  return screen ? classifyPrompt(screen) : { kind: 'unreadable' };
}

/** Rounds of deletion keys before giving up, and how long the prompt gets to redraw. */
const CLEAR_ROUNDS = 6;
const REDRAW_MS = 150;
const MAX_PAIRS = 40;

/**
 * Claude Code in a terminal (tmux or Orca). Emptying uses Ctrl+K (delete to the end of the
 * line, or the line break there) and Ctrl+U (delete to the start, or the line break before):
 * one pair empties a line wherever the cursor is and joins the next, so a draft of n lines
 * needs about n pairs; a collapsed paste (`[Pasted text #N +k lines]`) goes in one. Extra keys
 * on an empty prompt do nothing. Esc is never used: mid-turn it interrupts the turn, and twice
 * on an empty prompt it opens rewind. A suggestion comes back as soon as the box is empty and
 * deletion keys never touch it. All measured on 2.1.296.
 */
export const claudeCodeComposer: ComposerAdapter = {
  agent: 'Claude',
  capabilities: (host) => ({
    needsComposerCheck: true,
    canDetectSuggestion: !!host?.styled,
    canClear: !!host,
  }),
  inspect,
  async clear(host: ComposerHost, from?: ComposerState) {
    let before = from ?? (await inspect(host));
    let unchanged = 0;
    for (let round = 0; round < CLEAR_ROUNDS; round++) {
      if (!holdsText(before)) return before;
      const pairs = Math.min(before.text.split('\n').length + 1, MAX_PAIRS);
      const keys: ComposerKey[] = [];
      for (let i = 0; i < pairs; i++) keys.push('C-k', 'C-u');
      await host.press(keys);
      await host.wait(REDRAW_MS);
      const after = await inspect(host);
      if (
        after.kind === before.kind &&
        holdsText(after) &&
        drawn(after.text) === drawn(before.text)
      ) {
        // Text the deletion keys cannot touch twice in a row is no typed text. A host that shows
        // styles already told a suggestion apart, so there it means the clearing failed; on a
        // plain screen it is the suggestion Claude puts back in the emptied box (typing will
        // replace it, and the prompt must then hold exactly the typed text before Enter).
        if (++unchanged >= 2)
          return host.styled ? after : { kind: 'suggestion', text: after.text, inferred: true };
      } else unchanged = 0;
      before = after;
    }
    return before;
  },
};
