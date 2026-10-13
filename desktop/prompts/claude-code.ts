import type { DialogChoice, InputRequest, QuestionAnswer } from '../../src/shared/types.js';
import { drawn, type Screen } from '../composer/screen.js';
import { readPrompt } from '../composer/claude-code.js';
import type {
  AnswerOutcome,
  Dialog,
  DialogRow,
  DialogState,
  PromptAdapter,
  PromptChoice,
  PromptHost,
  PromptKey,
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
 * Keys (measured): ↑/↓ move the `❯` marker without wrapping past the ends being needed; Enter
 * picks the row (single-select: answers it and moves to the next question, or submits a lone
 * question); Space toggles a multi-select row; → moves to the next tab (the review after the
 * last); a text row takes typing as soon as the marker is on it. Never pressed here: digits
 * (pick *and* submit in one key), Tab (amends a permission's Yes into a text row), Esc (cancels
 * the whole tool call), Ctrl+C/D. "Chat about this" and "Cancel" end the tool call: never used.
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
const PLAN_TEXT_ROW = /^Tell Claude what to change/i;
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

/** What Claude Code's dialog on this screen asks, or why there is none. */
export function parseDialog(screen: Screen | null): DialogState {
  if (!screen) return { kind: 'unreadable' };
  if (!screen.text.trim()) return { kind: 'closed' };
  // The main prompt open at the bottom: no dialog, whatever the output above shows.
  if (readPrompt(screen) !== null) return { kind: 'closed' };
  const lines = screen.text.split('\n').map((line) => line.trimEnd());
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
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
  if (/Ready to submit your answers\?/.test(headText)) {
    const answers: { question: string; answer: string }[] = [];
    for (let i = 0; i < head.length; i++) {
      const q = /^\s*●\s+(.*)$/.exec(head[i]);
      const a = q && /^\s*→\s+(.*)$/.exec(head[i + 1] ?? '');
      if (q && a) answers.push({ question: q[1].trim(), answer: a[1].trim() });
    }
    return {
      kind: 'review',
      complete: !/You have not answered all questions/.test(headText),
      answers,
      rows,
    };
  }
  if (
    /ready to execute|Would you like to proceed\?/i.test(headText) &&
    (above.some((line) => /Here is Claude's plan:|Ready to code\?/.test(line)) ||
      /\.md\s*$/.test(footText))
  ) {
    const from = above.findLastIndex((line) => /Here is Claude's plan:/.test(line));
    const fences = above
      .map((line, i) => (i > from && /^\s*╌{8,}/.test(line) ? i : -1))
      .filter((i) => i >= 0);
    const plan =
      from >= 0 && fences.length >= 2
        ? above
            .slice(fences[0] + 1, fences[1])
            .map((line) => line.trim())
            .join('\n')
            .trim()
        : '';
    const file = /(\S+\.md)\s*$/.exec(foot.at(-1) ?? '')?.[1];
    return {
      kind: 'plan',
      plan,
      ...(file ? { planFile: file } : {}),
      rows: rows.map((row) =>
        PLAN_TEXT_ROW.test(row.label) || PLAN_TEXT_HINT.test(row.description)
          ? { ...row, input: true }
          : unwrap(row),
      ),
    };
  }
  if (head.length && /^\s*Do you want\b/.test(head.at(-1)!)) {
    // A long command wraps behind a faint `│ ` border.
    const body = head
      .slice(1, -1)
      .filter((line) => !/^\s*╌{8,}\s*$/.test(line))
      .map((line) => unborder(line).trim())
      .join('\n');
    return {
      kind: 'permission',
      title: head[0].trim(),
      body,
      ask: head.at(-1)!.trim(),
      rows: rows.map((row) =>
        /tell Claude what to do/i.test(row.label) ? { ...row, input: true } : unwrap(row),
      ),
    };
  }
  if (/Enter to select/i.test(footText)) {
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
    // The question's text row is the last one above the inner rule.
    const lastAnswer = rows.findLastIndex((row) => !row.aside);
    return {
      kind: 'question',
      tabs,
      question,
      multi: rows.some((row) => row.checked !== undefined),
      rows: rows.map((row, i) => (i === lastAnswer ? { ...row, input: true } : row)),
      ...(submit ? { submit } : {}),
    };
  }
  return { kind: 'unknown' };
}

const fileTool = /^(?:Write|Edit|MultiEdit|NotebookEdit)$/;
const baseName = (file: string) => file.split(/[\\/]/).filter(Boolean).at(-1) ?? file;

/** The question the dialog shows, as an index into the request (or -1). */
function shownQuestion(
  d: Extract<Dialog, { kind: 'question' }>,
  r: Extract<InputRequest, { kind: 'question' }>,
) {
  return r.questions.findIndex((q) => plain(q.question) === plain(d.question));
}

function questionMatches(
  d: Extract<Dialog, { kind: 'question' }>,
  r: Extract<InputRequest, { kind: 'question' }>,
): boolean {
  const index = shownQuestion(d, r);
  if (index < 0) return false;
  const q = r.questions[index];
  if (d.multi !== q.multiSelect) return false;
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
        (tab, i) => !r.questions[i].header || plain(tab.label) === plain(r.questions[i].header!),
      )
    )
      return false;
  }
  return true;
}

