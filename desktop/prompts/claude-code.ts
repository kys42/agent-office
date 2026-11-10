import os from 'node:os';
import path from 'node:path';
import type {
  DialogChoice,
  InputRequest,
  PromptSubject,
  QuestionAnswer,
  RequestQuestion,
} from '../../src/shared/types.js';
import { inputRequest } from '../../server/adapters/requests.js';
import { cells, drawn, type Screen } from '../composer/screen.js';
import { readPrompt } from '../composer/claude-code.js';
import { drawnMarkdown } from './claude-markdown.js';
import type {
  AnswerOutcome,
  Asked,
  Dialog,
  DialogRow,
  DialogState,
  Identified,
  OpenCall,
  PlanShows,
  PromptChoice,
  PromptHost,
  PromptKey,
  NoText,
} from './types.js';

/*
 * Claude Code's dialogs, as drawn by 2.1.296 (measured in tmux, docs/development/TERMINAL.md):
 *
 *   question   ─── rule ───            plan        ─── rule ───
 *              ←  ☐ Color  ☐ Size  ✔ Submit  →     Claude has written up a plan … proceed?
 *              Pick a color                         ❯ 1. Yes, and use auto mode
 *              ❯ 1. Red                               2. Yes, manually approve edits
 *                   description                       3. Tell Claude what to change
 *                2. Green                                shift+tab to approve with this feedback
 *                4. Type something.                 ctrl+g to edit in … · ~/.claude/plans/x.md
 *              ─── rule ───
 *                5. Chat about this    permission  ─── rule ───
 *              Enter to select · …                   Bash command / Create file
 *                                                    <command or file>
 *   review     Review your answers                   Do you want to proceed?
 *               ● Pick a color                       ❯ 1. Yes
 *                 → Green                              2. Yes, and don't ask again for …
 *              Ready to submit your answers?           3. No
 *              ❯ 1. Submit answers                   Esc to cancel · Tab to amend
 *                2. Cancel
 *
 * Keys (measured): ↑/↓ move the `❯` marker (wrapping at the ends, never needed here); Enter
 * picks the row (single-select: answers it and moves to the next question, or submits a lone
 * question, with an optional review in other TUI variants); Space toggles a multi-select row;
 * → moves to the next tab (the review after the
 * last); a text row takes typing as soon as the marker is on it. Never pressed here: digits
 * (pick *and* submit in one key), Tab (amends a permission's Yes into a text row), Esc (cancels
 * the whole tool call), Ctrl+C/D. "Cancel" ends the tool call: never used. "Chat about this"
 * ends it too, and is chosen only when the person asks for exactly that (`chat`, see below).
 *
 * The plan dialog of 2.1.316 (read from its bundle, ExitPlanMode's options builder): an optional
 * "Yes, clear context (N% used) and …" row, then one of "Yes, and switch to BYPASS PERMISSIONS
 * … for this session" / "Yes, and use auto mode" / "Yes, auto-accept edits", then always "Yes,
 * manually approve edits", then "No, keep planning" (a text row; hint "shift+tab to approve with
 * this feedback"). A plan too long to show withholds every Yes. Only "Yes, manually approve
 * edits" is offered here: every other Yes keeps applying (a mode) or clears the context. *
 * The preview layout of 2.1.322 (read from its bundle, AskUserQuestion's `uZ`): a single-select
 * question whose options carry `preview` (never a multi-select one) is drawn side by side, the
 * options in a column 30 cells wide, a 4-cell gap, then the preview box (`┌─┐ │ … │ └─┘`, cut
 * with `…` and `├─── ✂ ─── N lines hidden ─┤`) with `Notes:` under it. No description, no
 * "Type something." row: `n` types notes instead (sent with the answer). "Chat about this" sits
 * below the inner rule without a number:
 *
 *   ───────────────────────────────────────
 *   ←  ☐ Where  ☐ How  ☐ Branch  ✔ Submit  →
 *
 *   Where should the demo go?
 *
 *   ❯ 1. Add a page to the       ┌────────────┐
 *       catalog (Recommended)    │ preview    │
 *     2. Standalone demo         └────────────┘
 *
 *                                Notes: press n to add notes
 *
 *   ───────────────────────────────────────
 *     Chat about this
 *
 *   Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel
 *
 * Its keys: ↑/↓ move (↓ from the last option onto "Chat about this", ↑ back; no wrapping), Enter
 * picks the option (the next question, the review after the last, or straight to Claude for a
 * lone question), `n` opens the notes (every key then types), digits only move, Tab/→ and ←
 * switch questions (Tabs keybinding: tab, shift+tab, right, left). "Chat about this" (both
 * layouts) answers the call with a refusal whose feedback tells Claude "The user wants to clarify
 * these questions" with the answers and notes so far: the dialog closes and Claude asks what to
 * clarify; it takes no words itself. A tab chip shows `☒` once its question has an answer.
 *
 * Claude Code may also draw a plugin pane at the right of the screen, behind a `│` divider in
 * one column on every row: it is cut off before anything is read (`withoutSidePane`).
 */

/** A numbered row: `❯ 1. Red`, `  2. Green`, ` ❯ 1. Yes`, `   ❯ 1. Yes, and use auto mode`. */
const ROW = /^(\s*)(❯\s+)?(\d{1,2})\.\s+(.*)$/;
/** A horizontal rule, full width or indented (the plan dialog draws its own). */
const RULE = /^\s*─{8,}/;
/** The multi-select "Submit" row ("Next" when another question follows) has no number. */
const SUBMIT = /^\s*(❯)?\s*(?:Submit|Next)$/;
const CHECKBOX = /^\[([ ✔✓x])\]\s+(.*)$/;
/** The question's own text row ("Type something." / "Type something"), before anything is typed. */
const TYPE_HINT = /^Type something\.?$/;
/** The plan's text row: "Tell Claude what to change" (2.1.296), "No, keep planning" (2.1.316). */
const PLAN_TEXT_ROW = /^(?:Tell Claude what to change|No, keep planning)/i;
const PLAN_TEXT_HINT = /shift\+tab to approve with this feedback/i;
const indent = (line: string) => line.length - line.trimStart().length;
/** Lines of a question drawn with a left border (`│ `) read without it. */
const unborder = (line: string) => line.replace(/^\s*│\s?/, '');