function matches(d: Dialog, r: InputRequest): boolean {
  if (r.kind === 'question') {
    if (d.kind === 'question') return questionMatches(d, r);
    if (d.kind === 'review')
      return (
        d.answers.length > 0 &&
        d.answers.every((a) => r.questions.some((q) => plain(q.question) === plain(a.question)))
      );
    return false;
  }
  if (r.kind === 'plan') {
    if (d.kind !== 'plan') return false;
    if (r.planFile && d.planFile) return baseName(r.planFile) === baseName(d.planFile);
    const want = plain(r.plan).slice(0, 120);
    return !!want && !!d.plan && (plain(d.plan).startsWith(want) || want.startsWith(plain(d.plan)));
  }
  if (d.kind !== 'permission') return false;
  const region = plain(`${d.title}\n${d.body}\n${d.ask}`);
  const summary = r.summary.trim();
  // A file prompt ("Create file", "Edit file") names the file; a Bash prompt its command.
  if (fileTool.test(r.tool))
    return /\bfile\b/i.test(d.title) && !!summary && region.includes(plain(baseName(summary)));
  if (/^Bash$/.test(r.tool))
    return /bash/i.test(d.title) && !!summary && region.includes(plain(summary));
  return (
    region.includes(plain(r.tool.replace(/^mcp__/, '').replace(/__/g, ' '))) ||
    region.includes(plain(r.tool)) ||
    (!!summary && region.includes(plain(summary)))
  );
}

/** What picking a row does: allow once, keep allowing, deny, or a row that takes words. */
function roleOf(row: DialogRow): DialogChoice['role'] {
  if (row.input) return 'text';
  if (/^No\b/i.test(row.label)) return 'deny';
  if (
    /don.t ask again|always|for this session|switch to|auto mode|accept edits|bypass|allow all/i.test(
      row.label,
    )
  )
    return 'always';
  if (/^Yes\b/i.test(row.label)) return 'allow';
  return undefined;
}

function choices(d: Dialog): DialogChoice[] {
  if (d.kind !== 'plan' && d.kind !== 'permission') return [];
  return d.rows
    .filter((row) => !row.aside)
    .map((row) => {
      const role = roleOf(row);
      return { number: row.number, label: row.label, ...(role ? { role } : {}) };
    });
}

// ── Answering ────────────────────────────────────────────────────────────────────────────────

const STEP_MS = 120;
const TRIES = 4;

/** Stops of the `❯` marker, top to bottom: rows, then a multi-select's Submit, then asides. */
function stops(d: Dialog): (number | 'submit')[] {
  const main = d.rows.filter((row) => !row.aside).map((row) => row.number);
  const aside = d.rows.filter((row) => row.aside).map((row) => row.number);
  return [...main, ...(d.kind === 'question' && d.submit ? ['submit' as const] : []), ...aside];
}
function cursorAt(d: Dialog): number | 'submit' | undefined {
  if (d.kind === 'question' && d.submit?.cursor) return 'submit';
  return d.rows.find((row) => row.cursor)?.number;
}
const row = (d: Dialog, n: number) => d.rows.find((r) => r.number === n && !r.aside);

class Refusal extends Error {
  constructor(readonly reason: Extract<AnswerOutcome, { status: 'refused' }>['reason']) {
    super(reason);
  }
}

/**
 * The flow one answer takes: every key is preceded by `proceed()` and followed by reading the
 * screen until it shows what the key should have done.
 */
class Flow {
  pressed = false;
  constructor(
    private host: PromptHost,
    private request: InputRequest,
    private proceed: () => Promise<boolean>,
  ) {}

  async read(): Promise<Dialog> {
    const state = parseDialog(await this.host.read());
    if (state.kind === 'unreadable') throw new Refusal('unreadable');
    if (!isDialog(state) || !matches(state, this.request)) throw new Refusal('changed');
    return state;
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
    if (!keys.length) return;
    if (!(await this.proceed())) throw new Refusal('lost');
    this.pressed = true;
    await this.host.press(keys);
  }

  async type(text: string) {
    if (!(await this.proceed())) throw new Refusal('lost');
    this.pressed = true;
    await this.host.type(text);
  }