/** Agent text as the dialog draws it: markdown marks and spacing never decide a match. */
const plain = (text: string) => drawn(text.replace(/[*_`#>|~]/g, ''));

interface Block {
  start: number;
  end: number;
  col: number;
}

/** The dialog's rows: the last run of numbered rows on screen, with their description lines. */
function rowBlock(lines: string[]): Block | null {
  // The last row sits right above the footer: look at the bottom few drawn lines only.
  let last = -1;
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < 10; i--) {
    if (!lines[i].trim()) continue;
    seen++;
    if (ROW.test(lines[i])) {
      last = i;
      break;
    }
  }
  if (last < 0) return null;
  const m = ROW.exec(lines[last])!;
  const col = m[1].length + (m[2]?.length ?? 0);
  let start = last;
  for (let i = last - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim() || RULE.test(line) || SUBMIT.test(line)) continue;
    const row = ROW.exec(line);
    if (row && row[1].length + (row[2]?.length ?? 0) === col) {
      start = i;
      continue;
    }
    if (indent(line) > col) continue;
    break;
  }
  let end = last;
  while (end + 1 < lines.length && (!lines[end + 1].trim() || indent(lines[end + 1]) > col)) end++;
  while (end > last && !lines[end].trim()) end--;
  return { start, end, col };
}

function parseRows(
  lines: string[],
  block: Block,
): { rows: DialogRow[]; submit?: { cursor: boolean } } {
  const rows: DialogRow[] = [];
  let submit: { cursor: boolean } | undefined;
  let aside = false;
  const width = Math.max(...lines.map((line) => line.length));
  for (let i = block.start; i <= block.end; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (RULE.test(line)) {
      // Rows below the inner rule ("Chat about this") are no answers.
      if (rows.length) aside = true;
      continue;
    }
    const s = SUBMIT.exec(line);
    if (s && indent(line.replace('❯', ' ')) > block.col) {
      submit = { cursor: !!s[1] };
      continue;
    }
    const m = ROW.exec(line);
    if (m && m[1].length + (m[2]?.length ?? 0) === block.col) {
      const box = CHECKBOX.exec(m[4]);
      rows.push({
        number: Number(m[3]),
        label: (box ? box[2] : m[4]).trim(),
        description: '',
        cursor: !!m[2],
        ...(box ? { checked: box[1] !== ' ' } : {}),
        ...(aside ? { aside: true } : {}),
      });
      continue;
    }
    const row = rows.at(-1);
    if (row) {
      row.description = row.description ? `${row.description}\n${line.trim()}` : line.trim();
      // A label cut at the pane's edge goes on without a space (a long path breaks mid-word).
      const cut = (lines[i - 1] ?? '').length >= width - 1;
      row.wrapped = `${row.wrapped ?? row.label}${cut ? '' : ' '}${line.trim()}`;
    }
  }
  return { rows, ...(submit ? { submit } : {}) };
}

/** Choice rows have no descriptions: what is under them is the rest of a long label. */
const unwrap = (row: DialogRow): DialogRow =>
  row.wrapped ? { ...row, label: row.wrapped, description: '' } : row;

const FENCE = /^\s*╌{8,}\s*$/;

/**
 * The first fenced block's text. A long line wraps at the fence's width behind a faint `│ `
 * border, mid-word when it must: a line that fills the width goes on without a break.
 */
function fenced(head: string[]): { before: string[]; text: string | null } {
  const open = head.findIndex((line) => FENCE.test(line));
  const close = open < 0 ? -1 : head.findIndex((line, i) => i > open && FENCE.test(line));
  if (open < 0 || close < 0) return { before: head, text: null };
  const width = head[open].length;
  let text = '';
  for (let i = open + 1; i < close; i++) {
    const content = head[i].replace(/^\s*(?:│\s?)?/, '');
    text += content;
    if (i < close - 1) text += head[i].length >= width - 1 ? '' : '\n';
  }
  return { before: head.slice(0, open), text };
}

/**
 * The plan as far as the screen shows it, from the lines above the question's rule. The plan
 * sits in a `╌` box under "Here is Claude's plan:". A plan taller than the screen is cut: the
 * fullscreen renderer (2.1.316: a scroll box sized to fit, at its top) shows its start and never
 * the closing `╌`; the main-screen renderer scrolls the terminal, leaving only the end and the
 * closing `╌`. With both edges gone nothing of the plan is read.
 */
function planOnScreen(above: string[]): { plan: string; shows: PlanShows } {
  const from = above.findLastIndex((line) => /Here is Claude's plan:/.test(line));
  const fences = above
    .map((line, i) => (i > from && FENCE.test(line) ? i : -1))
    .filter((i) => i >= 0);
  const text = (start: number, end: number) =>
    above
      .slice(start, end)
      .map((line) => line.trim())
      .join('\n')
      .trim();
  if (from >= 0 && fences.length >= 2)
    return { plan: text(fences[0] + 1, fences[1]), shows: 'all' };
  if (from >= 0 && fences.length === 1)
    return { plan: text(fences[0] + 1, above.length), shows: 'start' };
  if (from < 0 && fences.length === 1) return { plan: text(0, fences[0]), shows: 'end' };
  return { plan: '', shows: 'all' };
}

/**
 * The plan file the footer names (`ctrl+g to edit in … · ~/.claude/plans/<name>.md`). A narrow
 * pane wraps the footer, mid-path when it must: the path is read across its lines.
 */
function planFileIn(foot: string[]): string | undefined {
  return foot
    .join('\n')
    .split(/\s·\s/)
    .map((part) => part.replace(/\s+/g, ''))
    .findLast((part) => /^\S+\.md$/.test(part));
}

/** The question's tab bar (`←  ☐ A  ☒ B  ✔ Submit  →`, or a lone chip) and its text, from the head. */
function readHead(head: string[]): { tabs: { label: string; done: boolean }[]; question: string } {
  const bar = head.findIndex((line) => /^\s*←\s/.test(line) || /^\s*[☐☒]\s/.test(line));
  const tabs =
    bar < 0
      ? []
      : head[bar]
          .replace(/^\s*←/, '')
          .replace(/→\s*$/, '')
          .split(/\s{2,}/)
          .map((chip) => /^([☐☒])\s+(.+)$/.exec(chip.trim()))
          .filter((chip): chip is RegExpExecArray => !!chip)
          .map((chip) => ({ label: chip[2].trim(), done: chip[1] === '☒' }));
  const question = head
    .slice(bar + 1)
    .map(unborder)
    .join('\n')
    .trim();
  return { tabs, question };
}

/** The text before `width` cells, and the rest. */
function cutAt(line: string, width: number): [string, string] {
  let used = 0;
  let i = 0;
  for (const char of line) {
    const w = cells(char);
    if (used + w > width) break;
    used += w;
    i += char.length;
  }
  return [line.slice(0, i), line.slice(i)];
}

/** Where every `│` of a line is drawn, in cells. */
function barsOf(line: string): number[] {
  const at: number[] = [];
  let col = 0;
  for (const char of line) {
    if (char === '│') at.push(col);
    col += cells(char);
  }
  return at;
}

/** A plugin pane never sits closer to the left than this. */
const PANE_MIN = 40;
/**
 * A `│` drawn left of where it is: a character the terminal draws two cells wide that `cells`
 * counts as one (emoji such as ✅) shifts the rest of its line this far at most.
 */
const PANE_SLACK = 3;

/**
 * The screen without the plugin pane Claude Code may draw at its right (measured on 2.1.322 in
 * Orca: a `│` divider in one column on every row, another box to its right). The divider is the
 * column where most rows draw a `│`, at least PANE_MIN cells in; it must be on nearly every
 * non-blank row, the last ones included. Each row is cut at its own `│` in that column (or up to
 * PANE_SLACK cells left of it). A screen without such a column is returned as it is.
 */
export function withoutSidePane(lines: string[]): string[] {
  const bars = lines.map(barsOf);
  const count = new Map<number, number>();
  for (const at of bars)
    for (const col of new Set(at)) if (col >= PANE_MIN) count.set(col, (count.get(col) ?? 0) + 1);
  let divider = -1;
  for (const [col, n] of count) if (n > (count.get(divider) ?? 0)) divider = col;
  if (divider < 0) return lines;
  const filled = lines.map((line, i) => (line.trim() ? i : -1)).filter((i) => i >= 0);
  const near = (i: number) =>
    bars[i].filter((col) => col <= divider && col >= divider - PANE_SLACK).at(-1);
  const on = filled.filter((i) => near(i) !== undefined);
  if (filled.length < 5 || on.length < filled.length * 0.8) return lines;
  if (!filled.slice(-3).every((i) => near(i) !== undefined)) return lines;
  return lines.map((line, i) => {
    const col = near(i);
    return col === undefined ? line : cutAt(line, col)[0].trimEnd();
  });
}

/** The preview layout's notes line; its words stay at the column the preview box starts in. */
const NOTES = /^(\s+)Notes:(?:\s+(.*))?$/;
const NOTES_HINT = 'press n to add notes';
/** "Chat about this" without a number (preview layout), the marker on it when focused. */
const CHAT_PLAIN = /^\s*(❯)?\s*Chat about this$/;
/** An option row in the left column: the marker cell, ` N.`, ` label`. */
const PREVIEW_ROW = /^(❯| ) (\d{1,2})\. (.*)$/;
/** A row's right side: nothing, or the preview box (its corners, sides or the cut line). */
const BOX_SIDE = /^\s*(?:[┌│└├].*)?$/;

/**
 * A question drawn in the preview layout (see the comment at the top), or null when the screen
 * is not one. Only the left column is read (the preview is the agent's own and never compared),
 * a label wrapped in that column joined again. `unknown` when it looks like one but does not read
 * cleanly (something other than the box beside the options, a broken number sequence).
 */
function previewDialog(lines: string[], height?: number): DialogState | null {
  const chat = lines.findLastIndex((line) => CHAT_PLAIN.test(line));
  if (chat < 0) return null;
  const footer = lines
    .slice(chat + 1)
    .join(' ')
    .replace(/\s+/g, ' ');
  if (!/Enter to select/.test(footer) || !/add notes/.test(footer)) return null;
  const rule = lines.findLastIndex((line, i) => i < chat && !!line.trim());
  if (rule < 0 || !RULE.test(lines[rule])) return null;
  const notesAt = lines.findLastIndex((line, i) => i < rule && NOTES.test(line));
  if (notesAt < 0) return { kind: 'unknown' };
  const n = NOTES.exec(lines[notesAt])!;
  const column = n[1].length;
  // The notes may wrap under themselves, at their own column.
  const rest = lines.slice(notesAt + 1, rule).filter((line) => line.trim());
  if (rest.some((line) => indent(line) < column)) return { kind: 'unknown' };
  const noteText = [n[2] ?? '', ...rest.map((line) => line.trim())].join(' ').trim();
  const notes = noteText === NOTES_HINT ? '' : noteText;
  const top = lines.findLastIndex((line, i) => i < notesAt && /^─{8,}/.test(line));
  if (top < 0 || column < 10) return { kind: 'unknown' };
  const width = column - 4;
  // The options start on the row the preview box opens on.
  const start = lines.findIndex(
    (line, i) => i > top && i < notesAt && cutAt(line, width)[1].trimStart().startsWith('┌'),
  );
  if (start < 0) return { kind: 'unknown' };
  const rows: DialogRow[] = [];
  let prev = '';
  for (let i = start; i < notesAt; i++) {
    const [left, right] = cutAt(lines[i], width);
    if (!BOX_SIDE.test(right)) return { kind: 'unknown' };
    const text = left.trimEnd();
    const m = PREVIEW_ROW.exec(text);
    if (m) {
      rows.push({
        number: Number(m[2]),
        label: m[3].trim(),
        description: '',
        cursor: m[1] === '❯',
      });
    } else if (text.trim()) {
      const row = rows.at(-1);
      if (!row || indent(text) < 4) return { kind: 'unknown' };
      // Cut mid-word at the column's edge: no space was taken out there.
      row.label += (cells(prev) >= width - 1 ? '' : ' ') + text.trim();
    }
    prev = text;
  }
  if (!rows.length || rows.some((row, i) => row.number !== i + 1)) return { kind: 'unknown' };
  for (const row of rows) {
    // An option answered before (the dialog went back to it) carries a tick after its label.
    if (/\s✔$/.test(row.label)) {
      row.label = row.label.replace(/\s✔$/, '').trim();
      row.picked = true;
    }
  }
  const head = lines.slice(top + 1, start).filter((line) => line.trim());
  const { tabs, question } = readHead(head);
  if (!question) return { kind: 'unknown' };
  rows.push({
    number: rows.length + 1,
    label: 'Chat about this',
    description: '',
    cursor: !!CHAT_PLAIN.exec(lines[chat])![1],
    aside: true,
  });
  return {
    kind: 'question',
    tabs,
    question,
    multi: false,
    rows,
    layout: 'preview',
    notes,
    ...(height ? { height } : {}),
  };
}

/** What Claude Code's dialog on this screen asks, or why there is none. */
export function parseDialog(screen: Screen | null): DialogState {
  if (!screen) return { kind: 'unreadable' };
  if (!screen.text.trim()) return { kind: 'closed' };
  // A plugin pane beside the TUI is cut off first: its divider would hide the prompt's rules.
  const lines = withoutSidePane(screen.text.split('\n').map((line) => line.trimEnd()));
  // The main prompt open at the bottom: no dialog, whatever the output above shows.
  if (readPrompt(screen) !== null || readPrompt({ ...screen, text: lines.join('\n') }) !== null)
    return { kind: 'closed' };
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  const preview = previewDialog(lines, screen.height);
  if (preview) return preview;
  const block = rowBlock(lines);
  if (!block) return { kind: 'closed' };
  const top = lines.findLastIndex((line, i) => i < block.start && RULE.test(line));
  const head = lines.slice(top + 1, block.start).filter((line) => line.trim());
  const foot = lines.slice(block.end + 1).filter((line) => line.trim());
  const above = lines.slice(Math.max(0, top - 80), Math.max(0, top));
  const headText = head.join('\n');
  const footText = foot.join(' ');
  const { rows, submit } = parseRows(lines, block);
  if (!rows.length) return { kind: 'unknown' };
  if (/Ready to submit your answers?\?/i.test(headText)) {
    // `● question` then `→ answer`; a long question or answer wraps onto indented lines below
    // it (measured: a question wider than the pane went on under itself). A question with a line
    // break or wider than 80 columns (Korean text: about 40 characters) is drawn behind a left
    // gutter, as on the question screen (2.1.304: `needsGutter`):
    //    │ ● question…
    //    │   …rest of it
    //      → answer
    const answers: { question: string; answer: string }[] = [];
    let item: { question: string[]; answer: string[] | null } | null = null;
    const done = () => {
      if (item?.answer)
        answers.push({ question: item.question.join(' '), answer: item.answer.join(' ') });
      item = null;
    };
    // Only below its own title: a review taller than the pane must not read what is above it.
    const title = head.findIndex((line) => /^\s*Review your answers?\s*$/.test(line));
    for (const drawnLine of title < 0 ? [] : head.slice(title + 1)) {
      const line = unborder(drawnLine);
      // An empty line of a gutter is a blank line inside the question.
      if (!line.trim() && /^\s*│/.test(drawnLine)) continue;
      const q = /^\s*●\s+(.*)$/.exec(line);
      const a = /^\s*→\s+(.*)$/.exec(line);
      if (q) {
        done();
        item = { question: [q[1].trim()], answer: null };
      } else if (a && item && !item.answer) item.answer = [a[1].trim()];
      else if (item && /^\s{2,}\S/.test(line)) (item.answer ?? item.question).push(line.trim());
      else done();
    }
    done();
    return {
      kind: 'review',
      complete: !/You have not answered all questions/.test(headText),
      answers,
      rows,
    };
  }
  if (
    /ready\s+to\s+execute|Would\s+you\s+like\s+to\s+proceed\?/i.test(headText) &&
    (above.some((line) => /Here is Claude's plan:|Ready to code\?/.test(line)) ||
      /\.md\s*$/.test(footText))
  ) {
    const { plan, shows } = planOnScreen(above);
    const file = planFileIn(foot);
    return {
      kind: 'plan',
      plan,
      shows,
      ...(file ? { planFile: file } : {}),
      rows: rows.map((row) =>
        PLAN_TEXT_ROW.test(row.label) || PLAN_TEXT_HINT.test(row.description)
          ? { ...row, input: true }
          : unwrap(row),
      ),
    };
  }
  if (head.length >= 2 && /^\s*Do you want\b/.test(head.at(-1)!)) {
    const { before, text } = fenced(head.slice(0, -1));
    return {
      kind: 'permission',
      title: head[0].trim(),
      lines: before.slice(1).map((line) => unborder(line).trim()),
      fence: text,
      ask: head.at(-1)!.trim(),
      rows: rows.map((row) =>
        // Tab turns Yes/No into a text row ("…, and tell Claude what to do next/differently").
        /tell Claude what to do (?:next|differently)$/i.test(row.label)
          ? { ...row, input: true }
          : unwrap(row),
      ),
    };
  }
  if (/Enter to select/i.test(footText)) {
    const { tabs, question } = readHead(head);
    // The question's text row is the last one above the inner rule.
    const lastAnswer = rows.findLastIndex((row) => !row.aside);
    return {
      kind: 'question',
      tabs,
      question,
      multi: rows.some((row) => row.checked !== undefined),
      rows: rows.map((row, i) => (i === lastAnswer ? { ...row, input: true } : row)),
      ...(submit ? { submit } : {}),
      ...(screen.height ? { height: screen.height } : {}),
    };
  }
  return { kind: 'unknown' };
}

// ── Which open call the dialog asks about ──────────────────────────────────────────────────

/** Spacing never decides a match; every other character (shell punctuation too) does. */
const spaced = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The heading Claude Code draws for each tool it asks permission for (measured). */
const TITLES: Record<string, string> = {
  Bash: 'Bash command',
  Write: 'Create file',
  Edit: 'Edit file',
  MultiEdit: 'Edit file',
  WebFetch: 'Fetch',
};

/** What a permission dialog says the call does, read from the screen; null when unknown. */
export function subjectOf(d: Extract<Dialog, { kind: 'permission' }>): PromptSubject | null {
  const title = d.title;
  if (title === 'Bash command') return d.fence?.trim() ? { title, command: spaced(d.fence) } : null;
  if (title === 'Create file' || title === 'Edit file')
    return d.lines[0]?.trim() ? { title, path: d.lines[0].trim() } : null;
  if (title === 'Fetch') {
    const url = /^url:\s*(\S+)\s*$/m.exec(d.fence ?? '')?.[1];
    return url ? { title, url } : null;
  }
  return null;
}

const canonicalUrl = (value: unknown) => {
  try {
    return typeof value === 'string' ? new URL(value).href : null;
  } catch {
    return null;
  }
};

/** The paths a file dialog may show for `file`: as written, relative to the call's folder, or under ~. */
function shownPaths(file: string, cwd: string | undefined): string[] {
  const shown = [file];
  if (cwd && path.isAbsolute(file)) {
    const relative = path.relative(cwd, file);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) shown.push(relative);
  }
  const home = os.homedir();
  if (file.startsWith(home + path.sep)) shown.push('~' + file.slice(home.length));
  return shown;
}

/** The call does exactly what the screen says: same tool heading, same command, file or address. */
export function callShows(call: OpenCall, subject: PromptSubject): boolean {
  if (TITLES[call.tool] !== subject.title) return false;
  const input = call.input;
  if (subject.command !== undefined)
    return typeof input.command === 'string' && spaced(input.command) === subject.command;
  if (subject.path !== undefined)
    return (
      typeof input.file_path === 'string' &&
      shownPaths(input.file_path, call.cwd).includes(subject.path)
    );
  if (subject.url !== undefined) {
    const url = canonicalUrl(input.url);
    return !!url && url === canonicalUrl(subject.url);
  }
  return false;
}

/** The question the dialog shows, as an index into the request (or -1). */
function shownQuestion(
  d: Extract<Dialog, { kind: 'question' }>,
  r: Extract<InputRequest, { kind: 'question' }>,
) {
  return r.questions.findIndex((q) => plain(q.question) === plain(d.question));
}

/**
 * Claude Code draws a question side by side with its previews when it is single-select and an
 * option has one (2.1.322's `ayt`). A preview the record left out (`previewCut`) still counts.
 */
export const previewLayout = (q: RequestQuestion) =>
  !q.multiSelect && q.options.some((o) => o.preview !== undefined || !!o.previewCut);

/**
 * A tab chip shows this header: the same, or its start cut with `…` where the bar is too narrow
 * for every header (2.1.322's tab bar truncates each to its share of the width).
 */
function tabShows(label: string, header: string): boolean {
  if (plain(label) === plain(header)) return true;
  const cut = label.endsWith('…') ? plain(label.slice(0, -1)) : '';
  return cut.length > 0 && plain(header).startsWith(cut);
}

function questionMatches(
  d: Extract<Dialog, { kind: 'question' }>,
  r: Extract<InputRequest, { kind: 'question' }>,
): boolean {
  const index = shownQuestion(d, r);
  if (index < 0) return false;
  const q = r.questions[index];
  if (d.multi !== q.multiSelect) return false;
  // The layout follows the question: previews side by side, or the plain list.
  if ((d.layout === 'preview') !== previewLayout(q)) return false;
  const options = d.rows.filter((row) => !row.aside && !row.input);
  if (options.length !== q.options.length) return false;
  if (
    !options.every(
      (row, i) => row.number === i + 1 && plain(row.label) === plain(q.options[i].label),
    )
  )
    return false;
  if (d.tabs.length) {
    if (d.tabs.length !== r.questions.length) return false;
    if (
      !d.tabs.every(
        (tab, i) => !r.questions[i].header || tabShows(tab.label, r.questions[i].header!),
      )
    )
      return false;
  }
  return true;
}

/**
 * The dialog shows this plan: the same plan file when both name one, and the plan itself.
 * Everything the dialog shows must be the plan the call wrote, compared with its raw input (the
 * stored copy hides secret-like words the screen still shows): all of it when the whole box is
 * on screen, its start when the bottom is cut, its end when the top is cut (then the plan file
 * must be named on both sides too). A plan edited in the meantime (ctrl+g) never matches.
 * The plan is drawn as Claude Code renders its markdown (claude-markdown.ts); only spacing and
 * line wrapping are left out of the comparison, every other character counts.
 */
function plans(
  d: Extract<Dialog, { kind: 'plan' }>,
  r: Extract<InputRequest, { kind: 'plan' }>,
  call?: OpenCall,
): boolean {
  const raw = call?.input ?? {};
  const file =
    typeof raw.planFilePath === 'string' && raw.planFilePath.trim()
      ? raw.planFilePath.trim()
      : r.planFile;
  if (file && d.planFile && path.basename(file) !== path.basename(d.planFile)) return false;
  const shown = drawn(d.plan);
  if (d.shows === 'end' && !(file && d.planFile)) return false;
  return drawnMarkdown(typeof raw.plan === 'string' ? raw.plan : r.plan).some(
    (want) =>
      !!shown &&
      shown.length >= Math.min(8, want.length) &&
      (d.shows === 'start'
        ? want.startsWith(shown)
        : d.shows === 'end'
          ? want.endsWith(shown)
          : want === shown),
  );
}

/** The dialog asks this request: a question (or its review) or this plan. */
function asks(d: Dialog, r: InputRequest, call?: OpenCall): boolean {
  if (r.kind === 'question') {
    if (d.kind === 'question') return questionMatches(d, r);
    if (d.kind === 'review')
      return (
        d.answers.length > 0 &&
        d.answers.every((a) => r.questions.some((q) => plain(q.question) === plain(a.question)))
      );
    return false;
  }
  if (r.kind === 'plan') return d.kind === 'plan' && plans(d, r, call);
  return false;
}

/** The dialog still asks what was identified (re-read before and after every key). */
function stillAsks(d: Dialog, asked: Asked): boolean {
  if (asked.request.kind !== 'permission') return asks(d, asked.request, asked.call);
  if (d.kind !== 'permission' || !asked.subject) return false;
  const subject = subjectOf(d);
  return (
    !!subject &&
    subject.title === asked.subject.title &&
    subject.command === asked.subject.command &&
    subject.path === asked.subject.path &&
    subject.url === asked.subject.url &&
    callShows(asked.call, subject)
  );
}

function identify(d: Dialog, calls: readonly OpenCall[]): Identified {
  const found: Asked[] = [];
  if (d.kind === 'permission') {
    const subject = subjectOf(d);
    if (!subject) return { status: 'none' };
    for (const call of calls)
      if (callShows(call, subject))
        found.push({ call, request: { kind: 'permission', tool: call.tool }, subject });
  } else
    for (const call of calls) {
      if (!/^(?:AskUserQuestion|ExitPlanMode)$/.test(call.tool)) continue;
      const request = inputRequest(call.tool, call.input);
      // A request a cap cut cannot be compared whole: never answered from here.
      if (!request || request.kind === 'permission' || request.truncated) continue;
      if (asks(d, request, call)) found.push({ call, request });
    }
  if (found.length === 1) return { status: 'one', asked: found[0] };
  return { status: found.length ? 'many' : 'none' };
}

/**
 * One-shot choices only: allow this once, deny, or approve a plan with every edit still asked.
 * Anything that keeps applying (always allow, don't ask again, switch to auto mode or accept
 * edits, bypass) or that is not known is left to the terminal.
 */
function roleOf(d: Dialog, row: DialogRow): DialogChoice['role'] | null {
  if (row.input || row.aside) return null;
  if (d.kind === 'permission') {
    if (row.label === 'Yes') return 'allow';
    // WebFetch's plain No reads "No, and tell Claude what to do differently (esc)" (measured).
    if (row.label === 'No' || row.label === 'No, and tell Claude what to do differently (esc)')
      return 'deny';
  }
  if (d.kind === 'plan' && row.label === 'Yes, manually approve edits') return 'allow';
  return null;
}

function choices(d: Dialog): DialogChoice[] {
  if (d.kind !== 'plan' && d.kind !== 'permission') return [];
  return d.rows.flatMap((row) => {
    const role = roleOf(d, row);
    return role ? [{ number: row.number, label: row.label, role }] : [];
  });
}

const hasMore = (d: Dialog) =>
  (d.kind === 'plan' || d.kind === 'permission') &&
  d.rows.some((row) => !row.aside && !roleOf(d, row));

// ── Answering ────────────────────────────────────────────────────────────────────────────────

const STEP_MS = 120;
const TRIES = 4;

/** Stops of the `❯` marker, top to bottom: rows, then a multi-select's Submit, then asides. */
function stops(d: Dialog): (number | 'submit')[] {
  const main = d.rows.filter((row) => !row.aside).map((row) => row.number);
  const aside = d.rows.filter((row) => row.aside).map((row) => row.number);
  return [...main, ...(d.kind === 'question' && d.submit ? ['submit' as const] : []), ...aside];
}
/**
 * Where the marker is. On "Chat about this" the preview layout keeps drawing the option's marker
 * too (the option stays selected underneath): the aside row's marker wins.
 */
function cursorAt(d: Dialog): number | 'submit' | undefined {
  if (d.kind === 'question' && d.submit?.cursor) return 'submit';
  return (d.rows.find((row) => row.cursor && row.aside) ?? d.rows.find((row) => row.cursor))
    ?.number;
}
const row = (d: Dialog, n: number) => d.rows.find((r) => r.number === n && !r.aside);

/** The dialog's "Chat about this" row (numbered in the list layout, unnumbered beside previews). */
const CHAT_ROW = /^Chat about this$/;

class Refusal extends Error {
  constructor(readonly reason: Extract<AnswerOutcome, { status: 'refused' }>['reason']) {
    super(reason);
  }
}

const isDialog = (state: DialogState): state is Dialog =>
  ['question', 'review', 'plan', 'permission'].includes(state.kind);

/**
 * The flow one answer takes: every key is preceded by `proceed()` and a fresh look at the
 * screen, and followed by reading the screen until it shows what the key should have done.
 */
class Flow {
  pressed = false;
  constructor(
    private host: PromptHost,
    private asked: Asked,
    private proceed: () => Promise<boolean>,
  ) {}

  async read(): Promise<Dialog> {
    const state = parseDialog(await this.host.read());
    if (state.kind === 'unreadable') throw new Refusal('unreadable');
    if (!isDialog(state) || !stillAsks(state, this.asked)) throw new Refusal('changed');
    return state;
  }

  /** A lone choice may close immediately or open a review; neither warrants a blind Enter. */
  async afterSingleChoice(): Promise<'closed' | 'review' | 'unconfirmed'> {
    let last = new Refusal('unverified');
    let final: DialogState = { kind: 'unreadable' };
    for (let i = 0; i < TRIES; i++) {
      if (i) await this.host.wait(STEP_MS);
      const state = parseDialog(await this.host.read());
      final = state;
      if (state.kind === 'review' && stillAsks(state, this.asked)) return 'review';
      if (state.kind === 'unreadable') last = new Refusal('unreadable');
      else if (isDialog(state) && !stillAsks(state, this.asked)) throw new Refusal('changed');
    }
    if (final.kind === 'closed') return 'closed';
    if (final.kind === 'unreadable') return 'unconfirmed';
    throw last;
  }

  /** Reads until `ok` holds (the screen may lag a frame), else refuses. */
  async expect<T extends Dialog>(ok: (d: Dialog) => d is T): Promise<T>;
  async expect(ok: (d: Dialog) => boolean): Promise<Dialog>;
  async expect(ok: (d: Dialog) => boolean): Promise<Dialog> {
    let last: Refusal = new Refusal('unverified');
    for (let i = 0; i < TRIES; i++) {
      if (i) await this.host.wait(STEP_MS);
      try {
        const d = await this.read();
        if (ok(d)) return d;
        last = new Refusal('unverified');
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        last = e;
      }
    }
    throw last;
  }

  async press(keys: PromptKey[]) {
    if (!(await this.proceed())) throw new Refusal('lost');
    this.pressed = true;
    await this.host.press(keys);
  }

  /** Pastes words, right after the record, the foreground and the screen say where they go. */
  async type(text: string, check: (d: Dialog) => boolean) {
    if (!(await this.proceed())) throw new Refusal('lost');
    if (!check(await this.read())) throw new Refusal('unverified');
    this.pressed = true;
    await this.host.type(text);
  }

  /**
   * Moves the marker to `target` one row at a time: before every arrow the screen must still
   * be this dialog (`same`), and after it the marker must sit on the very next row.
   */
  async goTo(target: number | 'submit', same: (d: Dialog) => boolean): Promise<Dialog> {
    for (let step = 0; step < 40; step++) {
      const d = await this.expect(same);
      const order = stops(d);
      const from = order.indexOf(cursorAt(d) ?? -1);
      const to = order.indexOf(target);
      if (to < 0) throw new Refusal('bad-choice');
      if (from < 0) throw new Refusal('unverified');
      if (from === to) return d;
      const next = order[from + (to > from ? 1 : -1)];
      await this.press([to > from ? 'Down' : 'Up']);
      await this.expect((n) => same(n) && cursorAt(n) === next);
    }
    throw new Refusal('unverified');
  }

  /** Enter, right after the record, the foreground and the screen say it is still this choice. */
  async commit(check: (d: Dialog) => boolean) {
    if (!(await this.proceed())) throw new Refusal('lost');
    const d = await this.read();
    if (!check(d)) throw new Refusal('unverified');
    this.pressed = true;
    await this.host.press(['Enter']);
  }
}

/** One line of typed words, as the dialog's text row can hold it. */
const oneLine = (text: string) =>
  text
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Rows the review screen needs beyond two per question (measured layout, plus margin). */
const REVIEW_ROWS = 14;

async function answerQuestions(
  s: Flow,
  r: Extract<InputRequest, { kind: 'question' }>,
  answers: QuestionAnswer[],
): Promise<void> {
  if (answers.length !== r.questions.length) throw new Refusal('bad-choice');
  const qs = r.questions;
  // Before any key: questions or options that read the same could not be told apart on screen.
  const titles = qs.map((q) => plain(q.question));
  if (new Set(titles).size !== titles.length) throw new Refusal('ambiguous');
  for (const q of qs) {
    const labels = q.options.map((o) => plain(o.label));
    if (new Set(labels).size !== labels.length) throw new Refusal('ambiguous');
  }
  // Notes typed beside a preview go to Claude with the answer: never sent unseen from here, and
  // never typed from here either (the card says to add them in the terminal).
  const noNotes = (d: Extract<Dialog, { kind: 'question' }>) =>
    d.layout !== 'preview' || d.notes === '';
  const isQuestion =
    (index: number) =>
    (d: Dialog): d is Extract<Dialog, { kind: 'question' }> =>
      d.kind === 'question' && shownQuestion(d, r) === index && noNotes(d);
  // Answered here from the start only: a dialog already partly answered in the terminal is left
  // to the terminal (its picks are not this choice).
  const d = await s.read();
  if (d.kind === 'question' && !noNotes(d)) throw new Refusal('notes');
  if (d.kind !== 'question' || shownQuestion(d, r) !== 0 || !untouched(d))
    throw new Refusal('partial');
  // The review must fit the pane, or answers could scroll out of sight before it is checked.
  const reviewed = qs.length > 1 || qs[0].multiSelect;
  if (reviewed && d.height !== undefined && d.height < REVIEW_ROWS + 2 * qs.length)
    throw new Refusal('ambiguous');
  for (let qi = 0; qi < qs.length; qi++) {
    const q = qs[qi];
    const answer = answers[qi];
    const here = isQuestion(qi);
    // Arrived at this question with every one before it marked answered on its tab (`☒`).
    let shown = await s.expect(
      (next): next is Extract<Dialog, { kind: 'question' }> =>
        here(next) && (!next.tabs.length || next.tabs.slice(0, qi).every((tab) => tab.done)),
    );
    const lone = qs.length === 1 && !q.multiSelect;
    if ('other' in answer) {
      const text = oneLine(answer.other);
      if (!text || q.multiSelect) throw new Refusal('bad-choice');
      const input = shown.rows.find((row) => row.input && !row.aside);
      if (!input) throw new Refusal('bad-choice');
      await s.goTo(input.number, here);
      // Into the empty text row the marker is on, nothing else.
      await s.type(
        text,
        (next) =>
          here(next) &&
          cursorAt(next) === input.number &&
          TYPE_HINT.test(row(next, input.number)?.label ?? ''),
      );
      // Typed in the row and nothing else: then Enter answers with exactly these words.
      const holds = (next: Dialog) =>
        here(next) &&
        cursorAt(next) === input.number &&
        plain(row(next, input.number)?.label ?? '') === plain(text);
      await s.expect(holds);
      await s.commit(holds);
      if (lone && (await s.afterSingleChoice()) !== 'review') return;
      continue;
    }
    const picks = [...new Set(answer.options)].sort((a, b) => a - b);
    if (!picks.length || picks.some((i) => !Number.isInteger(i) || i < 0 || i >= q.options.length))
      throw new Refusal('bad-choice');
    if (!q.multiSelect) {
      if (picks.length !== 1) throw new Refusal('bad-choice');
      const target = picks[0] + 1;
      await s.goTo(target, here);
      await s.commit((next) => here(next) && cursorAt(next) === target);
      if (lone && (await s.afterSingleChoice()) !== 'review') return;
      continue;
    }
    // Multi-select: toggle each row that differs, verifying its box, then on to the next tab.
    for (let oi = 0; oi < q.options.length; oi++) {
      const want = picks.includes(oi);
      const target = oi + 1;
      if (!!row(shown, target)?.checked === want) continue;
      await s.goTo(target, here);
      await s.press(['Space']);
      shown = await s.expect(
        (next): next is typeof shown =>
          here(next) && cursorAt(next) === target && !!row(next, target)?.checked === want,
      );
    }
    const finalPicks = shown.rows
      .filter((r2) => !r2.aside && r2.checked)
      .map((r2) => r2.number - 1);
    if (finalPicks.join() !== picks.join()) throw new Refusal('unverified');
    await s.press(['Right']);
  }
  // The review lists every answer as the dialog will send it: it must be exactly the choice.
  // Several picks are joined with `, ` (toggled here top to bottom, so in option order), and a
  // label holding `, ` or `"` is drawn in JSON quotes (2.1.304).
  const listed = (labels: string[]) =>
    labels
      .map((label) => {
        const text = label.replace(/\s+/g, ' ').trim();
        return text.includes(', ') || text.includes('"') ? JSON.stringify(text) : text;
      })
      .join(', ');
  const expected = qs.map((q, qi) => {
    const a = answers[qi];
    if ('other' in a) return oneLine(a.other);
    const picked = [...new Set(a.options)].sort((x, y) => x - y).map((i) => q.options[i].label);
    return q.multiSelect ? listed(picked) : picked[0];
  });
  const fits = (d2: Dialog) =>
    d2.kind === 'review' &&
    d2.complete &&
    d2.answers.length === qs.length &&
    qs.every((q, qi) => {
      const a = d2.answers.filter((x) => plain(x.question) === plain(q.question));
      return a.length === 1 && plain(a[0].answer) === plain(expected[qi]);
    });
  const review = await s.expect((d2) => d2.kind === 'review');
  if (!fits(review)) throw new Refusal('unverified');
  const submit = review.rows.filter((r2) => /^Submit answers?$/i.test(r2.label));
  if (submit.length !== 1) throw new Refusal('unverified');
  await s.goTo(submit[0].number, fits);
  await s.commit((d2) => fits(d2) && cursorAt(d2) === submit[0].number);
}

/** Nothing chosen in the dialog yet: no tab answered, no row ticked, no words in its text row or notes. */
function untouched(d: Extract<Dialog, { kind: 'question' }>): boolean {
  if (d.tabs.some((tab) => tab.done) || d.rows.some((row) => row.checked || row.picked))
    return false;
  if (d.layout === 'preview') return d.notes === '';
  return d.rows.some((row) => row.input && TYPE_HINT.test(row.label));
}

/**
 * "Chat about this": the marker onto that row one arrow at a time, then Enter alone. Claude Code
 * then refuses the call with "The user wants to clarify these questions" and the answers so far
 * (none here: only an untouched dialog is left this way), and Claude asks what to clarify. The
 * row takes no words; the reply goes in the chat afterwards.
 */
async function answerChat(s: Flow, r: Extract<InputRequest, { kind: 'question' }>) {
  const d = await s.read();
  if (d.kind !== 'question') throw new Refusal('bad-choice');
  const chat = d.rows.filter((row) => row.aside && CHAT_ROW.test(row.label));
  if (chat.length !== 1) throw new Refusal('bad-choice');
  if (d.layout === 'preview' && d.notes) throw new Refusal('notes');
  if (!untouched(d)) throw new Refusal('partial');
  const index = shownQuestion(d, r);
  const target = chat[0].number;
  const same = (next: Dialog) =>
    next.kind === 'question' &&
    shownQuestion(next, r) === index &&
    untouched(next) &&
    next.rows.some((row) => row.number === target && row.aside && CHAT_ROW.test(row.label));
  await s.goTo(target, same);
  await s.commit((next) => same(next) && cursorAt(next) === target);
}

async function answerChoice(
  s: Flow,
  choice: Extract<PromptChoice, { kind: 'plan' | 'permission' }>,
) {
  const d = await s.read();
  const target = row(d, choice.number);
  // The choice the person saw: same number, same words, and a one-shot choice.
  if (!target || plain(target.label) !== plain(choice.label) || !roleOf(d, target))
    throw new Refusal('bad-choice');
  const same = (next: Dialog) => {
    const r2 = row(next, choice.number);
    return !!r2 && r2.label === target.label && !!roleOf(next, r2);
  };
  await s.goTo(choice.number, same);
  await s.commit((next) => same(next) && cursorAt(next) === choice.number);
}

/**
 * Per question, why typed words cannot go in from here: multi-select (never typed from the app),
 * the preview layout (notes instead of a text row: typed in the terminal), or no text row on the
 * list the screen shows. Questions not on screen are read from the request.
 */
function noText(d: Dialog, request: InputRequest): (NoText | null)[] {
  if (request.kind !== 'question') return [];
  return request.questions.map((q) => {
    if (q.multiSelect) return 'multi';
    if (previewLayout(q)) return 'preview';
    if (
      d.kind === 'question' &&
      d.layout !== 'preview' &&
      !d.rows.some((r2) => r2.input && !r2.aside && TYPE_HINT.test(r2.label))
    )
      return 'none';
    return null;
  });
}

/** Claude Code's dialogs without a live session: parsing, identifying and keys. */
export const claudeCodeDialogs = {
  agent: 'Claude',
  inspect: async (host: PromptHost): Promise<DialogState> => parseDialog(await host.read()),
  identify,
  choices,
  hasMore,
  takesText: (d: Dialog, request: InputRequest): boolean[] =>
    noText(d, request).map((why) => why === null),
  noText,
  chats: (d: Dialog) =>
    d.kind === 'question' && d.rows.some((row) => row.aside && CHAT_ROW.test(row.label)),
  async answer(
    host: PromptHost,
    asked: Asked,
    choice: PromptChoice,
    proceed: () => Promise<boolean>,
  ): Promise<AnswerOutcome> {
    const s = new Flow(host, asked, proceed);
    try {
      if (choice.kind === 'chat') {
        if (asked.request.kind !== 'question') throw new Refusal('bad-choice');
        await answerChat(s, asked.request);
        return { status: 'submitted' };
      }
      if (choice.kind !== asked.request.kind) throw new Refusal('bad-choice');
      if (choice.kind === 'question' && asked.request.kind === 'question')
        await answerQuestions(s, asked.request, choice.answers);
      else if (choice.kind !== 'question') await answerChoice(s, choice);
      return { status: 'submitted' };
    } catch (e) {
      if (e instanceof Refusal) return { status: 'refused', reason: e.reason, pressed: s.pressed };
      throw e;
    }
  },
};