  /** Moves the marker to `target` and verifies it is there (nothing else changed). */
  async goTo(d: Dialog, target: number | 'submit', same: (d: Dialog) => boolean): Promise<Dialog> {
    const order = stops(d);
    const from = order.indexOf(cursorAt(d) ?? -1);
    const to = order.indexOf(target);
    if (to < 0) throw new Refusal('bad-choice');
    if (from < 0) throw new Refusal('unverified');
    const steps = to - from;
    await this.press(Array(Math.abs(steps)).fill(steps > 0 ? 'Down' : 'Up'));
    return this.expect((next) => same(next) && cursorAt(next) === target);
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

const isDialog = (state: DialogState): state is Dialog =>
  ['question', 'review', 'plan', 'permission'].includes(state.kind);

/** One line of typed words, as the dialog's text row can hold it. */
const oneLine = (text: string) =>
  text
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function answerQuestions(
  s: Flow,
  r: Extract<InputRequest, { kind: 'question' }>,
  answers: QuestionAnswer[],
): Promise<void> {
  if (answers.length !== r.questions.length) throw new Refusal('bad-choice');
  const qs = r.questions;
  const isQuestion =
    (index: number) =>
    (d: Dialog): d is Extract<Dialog, { kind: 'question' }> =>
      d.kind === 'question' && shownQuestion(d, r) === index;
  // Answered here from the start only: a dialog already partly answered in the terminal is left
  // to the terminal (its picks are not this choice).
  let d = await s.read();
  if (
    d.kind !== 'question' ||
    shownQuestion(d, r) !== 0 ||
    d.tabs.some((tab) => tab.done) ||
    d.rows.some((row) => row.checked) ||
    !d.rows.some((row) => row.input && TYPE_HINT.test(row.label))
  )
    throw new Refusal('partial');
  for (let qi = 0; qi < qs.length; qi++) {
    const q = qs[qi];
    const answer = answers[qi];
    const here = isQuestion(qi);
    let shown = await s.expect(here);
    const last = qi === qs.length - 1;
    // What follows this question: the next one, the review, or (a lone single-select
    // question) the dialog closing on submit.
    if ('other' in answer) {
      const text = oneLine(answer.other);
      if (!text || q.multiSelect) throw new Refusal('bad-choice');
      const input = shown.rows.find((row) => row.input && !row.aside);
      if (!input) throw new Refusal('bad-choice');
      shown = (await s.goTo(shown, input.number, here)) as typeof shown;
      await s.type(text);
      // Typed in the row and nothing else: then Enter answers with exactly these words.
      const holds = (next: Dialog) =>
        here(next) &&
        cursorAt(next) === input.number &&
        plain(row(next, input.number)?.label ?? '') === plain(text);
      await s.expect(holds);
      await s.commit(holds);
      if (last && qs.length === 1) return;
      continue;
    }
    const picks = [...new Set(answer.options)].sort((a, b) => a - b);
    if (!picks.length || picks.some((i) => !Number.isInteger(i) || i < 0 || i >= q.options.length))
      throw new Refusal('bad-choice');
    if (!q.multiSelect) {
      if (picks.length !== 1) throw new Refusal('bad-choice');
      const target = picks[0] + 1;
      shown = (await s.goTo(shown, target, here)) as typeof shown;
      await s.commit((next) => here(next) && cursorAt(next) === target);
      if (last && qs.length === 1) return;
      continue;
    }
    // Multi-select: toggle each row that differs, verifying its box, then on to the next tab.
    for (let oi = 0; oi < q.options.length; oi++) {
      const want = picks.includes(oi);
      const target = oi + 1;
      if (!!row(shown, target)?.checked === want) continue;
      shown = (await s.goTo(shown, target, here)) as typeof shown;
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
  const expected = qs.map((q, qi) => {
    const a = answers[qi];
    return 'other' in a ? oneLine(a.other) : a.options.map((i) => q.options[i].label).join(', ');
  });
  const review = await s.expect(
    (d2): d2 is Extract<Dialog, { kind: 'review' }> => d2.kind === 'review',
  );
  const fits = (d2: Dialog) =>
    d2.kind === 'review' &&
    d2.complete &&
    d2.answers.length === qs.length &&
    qs.every((q, qi) => {
      const a = d2.answers.find((x) => plain(x.question) === plain(q.question));
      return !!a && plain(a.answer) === plain(expected[qi]);
    });
  if (!fits(review)) throw new Refusal('unverified');
  const submit = review.rows.find((r2) => /^Submit answers$/i.test(r2.label));
  if (!submit) throw new Refusal('unverified');
  await s.goTo(review, submit.number, fits);
  await s.commit((d2) => fits(d2) && cursorAt(d2) === submit.number);
}

async function answerChoice(
  s: Flow,
  choice: Extract<PromptChoice, { kind: 'plan' | 'permission' }>,
) {
  const d = await s.read();
  const target = row(d, choice.number);
  // The choice the person saw: same number, same words, and not a row that takes text.
  if (!target || target.input || plain(target.label) !== plain(choice.label))
    throw new Refusal('bad-choice');
  const same = (next: Dialog) => {
    const r2 = row(next, choice.number);
    return !!r2 && !r2.input && plain(r2.label) === plain(choice.label);
  };
  await s.goTo(d, choice.number, same);
  await s.commit((next) => same(next) && cursorAt(next) === choice.number);
}

export const claudeCodePrompts: PromptAdapter = {
  agent: 'Claude',
  capabilities: (host) => ({ canAnswer: !!host }),
  async inspect(host) {
    return parseDialog(await host.read());
  },
  matches,
  choices,
  takesText: (d) => d.kind === 'question' && !d.multi && d.rows.some((r2) => r2.input && !r2.aside),
  async answer(host, request, choice, proceed) {
    const s = new Flow(host, request, proceed);
    try {
      if (choice.kind !== request.kind) throw new Refusal('bad-choice');
      if (choice.kind === 'question' && request.kind === 'question')
        await answerQuestions(s, request, choice.answers);
      else if (choice.kind !== 'question') await answerChoice(s, choice);
      return { status: 'submitted' };
    } catch (e) {
      if (e instanceof Refusal) return { status: 'refused', reason: e.reason, pressed: s.pressed };
      throw e;
    }
  },
};
