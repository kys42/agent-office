import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseStyledScreen } from '../desktop/composer/index.js';
import {
  callShows,
  claudeCodePrompts,
  claudeTarget,
  openCallsIn,
  parseDialog,
  promptsFor,
  resultIn,
  subjectOf,
  type ClaudeTargetDeps,
  type Dialog,
  type OpenCall,
  type PromptKey,
  withoutSidePane,
} from '../desktop/prompts/index.js';
import { answerRequest, decodeSetting, inspectPrompt } from '../desktop/answers.js';
import type { LiveTerminal, RunOptions } from '../desktop/terminals.js';
import { OfficeService } from '../server/service.js';
import type { AskingEvent } from '../src/shared/requests.js';
import type { InputRequest } from '../src/shared/types.js';
import { setLocale } from '../src/shared/i18n/index.js';
// These tests assert the original Korean copy.
process.env.AGENT_OFFICE_LOCALE = 'ko';
setLocale('ko');

// ── Captured screens (Claude Code 2.1.296, tmux 3.6a, Orca 1.4.216; see TERMINAL.md) ──────────

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'prompts');
const styled = (name: string) =>
  parseStyledScreen(readFileSync(path.join(FIXTURES, `${name}.e.txt`), 'utf8'));
const plainScreen = (name: string) => ({
  text: readFileSync(path.join(FIXTURES, `${name}.plain.txt`), 'utf8'),
});
const dialog = (name: string) => parseDialog(styled(name)) as Dialog;
const permission = (name: string) => dialog(name) as Extract<Dialog, { kind: 'permission' }>;
const MEASURE =
  '/private/tmp/claude-501/-Users-someone-xyz-orca-workspaces-agent-office-global/ec84eaa1-6d0f-496d-a35d-8dcf586a1cf8/scratchpad/measure';

const COLOR_INPUT = {
  questions: [
    {
      question: 'Pick a color',
      header: 'Color',
      multiSelect: false,
      options: [
        { label: 'Red', description: '따뜻하고 강렬한 색' },
        { label: 'Green', description: '자연스럽고 차분한 색' },
        { label: 'Blue', description: '시원하고 안정적인 색' },
      ],
    },
  ],
};
const FRUITS_INPUT = {
  questions: [
    {
      question: 'Pick fruits',
      header: 'Fruit',
      multiSelect: true,
      options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }],
    },
  ],
};
const TWO_INPUT = {
  questions: [
    {
      question: 'Pick a color',
      header: 'Color',
      multiSelect: false,
      options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
    },
    {
      question: 'Pick a size',
      header: 'Size',
      multiSelect: false,
      options: [{ label: 'Small' }, { label: 'Medium' }, { label: 'Large' }],
    },
  ],
};
const PLAN_INPUT = {
  plan: '1. 작업 디렉터리에 `hello.txt` 파일을 만들고 내용으로 "hi"를 쓴다.\n2. 확인: `cat hello.txt`를 실행해 출력이 `hi`인지 본다.\n',
  planFilePath: '/Users/someone.xyz/.claude/plans/plan-to-create-hello-txt-linear-tome.md',
};
const call = (
  id: string,
  tool: string,
  input: Record<string, unknown>,
  cwd?: string,
): OpenCall => ({ id, tool, input, ...(cwd ? { cwd } : {}) });
const oneOf = (d: Dialog, calls: OpenCall[]) => {
  const found = claudeCodePrompts.identify(d, calls);
  return found.status === 'one' ? found.asked.call.id : found.status;
};

test('Every captured dialog reads the same from plain and styled captures', () => {
  const names = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.e.txt'))
    .map((f) => f.slice(0, -'.e.txt'.length));
  assert.ok(names.length >= 25);
  for (const name of names)
    assert.deepEqual(parseDialog(styled(name)), parseDialog(plainScreen(name)), name);
});

test('Questions: rows, descriptions, the text row, the aside, tabs and the cursor', () => {
  const d = dialog('a2-q-open');
  assert.equal(d.kind, 'question');
  if (d.kind !== 'question') return;
  assert.equal(d.question, 'Pick a color');
  assert.deepEqual(d.tabs, [{ label: 'Color', done: false }]);
  assert.equal(d.multi, false);
  assert.deepEqual(
    d.rows.map((r) => [r.number, r.label, r.description, r.cursor, !!r.input, !!r.aside]),
    [
      [1, 'Red', '따뜻하고 강렬한 색', true, false, false],
      [2, 'Green', '자연스럽고 차분한 색', false, false, false],
      [3, 'Blue', '시원하고 안정적인 색', false, false, false],
      [4, 'Type something.', '', false, true, false],
      [5, 'Chat about this', '', false, false, true],
    ],
  );
  // Typed words replace the text row's hint; the cursor sits there.
  const typed = dialog('a3-q-typed');
  assert.equal(typed.rows.find((r) => r.input)?.label, 'teal please');
  assert.equal(typed.rows.find((r) => r.cursor)?.number, 4);
  // Multi-select: boxes, and the unnumbered Submit row.
  const multi = dialog('b5-on-submit');
  assert.ok(multi.kind === 'question' && multi.multi);
  if (multi.kind !== 'question') return;
  assert.deepEqual(
    multi.rows.filter((r) => !r.aside && !r.input).map((r) => r.checked),
    [true, false, true],
  );
  assert.deepEqual(multi.submit, { cursor: true });
  // Typed words: per question, never for multi-select.
  const mixed = {
    kind: 'question',
    questions: [...TWO_INPUT.questions, ...FRUITS_INPUT.questions],
  } as InputRequest;
  assert.deepEqual(claudeCodePrompts.takesText(d, mixed), [true, true, false]);
  // Two questions: the second shown after the first was answered.
  const second = dialog('c2-digit2');
  assert.ok(second.kind === 'question');
  if (second.kind !== 'question') return;
  assert.equal(second.question, 'Pick a size');
  assert.deepEqual(second.tabs, [
    { label: 'Color', done: true },
    { label: 'Size', done: false },
  ]);
  // A long question drawn with a left border.
  const long = dialog('g2-wide-longq');
  assert.ok(long.kind === 'question');
  if (long.kind === 'question')
    assert.equal(
      long.question,
      'Which deployment strategy should we use for the staging environment rollout this week?',
    );
});

test('Reviews and plans; only one-shot choices are offered', () => {
  assert.deepEqual(dialog('c5-review'), {
    kind: 'review',
    complete: true,
    answers: [
      { question: 'Pick a color', answer: 'Green' },
      { question: 'Pick a size', answer: 'Medium' },
    ],
    rows: [
      { number: 1, label: 'Submit answers', description: '', cursor: true },
      { number: 2, label: 'Cancel', description: '', cursor: false },
    ],
  });
  assert.equal((dialog('c7-review-partial') as { complete: boolean }).complete, false);
  const plan = dialog('d1-open');
  assert.equal(plan.kind, 'plan');
  if (plan.kind !== 'plan') return;
  assert.equal(plan.planFile, '~/.claude/plans/plan-to-create-hello-txt-linear-tome.md');
  assert.ok(plan.plan.startsWith('1. 작업 디렉터리에 hello.txt'));
  // Plans: only "manually approve edits" (never auto mode, never the text row).
  assert.deepEqual(claudeCodePrompts.choices(plan), [
    { number: 2, label: 'Yes, manually approve edits', role: 'allow' },
  ]);
  assert.equal(claudeCodePrompts.hasMore(plan), true);
  // Bash: Yes and No; "always allow access" and "switch to auto mode" stay in the terminal.
  assert.deepEqual(claudeCodePrompts.choices(dialog('e2-open')), [
    { number: 1, label: 'Yes', role: 'allow' },
    { number: 4, label: 'No', role: 'deny' },
  ]);
  // Files: "switch to accept edits" stays in the terminal.
  assert.deepEqual(
    claudeCodePrompts.choices(dialog('f1-write-open')).map((c) => c.label),
    ['Yes', 'No'],
  );
  // Fetch: its plain No reads "No, and tell Claude what to do differently (esc)" (measured).
  assert.deepEqual(claudeCodePrompts.choices(dialog('m-fetch')), [
    { number: 1, label: 'Yes', role: 'allow' },
    { number: 3, label: 'No, and tell Claude what to do differently (esc)', role: 'deny' },
  ]);
  // Tab turned Yes into a text row: nothing but No is offered then.
  assert.deepEqual(
    claudeCodePrompts.choices(dialog('f5-tab-amend')).map((c) => c.label),
    ['No'],
  );
  // A hook's "don't ask again for: rtk read *" is never offered.
  assert.deepEqual(
    claudeCodePrompts.choices(dialog('k-bash-hook')).map((c) => c.label),
    ['Yes', 'No'],
  );
});

test('A permission dialog says what the call does: the command, the file or the address', () => {
  assert.deepEqual(subjectOf(permission('e2-open')), {
    title: 'Bash command',
    command: 'echo hi > hello.txt',
  });
  assert.deepEqual(subjectOf(permission('f1-write-open')), {
    title: 'Create file',
    path: 'hello.txt',
  });
  assert.deepEqual(subjectOf(permission('l-edit')), { title: 'Edit file', path: 'hello.txt' });
  assert.deepEqual(subjectOf(permission('m-fetch')), {
    title: 'Fetch',
    url: 'https://example.com/',
  });
  // A long command wraps behind a faint border, mid-path: read back whole.
  assert.deepEqual(subjectOf(permission('k-bash-hook')), {
    title: 'Bash command',
    command: `rtk read ${MEASURE}/proj-e/e2e-plan.txt`,
  });
  const raw = JSON.parse(readFileSync(path.join(FIXTURES, 'o5-orca-bash.json'), 'utf8'));
  const orca = parseDialog({ text: raw.result.terminal.tail.join('\n') });
  assert.deepEqual(subjectOf(orca as Extract<Dialog, { kind: 'permission' }>), {
    title: 'Bash command',
    command: 'echo hi > hello3.txt',
  });
});

test('Permission prompts: exactly one open call must equal the screen, character for character', () => {
  const bash = permission('e2-open');
  const subject = subjectOf(bash)!;
  const shows = (input: Record<string, unknown>, tool = 'Bash') =>
    callShows(call('x', tool, input), subject);
  assert.ok(shows({ command: 'echo hi > hello.txt' }));
  assert.ok(shows({ command: 'echo  hi >\n hello.txt  ' }), 'spacing only');
  for (const command of [
    'echo hi', // a prefix
    'echo hi > hello.txt && rm -rf ~', // the screen shows a prefix of it
    'echo hi | hello.txt', // > → |
    'echo hi > ~/hello.txt', // ~ → /
    'echo hi > hello.txt;',
  ])
    assert.ok(!shows({ command }), command);
  assert.ok(!shows({ command: 'echo hi > hello.txt' }, 'Write'), 'another tool');
  assert.ok(!shows({ description: 'Write hi to a text file' }), 'description only');
  // A hook rewrote the command: the screen runs `rtk …`, the record says `cat …`.
  const hook = subjectOf(permission('k-bash-hook'))!;
  const file = `${MEASURE}/proj-e/e2e-plan.txt`;
  assert.ok(!callShows(call('x', 'Bash', { command: `cat ${file}` }), hook));
  assert.ok(callShows(call('x', 'Bash', { command: `rtk read ${file}` }), hook));
  assert.ok(
    !callShows(call('x', 'Bash', { command: 'git push' }), {
      title: 'Bash command',
      command: 'rtk git push',
    }),
  );
  // Files: the path as shown, relative to where the call was made, or absolute.
  const write = subjectOf(permission('f1-write-open'))!;
  assert.ok(callShows(call('x', 'Write', { file_path: '/p/hello.txt' }, '/p'), write));
  assert.ok(
    !callShows(call('x', 'Write', { file_path: '/p/sub/hello.txt' }, '/p'), write),
    'basename only',
  );
  assert.ok(!callShows(call('x', 'Write', { file_path: '/q/hello.txt' }, '/p'), write));
  assert.ok(!callShows(call('x', 'Edit', { file_path: '/p/hello.txt' }, '/p'), write));
  assert.ok(
    callShows(
      call('x', 'Edit', { file_path: '/p/hello.txt' }, '/p'),
      subjectOf(permission('l-edit'))!,
    ),
  );
  // Fetch: the same address (as a browser reads it), never another.
  const fetch = subjectOf(permission('m-fetch'))!;
  assert.ok(callShows(call('x', 'WebFetch', { url: 'https://example.com' }), fetch));
  assert.ok(!callShows(call('x', 'WebFetch', { url: 'https://example.org' }), fetch));
  assert.ok(!callShows(call('x', 'WebFetch', { url: 'https://example.com/x' }), fetch));
  // Parallel calls: only the one that equals the screen; two equal ones cannot be told apart.
  const ls: Extract<Dialog, { kind: 'permission' }> = { ...bash, fence: 'ls' };
  assert.equal(
    oneOf(ls, [
      call('a', 'Bash', { command: 'rm -rf dist && ls' }),
      call('b', 'Bash', { command: 'ls' }),
    ]),
    'b',
  );
  assert.equal(
    oneOf(ls, [call('a', 'Bash', { command: 'ls' }), call('b', 'Bash', { command: 'ls' })]),
    'many',
  );
  // A subagent asks with its own Bash; the parent only has its open Agent call.
  assert.equal(
    oneOf(bash, [call('a', 'Agent', { prompt: 'echo hi > hello.txt', description: 'x' })]),
    'none',
  );
  // Unknown headings (an MCP tool, a notebook) are never answered.
  assert.equal(subjectOf({ ...bash, title: 'mcp__notion__search' }), null);
});

test('Questions and plans: the open call whose input the dialog shows', () => {
  const color = call('q1', 'AskUserQuestion', COLOR_INPUT);
  assert.equal(oneOf(dialog('a2-q-open'), [color]), 'q1');
  assert.equal(oneOf(dialog('b1-open'), [call('q2', 'AskUserQuestion', FRUITS_INPUT)]), 'q2');
  assert.equal(oneOf(dialog('c1-open'), [call('q3', 'AskUserQuestion', TWO_INPUT)]), 'q3');
  assert.equal(oneOf(dialog('c5-review'), [call('q3', 'AskUserQuestion', TWO_INPUT)]), 'q3');
  // Other words, options, kinds, headers: none.
  const variant = (q: Record<string, unknown>) =>
    call('v', 'AskUserQuestion', { questions: [{ ...COLOR_INPUT.questions[0], ...q }] });
  for (const q of [
    { question: 'Pick a colour' },
    { options: [{ label: 'Red' }, { label: 'Green' }] },
    { multiSelect: true },
    { header: 'Colour' },
  ])
    assert.equal(oneOf(dialog('a2-q-open'), [variant(q)]), 'none', JSON.stringify(q));
  assert.equal(oneOf(dialog('a2-q-open'), [color, { ...color, id: 'q9' }]), 'many');
  // A question cut at rest (too long) is never compared.
  const long = call('l', 'AskUserQuestion', {
    questions: [{ ...COLOR_INPUT.questions[0], question: 'Pick a color ' + 'x'.repeat(2000) }],
  });
  assert.equal(oneOf(dialog('a2-q-open'), [long]), 'none');
  // Plans: the plan file and the beginning of the plan itself.
  assert.equal(oneOf(dialog('d1-open'), [call('p', 'ExitPlanMode', PLAN_INPUT)]), 'p');
  assert.equal(
    oneOf(dialog('d1-open'), [call('p', 'ExitPlanMode', { plan: PLAN_INPUT.plan })]),
    'p',
  );
  assert.equal(
    oneOf(dialog('d1-open'), [
      call('p', 'ExitPlanMode', { ...PLAN_INPUT, planFilePath: '/x/.claude/plans/other.md' }),
    ]),
    'none',
  );
  assert.equal(
    oneOf(dialog('d1-open'), [
      call('p', 'ExitPlanMode', { ...PLAN_INPUT, plan: '1. Delete everything\n2. Done' }),
    ]),
    'none',
  );
  // A plan edited after its first 80 characters is another plan: the whole visible plan counts.
  const edited = PLAN_INPUT.plan.replace('cat hello.txt', 'rm hello.txt');
  assert.ok(PLAN_INPUT.plan.indexOf('cat hello.txt') > 40);
  assert.equal(
    oneOf(dialog('d1-open'), [call('p', 'ExitPlanMode', { ...PLAN_INPUT, plan: edited })]),
    'none',
  );
  // A long label wrapped in a narrow pane no longer equals the recorded option: none.
  assert.equal(
    oneOf(dialog('g1-narrow'), [
      call('n', 'AskUserQuestion', {
        questions: [
          {
            question:
              'Which deployment strategy should we use for the staging environment rollout this week?',
            header: 'Deploy',
            multiSelect: false,
            options: [
              {
                label:
                  'Blue-green deployment with automatic traffic switching after health checks pass',
              },
              { label: 'Canary release to five percent of users first then gradually increase' },
              { label: 'Rolling update' },
            ],
          },
        ],
      }),
    ]),
    'none',
  );
});

test('No dialog: the open prompt, an unreadable screen, or nothing on it', () => {
  assert.deepEqual(parseDialog(styled('a3-q-after-other')), { kind: 'closed' });
  assert.deepEqual(parseDialog(null), { kind: 'unreadable' });
  assert.deepEqual(parseDialog({ text: '' }), { kind: 'closed' });
  // A numbered list in the output above the open prompt is no dialog.
  const text = ['⏺ Steps:', '  1. one', '  2. two', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏸ x'];
  assert.deepEqual(parseDialog({ text: text.join('\n') }), { kind: 'closed' });
});

// ── Transcripts: open calls and results, parsed ──────────────────────────────────────────────

const SID = '6dd9f1ee-30b0-4650-9b8f-6f2961115e8b';
type Use = { id: string; name: string; input: Record<string, unknown> };
const jsonl = (records: Record<string, unknown>[]) =>
  records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const prompt = (text: string) => ({
  type: 'user',
  sessionId: SID,
  message: { role: 'user', content: text },
});
const uses = (list: Use[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  sessionId: SID,
  cwd: '/p',
  ...extra,
  message: { role: 'assistant', content: list.map((u) => ({ type: 'tool_use', ...u })) },
});
const result = (id: string, content = 'ok') => ({
  type: 'user',
  sessionId: SID,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
});

test('Open calls are the current turn’s calls without a result, never a sidechain’s', () => {
  const text = jsonl([
    prompt('earlier'),
    uses([{ id: 'old', name: 'Bash', input: { command: 'ls' } }]),
    prompt('now'),
    uses([
      { id: 'a', name: 'Bash', input: { command: 'rm -rf dist && ls' } },
      { id: 'b', name: 'Bash', input: { command: 'ls' } },
    ]),
    result('a'),
    uses([{ id: 's', name: 'Bash', input: { command: 'ls' } }], { isSidechain: true }),
  ]);
  assert.deepEqual(
    openCallsIn(text).map((c) => [c.id, c.cwd]),
    [['b', '/p']],
  );
  // Results by exact id: a result that merely mentions an id does not count.
  assert.equal(resultIn(jsonl([result('other', 'see "tool_use_id":"b"')]), 'b'), false);
  assert.equal(resultIn(jsonl([result('b')]), 'b'), true);
  assert.equal(resultIn('{"tool_use_id":"b"', 'b'), false);
});

// ── A simulated Claude Code dialog (the measured drawing and key behaviour) ────────────────

const RULE = '─'.repeat(120);
type Question = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description?: string; preview?: string }[];
};
type Shown =
  | { kind: 'question'; questions: Question[] }
  | {
      kind: 'plan';
      plan: string;
      /** The rows as drawn (2.1.296 by default). */
      rows?: string[];
      /** The fullscreen renderer's plan box: this many plan lines, the rest (and `╌`) cut. */
      box?: number;
    }
  | { kind: 'bash'; command: string };
type Answer = Record<string, string> | 'rejected' | 'chat' | { choice: string };
const PLAN_ROWS_296 = [
  'Yes, and use auto mode',
  'Yes, manually approve edits',
  'Tell Claude what to change',
];
/** 2.1.316 without auto mode (its bundle's options builder): accept edits, manual, keep planning. */
const PLAN_ROWS_316 = [
  'Yes, auto-accept edits',
  'Yes, manually approve edits',
  'No, keep planning',
];

/** Terminal columns: Hangul, CJK and full-width forms take two. */
const cols = (text: string) =>
  [...text].reduce(
    (n, c) =>
      n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60]/.test(c) ? 2 : 1),
    0,
  );
/** Claude Code 2.1.304 draws a question with a line break or wider than 80 columns in a gutter. */
const needsGutter = (question: string) => question.includes('\n') || cols(question) > 80;
const padCols = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - cols(text)));
/** Word wrap at `width` columns, a word wider than that broken (wrap-ansi `hard`). */
function wrapCols(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (let word of text.split(' ')) {
    while (cols(word) > width) {
      if (line) out.push(line);
      let head = '';
      for (const c of word) {
        if (cols(head + c) > width) break;
        head += c;
      }
      out.push(head);
      line = '';
      word = word.slice(head.length);
    }
    if (!line) line = word;
    else if (cols(line) + 1 + cols(word) <= width) line += ' ' + word;
    else {
      out.push(line);
      line = word;
    }
  }
  return line ? [...out, line] : out;
}
/** 2.1.322: a single-select question with a preview on any option is drawn side by side. */
const hasPreview = (q: Question) => !q.multiSelect && q.options.some((o) => o.preview);

/** One dialog as Claude Code 2.1.296 draws it and reacts to keys (TERMINAL.md, measured). */
class Claude {
  answer: Answer | null = null;
  /** TUI variants that review even one single-select/text question before submission. */
  reviewSingle = false;
  singularReview = false;
  /** The pane's width for the review: longer questions and answers wrap onto indented lines. */
  reviewWidth?: number;
  keys: string[] = [];
  /** Called after every key: tests change the screen mid-way. */
  onKey?: (sim: Claude) => void;
  /** Preview layout: notes typed in the terminal, per question. */
  notes: string[];
  /** A Claude Code plugin pane drawn at the right, behind a `│` divider at column 120. */
  pane = false;
  /** A broken tab bar: answered questions keep drawing `☐`. */
  unmarked = false;
  /** Preview layout: the marker is on "Chat about this". */
  private chatFocus = false;
  private q = 0;
  private review = false;
  private cursor: number[];
  private checked: boolean[][];
  private typed: string[];
  private picked: (string | null)[];
  private choice = 0;
  constructor(public shown: Shown) {
    const qs = shown.kind === 'question' ? shown.questions : [];
    this.cursor = qs.map(() => 0);
    this.checked = qs.map((q) => q.options.map(() => false));
    this.typed = qs.map(() => '');
    this.picked = qs.map(() => null);
    this.notes = qs.map(() => '');
  }
  get closed() {
    return this.answer !== null;
  }
  private questions() {
    return this.shown.kind === 'question' ? this.shown.questions : [];
  }
  /** Stops: options, the text row, (multi) Submit, Chat about this. */
  private stops(q = this.q) {
    const question = this.questions()[q];
    return question.options.length + 1 + (question.multiSelect ? 1 : 0) + 1;
  }
  /** Word-wrapped at `reviewWidth`, going on under itself (as measured in a narrow pane). */
  private wrap(line: string): string[] {
    const width = this.reviewWidth;
    if (!width || line.length <= width) return [line];
    const out: string[] = [];
    let current = '';
    for (const word of line.split(/(?<=\S) /)) {
      if (current && (current + ' ' + word).length > width) {
        out.push(current);
        current = '   ' + word.trimStart();
      } else current = current ? current + ' ' + word : word;
    }
    return [...out, current];
  }
  /** The review's `● question`: in a gutter (` │ `) when long or on several lines. */
  private reviewQuestion(question: string): string[] {
    if (!needsGutter(question)) return this.wrap(` ● ${question}`);
    // In the gutter the bullet sits at column 3, the text and its wrapped rest at column 5.
    return question
      .split('\n')
      .flatMap((line, i) => this.wrap(`${i ? '   ' : ' ● '}${line}`))
      .map((line) => ` │ ${line.slice(1)}`.trimEnd());
  }
  render(): string {
    const text = this.draw();
    if (!this.pane) return text;
    return text
      .split('\n')
      .map((line, i) => `${padCols(line, 120)}│${i % 3 ? '' : ' 패널 예시 │'}`)
      .join('\n');
  }
  /** 2.1.322's preview layout (its bundle's `uZ`): options at the left, the box, notes, chat. */
  private drawPreview(bar: string): string {
    const q = this.questions()[this.q];
    const c = this.cursor[this.q];
    const left = q.options.flatMap((o, i) => {
      const [first, ...rest] = wrapCols(o.label, 26);
      return [`${c === i ? '❯' : ' '} ${i + 1}. ${first}`, ...rest.map((l) => `    ${l}`)];
    });
    const shown = (q.options[c].preview ?? 'No preview available').split('\n');
    const widest = Math.max(
      ...q.options.flatMap((o) => (o.preview ?? '').split('\n').map(cols)),
      ...shown.map(cols),
    );
    const outer = Math.max(4, Math.min(widest + 4, 120 - 34));
    const inner = outer - 4;
    const box = [
      `┌${'─'.repeat(outer - 2)}┐`,
      ...shown.map(
        (l) => `│ ${padCols(cols(l) > inner ? l.slice(0, inner - 1) + '…' : l, inner)} │`,
      ),
      `└${'─'.repeat(outer - 2)}┘`,
    ];
    const rows = Array.from({ length: Math.max(left.length, box.length) }, (_, i) =>
      `${padCols(left[i] ?? '', 34)}${box[i] ?? ''}`.trimEnd(),
    );
    const many = this.questions().length > 1;
    return [
      RULE,
      bar,
      '',
      // A question in the gutter wraps at the pane's width (2 columns go to the gutter).
      ...(needsGutter(q.question)
        ? q.question
            .split('\n')
            .flatMap((line) => wrapCols(line, 118))
            .map((line) => `│ ${line}`)
        : [q.question]),
      '',
      ...rows,
      '',
      `${' '.repeat(34)}Notes: ${this.notes[this.q] || 'press n to add notes'}`,
      '',
      RULE,
      `${this.chatFocus ? '❯' : ' '} Chat about this`,
      '',
      `Enter to select · ↑/↓ to navigate · n to add notes · ${many ? 'Tab to switch questions · ' : ''}Esc to cancel`,
    ].join('\n');
  }
  private draw(): string {
    if (this.closed) return ['⏺ Done.', RULE, '❯ ', RULE, '  ⏸ manual mode on'].join('\n');
    const r = this.shown;
    if (r.kind === 'plan') {
      const rows = r.rows ?? PLAN_ROWS_296;
      const body = r.plan
        .trim()
        .split('\n')
        .map((l) => '   ' + l.replace(/`/g, ''));
      return [
        '  ' + '─'.repeat(116),
        '   Ready to code?',
        '',
        "   Here is Claude's plan:",
        '  ' + '╌'.repeat(116),
        ...(r.box !== undefined && body.length > r.box
          ? body.slice(0, r.box)
          : [...body, '  ' + '╌'.repeat(116)]),
        '  ' + '─'.repeat(116),
        '   Claude has written up a plan and is ready to execute. Would you like to proceed?',
        '',
        ...rows.map((l, i) => `   ${i === this.choice ? '❯' : ' '} ${i + 1}. ${l}`),
        '        shift+tab to approve with this feedback',
        '',
        '   ctrl+g to edit in VS Code · ~/.claude/plans/plan-to-create-hello-txt-linear-tome.md',
      ].join('\n');
    }
    if (r.kind === 'bash') {
      const rows = ['Yes', "Yes, and don't ask again for echo commands in this project", 'No'];
      return [
        RULE,
        ' Bash command',
        ' Write hi to a text file',
        '╌'.repeat(120),
        ' ' + r.command,
        '╌'.repeat(120),
        ' Do you want to proceed?',
        ...rows.map((l, i) => ` ${i === this.choice ? '❯' : ' '} ${i + 1}. ${l}`),
        '',
        ' Esc to cancel · Tab to amend',
      ].join('\n');
    }
    const qs = this.questions();
    const many = this.reviewSingle || qs.length > 1 || qs.some((q) => q.multiSelect);
    const bar = many
      ? `←  ${qs.map((q, i) => `${this.done(i) && !this.unmarked ? '☒' : '☐'} ${q.header}`).join('  ')}  ✔ Submit  →`
      : ` ☐ ${qs[0].header}`;
    if (this.review) {
      const all = qs.every((_, i) => this.done(i));
      return [
        RULE,
        bar,
        '',
        this.singularReview ? 'Review your answer' : 'Review your answers',
        ...(all ? [] : ['', '⚠ You have not answered all questions']),
        '',
        ...qs.flatMap((q, i) =>
          this.done(i)
            ? [...this.reviewQuestion(q.question), ...this.wrap(`   → ${this.answerOf(i)}`)]
            : [],
        ),
        '',
        this.singularReview ? 'Ready to submit your answer?' : 'Ready to submit your answers?',
        '',
        `${this.choice === 0 ? '❯' : ' '} 1. Submit ${this.singularReview ? 'answer' : 'answers'}`,
        `${this.choice === 1 ? '❯' : ' '} 2. Cancel`,
      ].join('\n');
    }
    const q = qs[this.q];
    if (hasPreview(q)) return this.drawPreview(bar);
    const c = this.cursor[this.q];
    const n = q.options.length;
    const mark = (i: number) => (c === i ? '❯' : ' ');
    const box = (i: number) => (q.multiSelect ? `[${this.checked[this.q][i] ? '✔' : ' '}] ` : '');
    const hint = q.multiSelect ? 'Type something' : 'Type something.';
    return [
      RULE,
      bar,
      '',
      ...(needsGutter(q.question)
        ? q.question.split('\n').map((line) => `│ ${line}`)
        : [q.question]),
      '',
      ...q.options.flatMap((o, i) => [
        `${mark(i)} ${i + 1}. ${box(i)}${o.label}`,
        ...(o.description ? [`     ${o.description}`] : []),
      ]),
      `${mark(n)} ${n + 1}. ${q.multiSelect ? '[ ] ' : ''}${this.typed[this.q] || hint}`,
      ...(q.multiSelect ? [`${c === n + 1 ? '❯' : ' '}    Submit`] : []),
      RULE,
      `${mark(this.stops() - 1)} ${n + 2}. Chat about this`,
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
  }
  private done(i: number) {
    return this.picked[i] !== null || this.checked[i].some(Boolean);
  }
  private answerOf(i: number) {
    const q = this.questions()[i];
    return q.multiSelect
      ? q.options
          .filter((_, j) => this.checked[i][j])
          .map((o) =>
            o.label.includes(', ') || o.label.includes('"') ? JSON.stringify(o.label) : o.label,
          )
          .join(', ')
      : (this.picked[i] ?? '');
  }
  private next() {
    this.chatFocus = false;
    const qs = this.questions();
    if (qs.length === 1 && !qs[0].multiSelect && !this.reviewSingle) return this.submit();
    if (this.q < qs.length - 1) this.q++;
    else {
      this.review = true;
      this.choice = 0;
    }
  }
  private submit() {
    this.answer = Object.fromEntries(
      this.questions().flatMap((q, i) => (this.done(i) ? [[q.question, this.answerOf(i)]] : [])),
    );
  }
  type(text: string) {
    if (this.closed || this.review || this.shown.kind !== 'question') return;
    if (this.cursor[this.q] === this.questions()[this.q].options.length) this.typed[this.q] += text;
  }
  key(name: string) {
    this.keys.push(name);
    const r = this.shown;
    if (this.closed) return;
    if (r.kind !== 'question' || this.review) {
      const rows =
        r.kind === 'question' ? 2 : r.kind === 'plan' ? (r.rows ?? PLAN_ROWS_296).length : 3;
      if (name === 'Down') this.choice = Math.min(rows - 1, this.choice + 1);
      if (name === 'Up') this.choice = Math.max(0, this.choice - 1);
      if (name === 'Enter') {
        if (r.kind === 'question') {
          if (this.choice === 0) this.submit();
          else this.answer = 'rejected';
        } else this.answer = { choice: String(this.choice + 1) };
      }
    } else if (hasPreview(this.questions()[this.q])) {
      // 2.1.322 `uZ`: ↓ past the last option onto "Chat about this", ↑ back; no wrapping.
      const q = this.questions()[this.q];
      const c = this.cursor[this.q];
      if (name === 'Down') {
        if (c < q.options.length - 1 && !this.chatFocus) this.cursor[this.q]++;
        else this.chatFocus = true;
      }
      if (name === 'Up') {
        if (this.chatFocus) this.chatFocus = false;
        else if (c > 0) this.cursor[this.q]--;
      }
      if (name === 'Right' && !this.chatFocus) this.next();
      if (name === 'Enter') {
        if (this.chatFocus) this.answer = 'chat';
        else {
          this.picked[this.q] = q.options[c].label;
          this.next();
        }
      }
    } else {
      const q = this.questions()[this.q];
      const n = q.options.length;
      const c = this.cursor[this.q];
      if (name === 'Down') this.cursor[this.q] = Math.min(this.stops() - 1, c + 1);
      if (name === 'Up') this.cursor[this.q] = Math.max(0, c - 1);
      if (name === 'Space' && q.multiSelect && c < n)
        this.checked[this.q][c] = !this.checked[this.q][c];
      if (name === 'Right') this.next();
      if (name === 'Enter') {
        if (c === this.stops() - 1) this.answer = 'chat';
        else if (q.multiSelect) {
          if (c < n) this.checked[this.q][c] = !this.checked[this.q][c];
          else if (c === n + 1) this.next();
        } else if (c < n) {
          this.picked[this.q] = q.options[c].label;
          this.next();
        } else if (this.typed[this.q]) {
          this.picked[this.q] = this.typed[this.q];
          this.next();
        } else this.answer = 'rejected';
      }
    }
    this.onKey?.(this);
  }
}

const START = 'Tue Oct 13 06:41:08 2026';
const SOCKET = '/private/tmp/tmux-501/default';
const ORCA = 'term_205af179-74b5-4973-9cd8-0fb07bf63fa9';

interface Harness {
  host?: 'tmux' | 'orca';
  fg?: () => string;
  status?: () => string;
  /** The open calls the transcript holds (the asked one is `toolu_q`). */
  calls?: Use[];
  /** The pane's height (tmux). */
  height?: number;
  /** Screen reads that fail. */
  unreadable?: () => boolean;
  /** The transcript never shows the result (a lagging record). */
  noResult?: boolean;
}

/** Fake CLIs around a simulated Claude: tmux or Orca, the process table, record and transcript. */
async function harness(sim: Claude, options: Harness = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-prompts-'));
  const record = () =>
    JSON.stringify({
      pid: 4242,
      sessionId: SID,
      procStart: START,
      status: options.status?.() ?? (sim.closed ? 'busy' : 'waiting'),
      kind: 'interactive',
      updatedAt: 1000,
    });
  await writeFile(path.join(dir, '4242.json'), record());
  const calls: string[][] = [];
  let loaded = '';
  const screen = () => {
    if (options.unreadable?.()) throw new Error('busy redrawing');
    return sim.render();
  };
  const deps: ClaudeTargetDeps = {
    sessionsDir: dir,
    codexHome: '/nonexistent',
    alive: () => true,
    bin: (name) => `/bin/${name}`,
    wait: async () => {
      await writeFile(path.join(dir, '4242.json'), record());
    },
    readTail: async () =>
      jsonl([
        prompt('please'),
        uses(options.calls ?? []),
        ...(sim.closed && !options.noResult ? [result('toolu_q')] : []),
      ]),
    run: async (file: string, args: string[], run?: RunOptions) => {
      calls.push([file, ...args]);
      await writeFile(path.join(dir, '4242.json'), record());
      if (file === '/bin/ps') {
        if (args.includes('lstart=')) return `${START}\n`;
        if (args.includes('stat=,pgid=,tpgid=')) return `${options.fg?.() ?? 'S+ 4242 4242'}\n`;
      }
      if (file === '/bin/tmux') {
        if (args.some((a) => a.startsWith('#{pane_in_mode}'))) return `0 ${options.height ?? 40}\n`;
        if (args.includes('capture-pane')) return screen();
        if (args.includes('load-buffer')) loaded = run?.input ?? '';
        if (args.includes('paste-buffer')) sim.type(loaded);
        if (args.includes('send-keys'))
          for (const key of args.slice(args.indexOf('send-keys') + 3)) sim.key(key);
      }
      if (file === '/bin/orca') {
        if (args[1] === 'read')
          return JSON.stringify({
            ok: true,
            result: {
              terminal: {
                tail: screen()
                  .split('\n')
                  .filter((l) => l.trim()),
                source: 'screen',
              },
            },
          });
        if (args[1] === 'send') {
          const text = args.find((a) => a.startsWith('--text='))?.slice(7) ?? '';
          const names: Record<string, string> = {
            '\x1b[A': 'Up',
            '\x1b[B': 'Down',
            '\x1b[C': 'Right',
            ' ': 'Space',
          };
          if (text.startsWith('\x1b[200~')) sim.type(text.slice(6, -6));
          else for (const key of text.match(/\x1b\[[ABCD]|./gs) ?? []) sim.key(names[key] ?? key);
          if (args.includes('--enter')) sim.key('Enter');
          return JSON.stringify({ ok: true, result: { send: { accepted: true } } });
        }
      }
      return '';
    },
  };
  const live: LiveTerminal = {
    process: { pid: 4242, sessionId: SID, procStart: START, status: 'waiting', updatedAt: 1000 },
    host:
      options.host === 'orca'
        ? { kind: 'orca', handle: ORCA, title: 'claude' }
        : { kind: 'tmux', socket: SOCKET, pane: '%3', label: 'work:1.0' },
  };
  const target = claudeTarget(live, '/tmp/x.jsonl', deps);
  return { target, calls, done: () => rm(dir, { recursive: true, force: true }) };
}

const asking = (request: InputRequest, callId = 'toolu_q'): AskingEvent => ({
  id: 'toolu_q:tool0',
  at: 1,
  kind: 'tool',
  text: 'tool',
  tool:
    request.kind === 'plan'
      ? 'ExitPlanMode'
      : request.kind === 'question'
        ? 'AskUserQuestion'
        : request.tool,
  intent: 'request-input',
  callId,
  sourceRef: 'x',
  request,
});
const QUESTION = (input: { questions: unknown[] }) =>
  ({ kind: 'question', questions: input.questions }) as InputRequest;
const BASH: InputRequest = { kind: 'permission', tool: 'Bash' };
const PLAN: InputRequest = {
  kind: 'plan',
  plan: PLAN_INPUT.plan,
  planFile: PLAN_INPUT.planFilePath,
};
const shownQuestions = (input: { questions: Question[] }): Shown => ({
  kind: 'question',
  questions: input.questions,
});

async function answer(
  request: InputRequest,
  shown: Shown,
  calls: Use[],
  choice: Record<string, unknown>,
  setup: (sim: Claude) => void = () => {},
  options: Harness = {},
) {
  const sim = new Claude(shown);
  setup(sim);
  const h = await harness(sim, { ...options, calls });
  try {
    const event = asking(request);
    const outcome = await answerRequest(claudeCodePrompts, event, h.target, {
      eventId: event.id,
      kind: request.kind,
      callId: 'toolu_q',
      ...choice,
    }).catch((e: Error) => e);
    return { result: outcome, sim, calls: h.calls };
  } finally {
    await h.done();
  }
}
const keysOf = (calls: string[][]) =>
  calls
    .filter((c) => c.includes('send-keys'))
    .map((c) => c.slice(c.indexOf('send-keys') + 3).join(' '));
const ask = (input: { questions: unknown[] }): Use => ({
  id: 'toolu_q',
  name: 'AskUserQuestion',
  input,
});
const bashCall = (command: string, id = 'toolu_q'): Use => ({
  id,
  name: 'Bash',
  input: { command },
});
const planCall: Use = { id: 'toolu_q', name: 'ExitPlanMode', input: PLAN_INPUT };
const failed = (r: unknown) =>
  r instanceof Error ? r.message : `not refused: ${JSON.stringify(r)}`;

test('A single question: one arrow at a time, verified, then Enter alone', async () => {
  const {
    result: r,
    sim,
    calls,
  } = await answer(QUESTION(COLOR_INPUT), shownQuestions(COLOR_INPUT), [ask(COLOR_INPUT)], {
    answers: [{ options: [2] }],
  });
  assert.deepEqual(r, { status: 'answered', message: 'tmux work:1.0에서 답했어요' });
  assert.deepEqual(sim.answer, { 'Pick a color': 'Blue' });
  // Never a digit, Tab or Esc: Down, Down, then Enter alone.
  assert.deepEqual(keysOf(calls), ['Down', 'Down', 'Enter']);
});

test('Typed words go into the text row, verified before Enter', async () => {
  const {
    result: r,
    sim,
    calls,
  } = await answer(QUESTION(COLOR_INPUT), shownQuestions(COLOR_INPUT), [ask(COLOR_INPUT)], {
    answers: [{ other: 'teal\nplease' }],
  });
  assert.equal((r as { status: string }).status, 'answered');
  assert.deepEqual(sim.answer, { 'Pick a color': 'teal please' });
  assert.ok(calls.some((c) => c.includes('paste-buffer') && c.includes('-p')));
  assert.deepEqual(keysOf(calls), ['Down', 'Down', 'Down', 'Enter']);
});

test('A single question with a review step submits the verified choice or typed answer on both hosts', async () => {
  for (const host of ['tmux', 'orca'] as const) {
    for (const typed of [false, true]) {
      for (const singular of [false, true]) {
        const { result: r, sim } = await answer(
          QUESTION(COLOR_INPUT),
          shownQuestions(COLOR_INPUT),
          [ask(COLOR_INPUT)],
          { answers: [typed ? { other: 'teal please' } : { options: [2] }] },
          (sim) => {
            sim.reviewSingle = true;
            sim.singularReview = singular;
          },
          { host },
        );
        assert.deepEqual(sim.answer, { 'Pick a color': typed ? 'teal please' : 'Blue' }, host);
        assert.equal((r as { status: string }).status, 'answered');
        assert.equal(
          sim.keys.filter((k) => k === 'Enter').length,
          2,
          'choice then final submission',
        );
      }
    }
  }
});

test('A single-question review may appear after stale or blank redraws, and the cursor may start on Cancel', async () => {
  for (const blank of [false, true]) {
    const { result: r, sim } = await answer(
      QUESTION(COLOR_INPUT),
      shownQuestions(COLOR_INPUT),
      [ask(COLOR_INPUT)],
      { answers: [{ options: [2] }] },
      (sim) => {
        sim.reviewSingle = true;
        const render = sim.render.bind(sim);
        const initial = render();
        let redraws = 0;
        sim.onKey = (s) => {
          if (s.keys.at(-1) === 'Enter' && !s.closed) {
            redraws = 2;
            s.key('Down'); // The review initially selects Cancel.
          }
        };
        sim.render = () => (redraws-- > 0 ? (blank ? '' : initial) : render());
      },
      { host: 'orca' },
    );
    assert.equal((r as { status: string }).status, 'answered');
    assert.deepEqual(sim.answer, { 'Pick a color': 'Blue' });
    assert.equal(sim.keys.filter((k) => k === 'Enter').length, 2);
    assert.ok(sim.keys.includes('Up'));
  }
});

test('An altered, incomplete or unrelated review never receives the final Enter', async () => {
  for (const change of ['answer', 'question', 'incomplete', 'unknown'] as const) {
    const { result: r, sim } = await answer(
      QUESTION(COLOR_INPUT),
      shownQuestions(COLOR_INPUT),
      [ask(COLOR_INPUT)],
      { answers: [{ options: [2] }] },
      (sim) => {
        sim.reviewSingle = true;
        const render = sim.render.bind(sim);
        sim.render = () => {
          const text = render();
          if (!text.includes('Ready to submit')) return text;
          if (change === 'answer') return text.replace('→ Blue', '→ Red');
          if (change === 'question') return text.replace('● Pick a color', '● Another question');
          if (change === 'incomplete')
            return text.replace('Review your answers', 'You have not answered all questions');
          return text.replace('Ready to submit your answers?', 'Unrecognized confirmation');
        };
      },
      { host: 'orca' },
    );
    assert.ok(r instanceof Error, change);
    assert.equal(sim.answer, null);
    assert.equal(sim.keys.filter((k) => k === 'Enter').length, 1, change);
  }
});

test('Multi-select: Space on each row that differs, then → and the review', async () => {
  const {
    result: r,
    sim,
    calls,
  } = await answer(QUESTION(FRUITS_INPUT), shownQuestions(FRUITS_INPUT), [ask(FRUITS_INPUT)], {
    answers: [{ options: [0, 2] }],
  });
  assert.equal((r as { status: string }).status, 'answered');
  assert.deepEqual(sim.answer, { 'Pick fruits': 'Apple, Cherry' });
  assert.deepEqual(keysOf(calls), ['Space', 'Down', 'Down', 'Space', 'Right', 'Enter']);
});

test('Two questions: each answered in turn, the review checked, then submitted', async () => {
  const {
    result: r,
    sim,
    calls,
  } = await answer(QUESTION(TWO_INPUT), shownQuestions(TWO_INPUT), [ask(TWO_INPUT)], {
    answers: [{ options: [1] }, { options: [0] }],
  });
  assert.equal((r as { status: string }).status, 'answered');
  assert.deepEqual(sim.answer, { 'Pick a color': 'Green', 'Pick a size': 'Small' });
  assert.deepEqual(keysOf(calls), ['Down', 'Enter', 'Enter', 'Enter']);
});

test('Multi-question review accepts the singular submit label on Orca', async () => {
  const { result: r, sim } = await answer(
    QUESTION(TWO_INPUT),
    shownQuestions(TWO_INPUT),
    [ask(TWO_INPUT)],
    { answers: [{ options: [1] }, { options: [0] }] },
    (sim) => {
      sim.singularReview = true;
    },
    { host: 'orca' },
  );
  assert.equal((r as { status: string }).status, 'answered');
  assert.deepEqual(sim.answer, { 'Pick a color': 'Green', 'Pick a size': 'Small' });
  assert.equal(sim.keys.filter((k) => k === 'Enter').length, 3);
});

test('Ambiguous questions and a pane too small for the review are left to the terminal', async () => {
  const same = {
    questions: [TWO_INPUT.questions[0], { ...TWO_INPUT.questions[1], question: 'Pick a color' }],
  };
  const dup = await answer(QUESTION(same), shownQuestions(same), [ask(same)], {
    answers: [{ options: [0] }, { options: [0] }],
  });
  assert.ok(dup.result instanceof Error);
  assert.equal(dup.sim.keys.length, 0);
  const small = await answer(
    QUESTION(TWO_INPUT),
    shownQuestions(TWO_INPUT),
    [ask(TWO_INPUT)],
    { answers: [{ options: [0] }, { options: [0] }] },
    () => {},
    { height: 14 },
  );
  assert.match(failed(small.result), /구분되지 않는/);
  assert.equal(small.sim.keys.length, 0);
});

test('Plan approval and permission: only the one-shot row the person saw, by its words', async () => {
  const plan = await answer(PLAN, { kind: 'plan', plan: PLAN_INPUT.plan }, [planCall], {
    number: 2,
    label: 'Yes, manually approve edits',
  });
  assert.equal((plan.result as { status: string }).status, 'answered');
  assert.deepEqual(plan.sim.answer, { choice: '2' });
  assert.deepEqual(keysOf(plan.calls), ['Down', 'Enter']);
  // Auto mode and the text row are never pressed from here.
  for (const [number, label] of [
    [1, 'Yes, and use auto mode'],
    [3, 'Tell Claude what to change'],
  ] as const) {
    const refused = await answer(PLAN, { kind: 'plan', plan: PLAN_INPUT.plan }, [planCall], {
      number,
      label,
    });
    assert.match(failed(refused.result), /한 번짜리 선택지가 아니에요/);
    assert.equal(refused.sim.keys.length, 0);
  }
  const bash: Shown = { kind: 'bash', command: 'echo hi > hello.txt' };
  const no = await answer(BASH, bash, [bashCall('echo hi > hello.txt')], {
    number: 3,
    label: 'No',
  });
  assert.deepEqual(no.sim.answer, { choice: '3' });
  assert.deepEqual(keysOf(no.calls), ['Down', 'Down', 'Enter']);
  const always = await answer(BASH, bash, [bashCall('echo hi > hello.txt')], {
    number: 2,
    label: "Yes, and don't ask again for echo commands in this project",
  });
  assert.match(failed(always.result), /한 번짜리 선택지가 아니에요/);
  assert.equal(always.sim.keys.length, 0);
});

test('Permission: refused unless exactly the asked call equals the screen', async () => {
  const shown: Shown = { kind: 'bash', command: 'ls' };
  const yes = { number: 1, label: 'Yes' };
  // The screen shows `ls`; the asked call is `rm -rf dist && ls`, another open call is `ls`.
  const other = await answer(
    BASH,
    shown,
    [bashCall('rm -rf dist && ls'), bashCall('ls', 'toolu_other')],
    yes,
  );
  assert.match(failed(other.result), /확실하지 않아서 보내지 않았어요/);
  assert.equal(other.sim.keys.length, 0);
  // Two open calls both read `ls`: which one the screen asks about cannot be told.
  const twins = await answer(BASH, shown, [bashCall('ls'), bashCall('ls', 'toolu_twin')], yes);
  assert.ok(twins.result instanceof Error);
  assert.equal(twins.sim.keys.length, 0);
  // A hook rewrote it: the record says `git push`, the screen runs `rtk git push`.
  const hook = await answer(
    BASH,
    { kind: 'bash', command: 'rtk git push' },
    [bashCall('git push')],
    yes,
  );
  assert.ok(hook.result instanceof Error);
  assert.equal(hook.sim.keys.length, 0);
  // The exact one: answered, and the result read back from the transcript by its id.
  const ok = await answer(
    BASH,
    shown,
    [bashCall('ls'), bashCall('rm -rf dist && ls', 'toolu_other')],
    yes,
  );
  assert.deepEqual(ok.result, { status: 'answered', message: 'tmux work:1.0에서 답했어요' });
});

test('Several calls in one turn: the permission prompt is about the one the screen shows', async () => {
  // Claude Code asks for the first call while the record marks the last as waiting.
  const shown: Shown = { kind: 'bash', command: 'ls' };
  const calls = [bashCall('ls'), bashCall('git status', 'toolu_last')];
  const sim = new Claude(shown);
  const h = await harness(sim, { calls });
  try {
    const card = asking(BASH, 'toolu_last');
    const view = await inspectPrompt(claudeCodePrompts, card, h.target, 'on');
    assert.equal(view.status, 'ready');
    if (view.status !== 'ready') return;
    assert.equal(view.callId, 'toolu_q');
    assert.equal(view.tool, 'Bash');
    assert.deepEqual(view.subject, { title: 'Bash command', command: 'ls' });
    // An answer must name the call the card showed: another id is refused, nothing pressed.
    const wrong = await answerRequest(claudeCodePrompts, card, h.target, {
      eventId: card.id,
      kind: 'permission',
      callId: 'toolu_last',
      number: 1,
      label: 'Yes',
    }).catch((e: Error) => e);
    assert.match(failed(wrong), /확실하지 않아서 보내지 않았어요/);
    assert.equal(sim.keys.length, 0);
    const ok = await answerRequest(claudeCodePrompts, card, h.target, {
      eventId: card.id,
      kind: 'permission',
      callId: view.callId,
      number: 1,
      label: 'Yes',
    });
    assert.deepEqual(ok, { status: 'answered', message: 'tmux work:1.0에서 답했어요' });
    assert.deepEqual(sim.answer, { choice: '1' });
  } finally {
    await h.done();
  }
});

test('A mixed batch: the card names the tool of the call the screen shows, not the record’s', async () => {
  // Bash first, then Write: Claude Code asks about Bash, the record marks Write as waiting.
  const sim = new Claude({ kind: 'bash', command: 'ls' });
  const write: Use = {
    id: 'toolu_w',
    name: 'Write',
    input: { file_path: '/p/a.txt', content: 'x' },
  };
  const h = await harness(sim, { calls: [bashCall('ls'), write] });
  try {
    const card = asking({ kind: 'permission', tool: 'Write' }, 'toolu_w');
    const view = await inspectPrompt(claudeCodePrompts, card, h.target, 'on');
    assert.equal(view.status, 'ready');
    if (view.status !== 'ready') return;
    assert.deepEqual(
      [view.callId, view.tool, view.subject?.title],
      ['toolu_q', 'Bash', 'Bash command'],
    );
  } finally {
    await h.done();
  }
});

test('The card gets the screen with secrets hidden; matching keeps what the screen says', async () => {
  const command = 'curl --token=abc123 https://x';
  const sim = new Claude({ kind: 'bash', command });
  const h = await harness(sim, { calls: [bashCall(command)] });
  try {
    const view = await inspectPrompt(claudeCodePrompts, asking(BASH), h.target, 'on');
    assert.equal(view.status, 'ready');
    if (view.status !== 'ready') return;
    assert.equal(view.subject?.command, 'curl --token=[숨김] https://x');
    assert.ok(!JSON.stringify(view).includes('abc123'));
    const ok = await answerRequest(claudeCodePrompts, asking(BASH), h.target, {
      eventId: 'toolu_q:tool0',
      kind: 'permission',
      callId: view.callId,
      number: 3,
      label: 'No',
    });
    assert.equal(ok.status, 'answered');
  } finally {
    await h.done();
  }
});

test('A plan matches only when everything the dialog shows is the recorded plan', () => {
  const plan = `1. ${'Prepare the release notes and check every link. '.repeat(3)}\n2. Publish with npm`;
  const screen = parseDialog({ text: new Claude({ kind: 'plan', plan }).render() }) as Dialog;
  const planCallOf = (text: string) =>
    call('p', 'ExitPlanMode', {
      plan: text,
      planFilePath: '/x/.claude/plans/plan-to-create-hello-txt-linear-tome.md',
    });
  assert.equal(oneOf(screen, [planCallOf(plan)]), 'p');
  // Edited after the first 80 characters (ctrl+g): another plan, never approved from the card.
  assert.equal(oneOf(screen, [planCallOf(plan.replace('npm', 'yarn'))]), 'none');
  // The whole box is on screen: a recorded plan that goes on past it is another plan.
  assert.equal(oneOf(screen, [planCallOf(`${plan}\n3. Delete the tag`)]), 'none');
});

// ── Claude Code 2.1.316 plan dialogs ────────────────────────────────────────────────────────
// Not captured: drawn from 2.1.316's bundle (the ExitPlanMode dialog and its options builder;
// the fullscreen renderer sizes the plan's scroll box to the pane and shows its top). Markdown as
// its renderer draws it: no `#`/`**`/backticks/code fences, `-` bullets, a link with its address.

const PLAN_316 = {
  plan: [
    '# Launch core refactor',
    '',
    '## Context',
    '',
    'Every launch path (**new session**, resume, fork) goes through `desktop/launch/`. The Orca and tmux paths still differ in how they confirm a start.',
    '',
    '## Steps',
    '',
    '1. Move the confirm step into `pipeline.ts` and call it from every destination.',
    '2. Keep the waiting record for 2 minutes when the start cannot be confirmed:',
    '',
    '   ```ts',
    '   const WAIT_MS = 120_000;',
    '   ```',
    '',
    '3. Update `tests/launch.test.ts` with the new order.',
    '- Check the Orca tab with `orca terminal list` (see [Orca docs](https://example.com/orca-docs))',
    '',
    '| Destination | Confirmed by |',
    '|---|---|',
    "| Orca | the tab's handle |",
    '| tmux | the session name |',
    '',
    '## Verification',
    '',
    '- `npm test`',
    '- `npm run typecheck`',
  ].join('\n'),
  planFilePath: '/Users/someone.xyz/.claude/plans/launch-core-refactor-quiet-otter.md',
};
const plan316 = (name: string) => {
  const d = parseDialog(plainScreen(name)) as Dialog;
  assert.equal(d.kind, 'plan', name);
  return d as Extract<Dialog, { kind: 'plan' }>;
};

test('2.1.316: a plan taller than the pane is read as far as it shows, and approvable', () => {
  // Fullscreen: the box shows the plan's start; its bottom and closing ╌ are cut.
  const start = plan316('p316-plan-start');
  assert.equal(start.shows, 'start');
  assert.equal(start.planFile, '~/.claude/plans/launch-core-refactor-quiet-otter.md');
  assert.match(start.plan, /^Launch core refactor\n/);
  assert.match(start.plan, /\| Orca {8}\| the tab's handle \|$/);
  // 2.1.316's rows: only "manually approve edits"; accept edits and the text row stay there.
  assert.deepEqual(claudeCodePrompts.choices(start), [
    { number: 2, label: 'Yes, manually approve edits', role: 'allow' },
  ]);
  assert.equal(start.rows.find((r) => r.number === 3)?.input, true);
  assert.equal(claudeCodePrompts.hasMore(start), true);
  const planOf = (input: Record<string, unknown>) => [call('p', 'ExitPlanMode', input)];
  assert.equal(oneOf(start, planOf(PLAN_316)), 'p');
  // The stored copy may hide secret-like words; the raw input is what the screen shows.
  assert.equal(oneOf(start, planOf({ plan: PLAN_316.plan })), 'p');
  // Anything shown that differs: another plan.
  for (const edited of [
    PLAN_316.plan.replace('2 minutes', '5 minutes'),
    PLAN_316.plan.replace('const WAIT_MS', 'let WAIT_MS'),
    PLAN_316.plan.replace("the tab's handle", 'the window title'),
    `# Intro\n\n${PLAN_316.plan}`,
  ])
    assert.equal(oneOf(start, planOf({ ...PLAN_316, plan: edited })), 'none', edited);
  assert.equal(
    oneOf(start, planOf({ ...PLAN_316, planFilePath: '/x/.claude/plans/other.md' })),
    'none',
  );

  // Main screen: the terminal scrolled, leaving the plan's end and the closing ╌; a narrow pane
  // wrapped the footer before the plan file. "Clear context" is never offered.
  const end = plan316('p316-plan-end');
  assert.equal(end.shows, 'end');
  assert.equal(end.planFile, '~/.claude/plans/launch-core-refactor-quiet-otter.md');
  assert.deepEqual(claudeCodePrompts.choices(end), [
    { number: 3, label: 'Yes, manually approve edits', role: 'allow' },
  ]);
  assert.equal(oneOf(end, planOf(PLAN_316)), 'p');
  // Its end only counts with the plan file named on both sides.
  assert.equal(oneOf(end, planOf({ plan: PLAN_316.plan })), 'none');
  assert.equal(
    oneOf(end, planOf({ ...PLAN_316, plan: `${PLAN_316.plan}\n- npm run build` })),
    'none',
  );
});

test('2.1.316: addresses in a plan count letter for letter, however the pane wraps them', () => {
  const RELEASE = {
    plan: [
      '# Release',
      '',
      '1. Download from https://trusted.example/releases/v2.1.316/agent-office.dmg',
      '2. Read the [release notes](https://trusted.example/notes/v2) first.',
    ].join('\n'),
    planFilePath: '/Users/someone.xyz/.claude/plans/release-v2.md',
  };
  const planOf = (input: Record<string, unknown>) => [call('p', 'ExitPlanMode', input)];
  const withPlan = (plan: string) => planOf({ ...RELEASE, plan });
  // A narrow pane: the address and the link (drawn `text (address)`) wrap mid-path.
  const narrow = plan316('p316-plan-narrow');
  assert.equal(narrow.shows, 'all');
  assert.equal(narrow.planFile, '~/.claude/plans/release-v2.md');
  assert.deepEqual(claudeCodePrompts.choices(narrow), [
    { number: 2, label: 'Yes, manually approve edits', role: 'allow' },
  ]);
  assert.equal(oneOf(narrow, planOf(RELEASE)), 'p');
  // Another address, plain or behind the link, is another plan.
  for (const other of [
    RELEASE.plan.replace(
      'https://trusted.example/releases/v2.1.316/agent-office.dmg',
      'https://other.example/payload',
    ),
    RELEASE.plan.replace('trusted.example/releases', 'trusted.example.evil/releases'),
    RELEASE.plan.replace('(https://trusted.example/notes/v2)', '(https://other.example/notes)'),
    // The link's address is on screen: its text alone is not what it shows.
    RELEASE.plan.replace('[release notes](https://trusted.example/notes/v2)', 'release notes'),
  ])
    assert.equal(oneOf(narrow, withPlan(other)), 'none', other);
  // A plain address the screen shows another way: none (the safe side).
  const screen = (from: string, to: string) =>
    parseDialog({ text: plainScreen('p316-plan-narrow').text.replace(from, to) }) as Dialog;
  const swapped = screen('https://trusted.example\n', 'https://other.example/payload\n');
  assert.equal(oneOf(swapped, planOf(RELEASE)), 'none');
  // A terminal that takes hyperlinks draws the link's text alone (the address hidden in it).
  const linked = screen(
    'release notes\n      (https://trusted.example/notes/v2)\n      first.',
    'release notes first.',
  );
  assert.equal((linked as { plan: string }).plan.includes('notes/v2'), false);
  assert.equal(oneOf(linked, planOf(RELEASE)), 'p');
  assert.equal(
    oneOf(linked, withPlan(RELEASE.plan.replace('release notes', 'release checklist'))),
    'none',
  );
  // The plain address is still drawn there: changing it is another plan.
  assert.equal(oneOf(linked, withPlan(RELEASE.plan.replace('v2.1.316', 'v2.1.317'))), 'none');
});

/** A whole 2.1.316 plan dialog around these drawn plan lines. */
const planDialog = (lines: string[], file = 'cleanup.md') =>
  parseDialog({
    text: [
      '  ' + '─'.repeat(116),
      '   Ready to code?',
      '',
      "   Here is Claude's plan:",
      '  ' + '╌'.repeat(116),
      ...lines.map((line) => (line ? `   ${line}` : '')),
      '  ' + '╌'.repeat(116),
      '',
      '  ' + '─'.repeat(116),
      '   Claude has written up a plan and is ready to execute. Would you like to proceed?',
      '',
      ...PLAN_ROWS_316.map((label, i) => `   ${i ? ' ' : '❯'} ${i + 1}. ${label}`),
      '        shift+tab to approve with this feedback',
      '',
      `   ctrl+g to edit in VS Code · ~/.claude/plans/${file}`,
    ].join('\n'),
  }) as Dialog;

test('2.1.316: every character of a plan counts, punctuation included; only spacing does not', () => {
  const CLEANUP = {
    plan: [
      '## Cleanup',
      '',
      '1. Fetch https://trusted.example/path/release.tar.gz',
      '2. Run `rm -rf build/tmp; npm ci, npm test`',
      '   1. Check `value != null` before use',
      '   2. Keep `a < b` in the guard',
      '      - Nested *note*',
      '3. Done',
      '',
      '> Careful: **only** the build folder.',
    ].join('\n'),
    planFilePath: '/Users/someone.xyz/.claude/plans/cleanup.md',
  };
  // As its renderer draws it: no `#`/backticks/`*`, nested ordered items lettered, the quote bar.
  const screen = planDialog([
    'Cleanup',
    '',
    '1. Fetch https://trusted.example/path/release.tar.gz',
    '2. Run rm -rf build/tmp; npm ci, npm test',
    '   a. Check value != null before use',
    '   b. Keep a < b in the guard',
    '      - Nested note',
    '3. Done',
    '',
    '▎ Careful: only the build folder.',
  ]);
  const withPlan = (plan: string) => [call('p', 'ExitPlanMode', { ...CLEANUP, plan })];
  assert.equal(oneOf(screen, withPlan(CLEANUP.plan)), 'p');
  for (const [from, to] of [
    ['trusted.example', 'trustedexample'],
    ['!=', '=='],
    ['a < b', 'a > b'],
    ['build/tmp', 'build-tmp'],
    ['path/release', 'path/../release'],
    ['rm -rf', 'rm -f'],
    ['build/tmp; npm ci, npm test', 'build/tmp, npm ci; npm test'],
    ['**only**', 'ONLY'],
  ])
    assert.equal(oneOf(screen, withPlan(CLEANUP.plan.replace(from, to))), 'none', `${from}→${to}`);
  // The same change seen on the screen instead: none either.
  const drawnAs = (from: string, to: string) =>
    planDialog((screen as { plan: string }).plan.replace(from, to).split('\n'), 'cleanup.md');
  assert.equal(oneOf(drawnAs('!=', '=='), withPlan(CLEANUP.plan)), 'none');
  assert.equal(oneOf(drawnAs('trusted.example', 'trustedexample'), withPlan(CLEANUP.plan)), 'none');
  // Numbers a nested list would not draw (`1.` where it draws `a.`): none, never loosened.
  assert.equal(oneOf(drawnAs('a. Check', '1. Check'), withPlan(CLEANUP.plan)), 'none');
  // Wrapped anywhere, even mid-word: the same plan.
  assert.equal(
    oneOf(drawnAs('npm ci, npm test', 'npm ci, np\nm test'), withPlan(CLEANUP.plan)),
    'p',
  );
});

test('2.1.316: a code block label shows where the highlighter lacks it; unknown drawings never match', () => {
  const plan = ['Draw it:', '', '```mermaid', 'graph TD; A-->B', '```', '', 'Then **ship**.'].join(
    '\n',
  );
  const input = { plan, planFilePath: '/Users/someone.xyz/.claude/plans/cleanup.md' };
  const calls = [call('p', 'ExitPlanMode', input)];
  // A language the highlighter does not know: its label drawn above the code; or not.
  const labelled = planDialog(['Draw it:', '', 'mermaid', 'graph TD; A-->B', '', 'Then ship.']);
  const bare = planDialog(['Draw it:', '', 'graph TD; A-->B', '', 'Then ship.']);
  assert.equal(oneOf(labelled, calls), 'p');
  assert.equal(oneOf(bare, calls), 'p');
  assert.equal(
    oneOf(planDialog(['Draw it:', '', 'graph TD; A->B', '', 'Then ship.']), calls),
    'none',
  );
  // A character reference is drawn as written by Claude Code's parser: not reproduced, none.
  const amp = { ...input, plan: 'Run `make` &amp; check the log.' };
  assert.equal(
    oneOf(planDialog(['Run make &amp; check the log.']), [call('p', 'ExitPlanMode', amp)]),
    'none',
  );
});

test('2.1.316: a plan whose every Yes is withheld offers no button', () => {
  const screen = [
    '  ' + '─'.repeat(116),
    '   Ready to code?',
    '',
    "   Here is Claude's plan:",
    '  ' + '╌'.repeat(116),
    '   (the plan is too large to be shown in full — approval is withheld; send feedback asking for a shorter plan, or press Esc)',
    '  ' + '╌'.repeat(116),
    '  ' + '─'.repeat(116),
    '   Claude has written up a plan and is ready to execute. Would you like to proceed?',
    '',
    '   ❯ 1. No, keep planning',
  ].join('\n');
  const d = parseDialog({ text: screen }) as Dialog;
  assert.equal(d.kind, 'plan');
  assert.deepEqual(claudeCodePrompts.choices(d), []);
  assert.equal(oneOf(d, [call('p', 'ExitPlanMode', PLAN_316)]), 'none');
});

test('2.1.316: approving a plan cut by the pane presses Down to "manually approve", then Enter', async () => {
  const plan = Array.from(
    { length: 30 },
    (_, i) => `${i + 1}. Step number ${i + 1} of the plan`,
  ).join('\n');
  const input = { plan, planFilePath: PLAN_INPUT.planFilePath };
  const request: InputRequest = { kind: 'plan', plan, planFile: PLAN_INPUT.planFilePath };
  const shown: Shown = { kind: 'plan', plan, rows: PLAN_ROWS_316, box: 12 };
  const ok = await answer(request, shown, [{ id: 'toolu_q', name: 'ExitPlanMode', input }], {
    number: 2,
    label: 'Yes, manually approve edits',
  });
  assert.equal((ok.result as { status: string }).status, 'answered');
  assert.deepEqual(ok.sim.answer, { choice: '2' });
  assert.deepEqual(keysOf(ok.calls), ['Down', 'Enter']);
  // Accept edits keeps applying, and "No, keep planning" takes words: never pressed from here.
  for (const [number, label] of [
    [1, 'Yes, auto-accept edits'],
    [3, 'No, keep planning'],
  ] as const) {
    const refused = await answer(request, shown, [{ id: 'toolu_q', name: 'ExitPlanMode', input }], {
      number,
      label,
    });
    assert.match(failed(refused.result), /한 번짜리 선택지가 아니에요/);
    assert.equal(refused.sim.keys.length, 0);
  }
});

test('Settings stored by pre-release builds as booleans still read as on and off', () => {
  assert.equal(decodeSetting(true), 'on');
  assert.equal(decodeSetting(false), 'off');
  assert.equal(decodeSetting('on'), 'on');
  assert.equal(decodeSetting('off'), 'off');
  assert.equal(decodeSetting(undefined), 'unset');
  assert.equal(decodeSetting('yes'), 'unset');
});

test('Orca: the same keys as bytes, one at a time, Enter as its own submit', async () => {
  const {
    result: r,
    sim,
    calls,
  } = await answer(
    BASH,
    { kind: 'bash', command: 'echo hi > hello.txt' },
    [bashCall('echo hi > hello.txt')],
    { number: 3, label: 'No' },
    () => {},
    { host: 'orca' },
  );
  assert.equal((r as { status: string }).status, 'answered');
  assert.deepEqual(sim.answer, { choice: '3' });
  const sends = calls.filter((c) => c[0] === '/bin/orca' && c[2] === 'send');
  assert.deepEqual(
    sends.map((c) => c.slice(4, -1)),
    [['--text=\x1b[B'], ['--text=\x1b[B'], ['--enter']],
  );
});

test('Refused mid-way: the dialog changes, or Claude loses the terminal', async () => {
  const color = shownQuestions(COLOR_INPUT);
  const pick = { answers: [{ options: [2] }] };
  // The dialog turns into another one after the first key: Enter never goes in.
  const changed = await answer(QUESTION(COLOR_INPUT), color, [ask(COLOR_INPUT)], pick, (sim) => {
    sim.onKey = (s) => {
      s.shown = { kind: 'bash', command: 'rm -rf build' };
    };
  });
  assert.match(failed(changed.result), /화면이 바뀌어 멈췄어요/);
  assert.deepEqual(changed.sim.keys, ['Down']);
  // Claude stops being in front (ctrl+z) after the first key: stops before the next one.
  let presses = 0;
  const lost = await answer(
    QUESTION(COLOR_INPUT),
    color,
    [ask(COLOR_INPUT)],
    pick,
    (sim) => {
      sim.onKey = () => presses++;
    },
    { fg: () => (presses ? 'T 4242 4000' : 'S+ 4242 4242') },
  );
  assert.match(failed(lost.result), /터미널 앞에 있지 않아요/);
  assert.deepEqual(lost.sim.keys, ['Down']);
  // Not waiting any more (the record moved on): nothing is pressed.
  const moved = await answer(QUESTION(COLOR_INPUT), color, [ask(COLOR_INPUT)], pick, () => {}, {
    status: () => 'busy',
  });
  assert.ok(moved.result instanceof Error);
  assert.equal(moved.sim.keys.length, 0);
  // Already partly answered in the terminal: left to the terminal.
  const partial = await answer(
    QUESTION(FRUITS_INPUT),
    shownQuestions(FRUITS_INPUT),
    [ask(FRUITS_INPUT)],
    { answers: [{ options: [1] }] },
    (sim) => {
      sim.key('Space');
      sim.keys = [];
    },
  );
  assert.match(failed(partial.result), /이미 고르던 답/);
  assert.equal(partial.sim.keys.length, 0);
  // Options that do not exist.
  const stale = await answer(QUESTION(COLOR_INPUT), color, [ask(COLOR_INPUT)], {
    answers: [{ options: [5] }],
  });
  assert.match(failed(stale.result), /한 번짜리 선택지가 아니에요/);
});

test('After the keys: an unreadable screen is not a closed dialog, and the record must show the id', async () => {
  const color = shownQuestions(COLOR_INPUT);
  // The screen cannot be read after Enter: sent, and said honestly that it is not confirmed.
  let entered = false;
  const blind = await answer(
    QUESTION(COLOR_INPUT),
    color,
    [ask(COLOR_INPUT)],
    { answers: [{ options: [0] }] },
    (sim) => {
      sim.onKey = (s) => {
        if (s.keys.at(-1) === 'Enter') entered = true;
      };
    },
    { unreadable: () => entered },
  );
  assert.deepEqual(blind.result, {
    status: 'answered',
    message:
      'tmux work:1.0에 보냈지만 그 뒤 화면을 읽지 못해 확인하지 못했어요. 터미널을 확인해 주세요.',
  });
  // The dialog closed but the transcript has no result for that id (yet): said so.
  const lag = await answer(
    QUESTION(COLOR_INPUT),
    color,
    [ask(COLOR_INPUT)],
    { answers: [{ options: [0] }] },
    () => {},
    { noResult: true },
  );
  assert.deepEqual(lag.result, {
    status: 'answered',
    message: 'tmux work:1.0에 보냈지만 기록에 아직 답이 보이지 않아요. 터미널을 확인해 주세요.',
  });
});

test('An unknown screen after final review is reported as unconfirmed, not as verified closure', async () => {
  const { result: r, sim } = await answer(
    QUESTION(TWO_INPUT),
    shownQuestions(TWO_INPUT),
    [ask(TWO_INPUT)],
    { answers: [{ options: [1] }, { options: [0] }] },
    (sim) => {
      const render = sim.render.bind(sim);
      sim.render = () =>
        sim.closed ? `${RULE}\nUnrecognized dialog\n❯ 1. Continue\n  2. Cancel` : render();
    },
    { host: 'orca' },
  );
  assert.ok(sim.closed);
  assert.match((r as { message: string }).message, /그 뒤 화면을 읽지 못해 확인하지 못했어요/);
  assert.equal(sim.keys.filter((k) => k === 'Enter').length, 3);
});

test('The card is offered only one-shot choices, only for the exact call', async () => {
  const sim = new Claude({ kind: 'bash', command: 'echo hi > hello.txt' });
  const h = await harness(sim, { calls: [bashCall('echo hi > hello.txt')] });
  try {
    const ready = await inspectPrompt(claudeCodePrompts, asking(BASH), h.target, 'on');
    assert.equal(ready.status, 'ready');
    if (ready.status === 'ready') {
      assert.deepEqual(
        ready.choices.map((c) => [c.label, c.role]),
        [
          ['Yes', 'allow'],
          ['No', 'deny'],
        ],
      );
      assert.equal(ready.more, true);
      // The card shows what the screen says.
      assert.deepEqual(ready.subject, { title: 'Bash command', command: 'echo hi > hello.txt' });
    }
    const reason = async (...args: Parameters<typeof inspectPrompt>) => {
      const view = await inspectPrompt(...args);
      return view.status === 'unavailable' ? view.reason : view.status;
    };
    // Not on (never set, or turned off): still offered, marked so the first press asks.
    for (const setting of ['unset', 'off'] as const) {
      const view = await inspectPrompt(claudeCodePrompts, asking(BASH), h.target, setting);
      assert.equal(view.status, 'ready');
      assert.equal(view.status === 'ready' && view.consent, setting);
    }
    assert.ok(ready.status === 'ready' && ready.consent === undefined);
    assert.equal(await reason(claudeCodePrompts, asking(BASH), null, 'on'), 'no-terminal');
    // A question cut at rest cannot be checked; Codex and others are shown, never answered.
    const cut = { ...QUESTION(COLOR_INPUT), truncated: true } as InputRequest;
    assert.equal(await reason(claudeCodePrompts, asking(cut), h.target, 'on'), 'unverifiable');
    const codex = promptsFor('codex');
    assert.equal(await reason(codex, asking(QUESTION(COLOR_INPUT)), h.target, 'on'), 'unsupported');
    assert.equal(sim.keys.length, 0);
    // Unsupported adapters say so when asked to answer, too.
    assert.deepEqual(
      await codex.answer(
        h.target.host,
        { call: call('x', 'Bash', {}), request: BASH },
        { kind: 'permission', number: 1, label: 'Yes' },
        async () => true,
      ),
      { status: 'refused', reason: 'unsupported', pressed: false },
    );
  } finally {
    await h.done();
  }
});

test('The shared service (also the web preview RPC) can neither inspect nor answer prompts', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-prompt-rpc-'));
  const service = new OfficeService(path.join(temp, 'data'), temp);
  try {
    for (const method of ['prompt', 'answer', 'answer-settings', 'answerSettings'])
      await assert.rejects(service.call(method, ['id', {}]), /지원하지 않는 요청/);
    await assert.rejects(service.call('preferences', [{ answerQuestions: true }]));
    await assert.rejects(service.call('preferences', [{ answerPermissions: true }]));
  } finally {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  }
});

test('Adapter keys never include digits, Tab, Esc or control keys', () => {
  const allowed: PromptKey[] = ['Up', 'Down', 'Right', 'Enter', 'Space'];
  const source = readFileSync(
    path.join(import.meta.dirname, '..', 'desktop', 'prompts', 'claude-code.ts'),
    'utf8',
  );
  for (const key of source.matchAll(/press\(\[([^\]]*)\]\)/g))
    for (const name of key[1].match(/'([^']+)'/g) ?? [])
      assert.ok(allowed.includes(name.slice(1, -1) as PromptKey), name);
  // Arrows go one at a time.
  assert.ok(!/press\(\[[^\]]*,/.test(source));
});

test('A long question wrapping in the review is still read, checked and submitted', async () => {
  const long = {
    questions: [
      {
        ...TWO_INPUT.questions[0],
        question:
          '작업 브랜치 base 는 어디로 할까요? (#886 ReAct 캐시 유지 변경이 들어 있어야 해서 dev-aix 는 그보다 뒤에 있습니다)',
      },
      TWO_INPUT.questions[1],
    ],
  };
  const { result: r, sim } = await answer(
    QUESTION(long),
    shownQuestions(long),
    [ask(long)],
    { answers: [{ options: [1] }, { options: [0] }] },
    (sim) => (sim.reviewWidth = 60),
  );
  assert.equal((r as { status: string }).status, 'answered', failed(r));
  assert.deepEqual(sim.answer, { [long.questions[0].question]: 'Green', 'Pick a size': 'Small' });
  const review = parseDialog({
    text: [
      RULE,
      '←  ☒ Color  ☒ Size  ✔ Submit  →',
      '',
      'Review your answers',
      '',
      ' ● 작업 브랜치 base 는 어디로 할까요? (#886 ReAct 캐시 유지 변경이 들어 있어야',
      '   해서 dev-aix 는 그보다 뒤에 있습니다)',
      '   → feat/agent-playground',
      '   (Recommended)',
      ' ● Pick a size',
      '   → Small',
      '',
      'Ready to submit your answers?',
      '',
      '❯ 1. Submit answers',
      '  2. Cancel',
    ].join('\n'),
  });
  assert.ok(review.kind === 'review');
  if (review.kind === 'review')
    assert.deepEqual(review.answers, [
      {
        question:
          '작업 브랜치 base 는 어디로 할까요? (#886 ReAct 캐시 유지 변경이 들어 있어야 해서 dev-aix 는 그보다 뒤에 있습니다)',
        answer: 'feat/agent-playground (Recommended)',
      },
      { question: 'Pick a size', answer: 'Small' },
    ]);
});

test('A review is read only below its own title (a taller review never reads what is above)', () => {
  const screen = (title: boolean) =>
    parseDialog({
      text: [
        RULE,
        '←  ☒ Color  ☒ Size  ✔ Submit  →',
        ...(title ? ['', 'Review your answers'] : []),
        '',
        ' ● Pick a color',
        '   → Green',
        '',
        'Ready to submit your answers?',
        '',
        '❯ 1. Submit answers',
        '  2. Cancel',
      ].join('\n'),
    });
  const seen = screen(true);
  assert.ok(seen.kind === 'review' && seen.answers.length === 1);
  const cut = screen(false);
  assert.ok(cut.kind === 'review' && cut.answers.length === 0, 'nothing to check: refused');
});

// Claude Code 2.1.304 draws a question wider than 80 columns (about 40 Korean characters) or on
// several lines behind a left gutter, on the question screen and in the review alike.
const LONG_INPUT = {
  questions: [
    {
      question:
        '작업 브랜치 base 는 어디로 할까요? 캐시 유지 변경이 들어 있어야 해서 dev 브랜치는 그보다 뒤에 있습니다',
      header: '브랜치',
      multiSelect: false,
      options: [{ label: 'main' }, { label: 'dev' }],
    },
    {
      question: '어떤 검사를 함께 돌릴까요?\n\n고른 것만 CI 에서 실행합니다.',
      header: '검사',
      multiSelect: true,
      options: [{ label: 'lint, format' }, { label: 'unit "fast"' }, { label: 'e2e' }],
    },
    {
      question:
        '배포 전에 꼭 확인해야 할 내용이 있으면 적어 주세요. 없으면 첫 번째 선택지를 고르면 됩니다',
      header: '메모',
      multiSelect: false,
      options: [{ label: '없음' }, { label: '나중에' }],
    },
  ],
};

test('Long or multi-line questions in a gutter: the review is read and submitted on both hosts', async () => {
  assert.ok(LONG_INPUT.questions.every((q) => needsGutter(q.question)));
  for (const host of ['tmux', 'orca'] as const) {
    for (const width of [undefined, 60]) {
      const { result: r, sim } = await answer(
        QUESTION(LONG_INPUT),
        shownQuestions(LONG_INPUT),
        [ask(LONG_INPUT)],
        { answers: [{ options: [1] }, { options: [0, 1] }, { other: '스테이징 DB 백업 확인' }] },
        (sim) => (sim.reviewWidth = width),
        { host },
      );
      assert.equal((r as { status: string }).status, 'answered', `${host} ${width}: ${failed(r)}`);
      assert.deepEqual(sim.answer, {
        [LONG_INPUT.questions[0].question]: 'dev',
        [LONG_INPUT.questions[1].question]: '"lint, format", "unit \\"fast\\""',
        [LONG_INPUT.questions[2].question]: '스테이징 DB 백업 확인',
      });
      assert.equal(sim.keys.at(-1), 'Enter', 'the final Enter on Submit answers');
    }
  }
});

test('A review drawn with gutters, as tmux and Orca (blank lines dropped) read it', () => {
  const lines = [
    RULE,
    '←  ☒ 브랜치  ☒ 검사  ☒ 메모  ✔ Submit  →',
    '',
    'Review your answers',
    '',
    ' │ ● 작업 브랜치 base 는 어디로 할까요? 캐시 유지 변경이 들어 있어야 해서 dev',
    ' │   브랜치는 그보다 뒤에 있습니다',
    '   → dev',
    ' │ ● 어떤 검사를 함께 돌릴까요?',
    ' │',
    ' │   고른 것만 CI 에서 실행합니다.',
    '   → "lint, format", "unit \\"fast\\""',
    ' ● Pick a size',
    '   → Small',
    '',
    'Ready to submit your answers?',
    '',
    '❯ 1. Submit answers',
    '  2. Cancel',
  ];
  for (const text of [lines.join('\n'), lines.filter((l) => l.trim()).join('\n')]) {
    const review = parseDialog({ text });
    assert.ok(review.kind === 'review');
    if (review.kind !== 'review') continue;
    assert.deepEqual(review.answers, [
      {
        question:
          '작업 브랜치 base 는 어디로 할까요? 캐시 유지 변경이 들어 있어야 해서 dev 브랜치는 그보다 뒤에 있습니다',
        answer: 'dev',
      },
      {
        question: '어떤 검사를 함께 돌릴까요? 고른 것만 CI 에서 실행합니다.',
        answer: '"lint, format", "unit \\"fast\\""',
      },
      { question: 'Pick a size', answer: 'Small' },
    ]);
    assert.deepEqual(
      review.rows.map((r) => [r.number, r.label, r.cursor]),
      [
        [1, 'Submit answers', true],
        [2, 'Cancel', false],
      ],
    );
  }
});

// ── 2.1.322: questions with previews (#191) ──────────────────────────────────────────────────
// Fixtures q322-*: drawn as the 2.1.322 bundle lays the dialog out (AskUserQuestion `uZ`), the
// pane one in the shape of a real Orca read (Claude Code's plugin pane at the right), with
// neutral placeholder text.

const MOCK = '┌ 목록 ┐\n│ 항목 │\n└──────┘';
const PREVIEW_INPUT = {
  questions: [
    {
      question:
        "예시 화면을 어디에 둘까요? 참고로 지금 목록(sample, 8000) 안내문은 '모델 호출·실행기 없는 공용 바탕'으로 범위를 정해 둔 상태입니다.",
      header: '구역',
      multiSelect: false,
      options: [
        { label: '샘플 목록에 화면 추가 (추천)', description: '목록 안에 둔다', preview: MOCK },
        { label: '별도 폴더에 단독 예시', description: '따로 둔다', preview: '단독 화면' },
      ],
    },
    {
      question: '어떤 순서로 진행할까요? (여러 개)',
      header: '작업 순서',
      multiSelect: true,
      options: [
        { label: '먼저 뼈대', description: '화면 틀부터 만든다' },
        { label: '다음 연결', description: '도구 호출을 잇는다' },
      ],
    },
    {
      question: '어느 저장소에 둘까요?',
      header: '저장소',
      multiSelect: false,
      options: [{ label: '지금 저장소' }, { label: '새 저장소' }],
    },
  ],
};
const LONE_INPUT = {
  questions: [
    {
      question: '제목을 어떻게 놓을까요?',
      header: '정렬',
      multiSelect: false,
      options: [
        { label: '왼쪽 정렬', preview: '┌──────────┐\n│ 제목     │\n│ 본문 ... │\n└──────────┘' },
        { label: '가운데 정렬', preview: '가운데' },
        { label: '오른쪽 정렬', preview: '오른쪽' },
      ],
    },
  ],
};
const q322 = (name: string) => parseDialog(plainScreen(name)) as Dialog;
const asQuestion = (d: Dialog | DialogStateLike) => d as Extract<Dialog, { kind: 'question' }>;
type DialogStateLike = ReturnType<typeof parseDialog>;
const askCall = (input: { questions: unknown[] }) => [call('toolu_q', 'AskUserQuestion', input)];
const withoutPreviews = (input: typeof PREVIEW_INPUT) => ({
  questions: input.questions.map((q) => ({
    ...q,
    options: q.options.map((o) => ({ ...o, preview: undefined })),
  })),
});
const edited = (name: string, edit: (text: string) => string) =>
  parseDialog({ text: edit(plainScreen(name).text) });

test('2.1.322 previews: the left column only, wrapped labels joined, notes and an unnumbered chat row', () => {
  const d = asQuestion(q322('q322-preview-multi'));
  assert.equal(d.kind, 'question');
  assert.equal(d.layout, 'preview');
  assert.equal(d.notes, '');
  assert.deepEqual(d.tabs, [
    { label: '구역', done: false },
    { label: '작업 순서', done: false },
    { label: '저장소', done: false },
  ]);
  // The label wrapped in its 30-cell column reads whole; nothing of the box comes along.
  assert.deepEqual(
    d.rows.map((r) => [r.number, r.label, r.cursor, !!r.aside]),
    [
      [1, '샘플 목록에 화면 추가 (추천)', true, false],
      [2, '별도 폴더에 단독 예시', false, false],
      [3, 'Chat about this', false, true],
    ],
  );
  assert.ok(!d.rows.some((r) => r.input), 'no text row beside previews');
  assert.equal(oneOf(d, askCall(PREVIEW_INPUT)), 'toolu_q');
  // Claude Code's plugin pane at the right (a real Orca read's shape) is cut off first.
  const pane = asQuestion(q322('q322-preview-pane'));
  assert.deepEqual(pane.rows, d.rows);
  assert.deepEqual(pane.tabs, d.tabs);
  assert.equal(pane.question.replace(/\s+/g, ' '), d.question.replace(/\s+/g, ' '));
  assert.equal(oneOf(pane, askCall(PREVIEW_INPUT)), 'toolu_q');
  // A narrow pane: the box cut to fit, the question and footer wrapped; the options the same.
  const narrow = asQuestion(q322('q322-preview-narrow'));
  assert.deepEqual(narrow.rows, d.rows);
  assert.equal(oneOf(narrow, askCall(PREVIEW_INPUT)), 'toolu_q');
  // One question alone: a single chip, no arrows, no Submit tab.
  const lone = asQuestion(q322('q322-preview-single'));
  assert.deepEqual(lone.tabs, [{ label: '정렬', done: false }]);
  assert.deepEqual(
    lone.rows.map((r) => r.label),
    ['왼쪽 정렬', '가운데 정렬', '오른쪽 정렬', 'Chat about this'],
  );
  assert.equal(oneOf(lone, askCall(LONE_INPUT)), 'toolu_q');
  // The form's multi-select question keeps the list layout; the first tab shows it answered.
  const multi = asQuestion(q322('q322-multiselect-next'));
  assert.equal(multi.layout, undefined);
  assert.equal(multi.multi, true);
  assert.deepEqual(
    multi.tabs.map((t) => t.done),
    [true, false, false],
  );
  assert.equal(oneOf(multi, askCall(PREVIEW_INPUT)), 'toolu_q');
});

test('2.1.322 previews: identified against the recorded call exactly as before', () => {
  const d = q322('q322-preview-multi');
  // The record says no previews: the layout does not fit the question.
  assert.equal(oneOf(d, askCall(withoutPreviews(PREVIEW_INPUT))), 'none');
  // Another label, another question, another header: not this call.
  const relabeled = structuredClone(PREVIEW_INPUT);
  relabeled.questions[0].options[1].label = '별도 폴더에 단독 데모';
  assert.equal(oneOf(d, askCall(relabeled)), 'none');
  const reheaded = structuredClone(PREVIEW_INPUT);
  reheaded.questions[2].header = '브랜치';
  assert.equal(oneOf(d, askCall(reheaded)), 'none');
  // A header the bar had to cut (`…`) still names its question; a wrong start does not.
  const cut = edited('q322-preview-multi', (t) => t.replace('☐ 작업 순서', '☐ 작업…'));
  assert.equal(oneOf(cut as Dialog, askCall(PREVIEW_INPUT)), 'toolu_q');
  const wrong = edited('q322-preview-multi', (t) => t.replace('☐ 작업 순서', '☐ 저장…'));
  assert.equal(oneOf(wrong as Dialog, askCall(PREVIEW_INPUT)), 'none');
});

test('2.1.322 previews: notes, the marker on chat, a tick, and anything else beside the options', () => {
  const notes = asQuestion(
    edited('q322-preview-multi', (t) => t.replace('press n to add notes', '색은 파랑으로')),
  );
  assert.equal(notes.notes, '색은 파랑으로');
  // The notes being typed (the input's placeholder) is not "no notes".
  const typing = asQuestion(
    edited('q322-preview-multi', (t) =>
      t.replace('press n to add notes', 'Add notes on this design…'),
    ),
  );
  assert.equal(typing.notes, 'Add notes on this design…');
  // On "Chat about this" the option keeps its marker too: both are read.
  const chat = asQuestion(
    edited('q322-preview-multi', (t) => t.replace('  Chat about this', '❯ Chat about this')),
  );
  assert.deepEqual(
    chat.rows.map((r) => r.cursor),
    [true, false, true],
  );
  // An option answered before shows a tick after its label.
  const ticked = asQuestion(
    edited('q322-preview-multi', (t) =>
      t.replace('  2. 별도 폴더에 단독 예시  ', '  2. 별도 폴더에 단독 예시 ✔'),
    ),
  );
  assert.equal(ticked.rows[1].label, '별도 폴더에 단독 예시');
  assert.equal(ticked.rows[1].picked, true);
  // Words beside the options where the box should be: not read as this layout.
  const odd = edited('q322-preview-multi', (t) =>
    t.replace(/(\n {2}2\. 별도 폴더에 단독 예시 {8})│/, '$1x'),
  );
  assert.equal(odd.kind, 'unknown');
});

test('The plugin-pane cut leaves every earlier capture as it was', () => {
  for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith('.plain.txt'))) {
    if (file.startsWith('q322-preview-pane')) continue;
    const lines = readFileSync(path.join(FIXTURES, file), 'utf8')
      .split('\n')
      .map((l) => l.trimEnd());
    assert.deepEqual(withoutSidePane(lines), lines, file);
  }
});

const PREVIEW_SHOWN = shownQuestions(PREVIEW_INPUT as { questions: Question[] });

test('2.1.322 previews: one question answered with one arrow and Enter', async () => {
  const {
    result: r,
    sim,
    calls,
  } = await answer(
    QUESTION(LONE_INPUT),
    shownQuestions(LONE_INPUT as { questions: Question[] }),
    [ask(LONE_INPUT)],
    { answers: [{ options: [1] }] },
  );
  assert.deepEqual(r, { status: 'answered', message: 'tmux work:1.0에서 답했어요' });
  assert.deepEqual(sim.answer, { '제목을 어떻게 놓을까요?': '가운데 정렬' });
  assert.deepEqual(keysOf(calls), ['Down', 'Enter']);
});

test('2.1.322 previews: a form of three, each question verified on its tab, then Submit', async () => {
  for (const host of ['tmux', 'orca'] as const) {
    const { result: r, sim } = await answer(
      QUESTION(PREVIEW_INPUT),
      PREVIEW_SHOWN,
      [ask(PREVIEW_INPUT)],
      { answers: [{ options: [1] }, { options: [0, 1] }, { options: [0] }] },
      (s) => {
        // Orca reads Claude Code's plugin pane with the dialog (as measured).
        s.pane = host === 'orca';
        // Its review wraps inside the narrower main area too (the simulator counts characters).
        if (s.pane) s.reviewWidth = 55;
      },
      { host },
    );
    assert.equal((r as { status: string }).status, 'answered', host);
    assert.deepEqual(sim.answer, {
      [PREVIEW_INPUT.questions[0].question]: '별도 폴더에 단독 예시',
      '어떤 순서로 진행할까요? (여러 개)': '먼저 뼈대, 다음 연결',
      '어느 저장소에 둘까요?': '지금 저장소',
    });
    // Down + Enter (preview), Space ↓ Space → (multi), Enter (list), Enter on Submit answers.
    assert.deepEqual(sim.keys, [
      'Down',
      'Enter',
      'Space',
      'Down',
      'Space',
      'Right',
      'Enter',
      'Enter',
    ]);
  }
});

test('2.1.322 previews: a step that does not show on screen stops the form mid-way', async () => {
  const pick = { answers: [{ options: [1] }, { options: [0] }, { options: [0] }] };
  // The first question's tab never turns `☒`: nothing after its Enter.
  const unmarked = await answer(
    QUESTION(PREVIEW_INPUT),
    PREVIEW_SHOWN,
    [ask(PREVIEW_INPUT)],
    pick,
    (s) => {
      s.unmarked = true;
    },
  );
  assert.match(failed(unmarked.result), /제대로 반영되지 않아.*일부 키를 눌렀으니/);
  assert.deepEqual(unmarked.sim.keys, ['Down', 'Enter']);
  assert.equal(unmarked.sim.answer, null);
  // The next question turns into another one: stopped, said that it changed.
  const changed = await answer(
    QUESTION(PREVIEW_INPUT),
    PREVIEW_SHOWN,
    [ask(PREVIEW_INPUT)],
    pick,
    (s) => {
      s.onKey = (sim) => {
        if (sim.keys.length === 2 && sim.shown.kind === 'question')
          sim.shown.questions[1] = { ...sim.shown.questions[1], question: '다른 질문?' };
      };
    },
  );
  assert.match(failed(changed.result), /화면이 바뀌어 멈췄어요/);
  assert.deepEqual(changed.sim.keys, ['Down', 'Enter']);
  // Notes typed in the terminal go with the answer: left to the terminal, no key pressed.
  const noted = await answer(
    QUESTION(PREVIEW_INPUT),
    PREVIEW_SHOWN,
    [ask(PREVIEW_INPUT)],
    pick,
    (s) => {
      s.notes[0] = '파랑으로';
    },
  );
  assert.match(failed(noted.result), /노트를 썼거나 쓰는 중이에요/);
  assert.equal(noted.sim.keys.length, 0);
  // No typed answer beside previews: there is no text row.
  const typed = await answer(
    QUESTION(LONE_INPUT),
    shownQuestions(LONE_INPUT as { questions: Question[] }),
    [ask(LONE_INPUT)],
    {
      answers: [{ other: '직접 쓴 답' }],
    },
  );
  assert.match(failed(typed.result), /한 번짜리 선택지가 아니에요/);
  assert.equal(typed.sim.keys.length, 0);
});

test('Chat about this: onto the row one arrow at a time, then Enter; nothing typed there', async () => {
  // Beside previews: ↓ past the last option reaches it.
  const preview = await answer(QUESTION(PREVIEW_INPUT), PREVIEW_SHOWN, [ask(PREVIEW_INPUT)], {
    chat: true,
  });
  assert.deepEqual(preview.result, {
    status: 'answered',
    message:
      'tmux work:1.0에서 질문 창을 닫고 채팅으로 넘겼어요. Claude가 무엇을 이야기할지 물으면 채팅으로 답해 주세요.',
  });
  assert.equal(preview.sim.answer, 'chat');
  assert.deepEqual(keysOf(preview.calls), ['Down', 'Down', 'Enter']);
  assert.ok(!preview.calls.some((c) => c.includes('paste-buffer')));
  // The list layout: past the text row, below the rule.
  const list = await answer(
    QUESTION(COLOR_INPUT),
    shownQuestions(COLOR_INPUT),
    [ask(COLOR_INPUT)],
    {
      chat: true,
    },
  );
  assert.equal(list.sim.answer, 'chat');
  assert.deepEqual(keysOf(list.calls), ['Down', 'Down', 'Down', 'Down', 'Enter']);
  // Already partly answered in the terminal: those picks would go along, so it is left there.
  const partial = await answer(
    QUESTION(FRUITS_INPUT),
    shownQuestions(FRUITS_INPUT),
    [ask(FRUITS_INPUT)],
    { chat: true },
    (sim) => {
      sim.key('Space');
      sim.keys = [];
    },
  );
  assert.match(failed(partial.result), /이미 고르던 답/);
  assert.equal(partial.sim.keys.length, 0);
  // A chat choice carries nothing else, and only questions have it.
  const mixed = await answer(
    QUESTION(COLOR_INPUT),
    shownQuestions(COLOR_INPUT),
    [ask(COLOR_INPUT)],
    {
      chat: true,
      answers: [{ options: [0] }],
    },
  );
  assert.match(failed(mixed.result), /한 번짜리 선택지가 아니에요/);
  assert.equal(mixed.sim.keys.length, 0);
  const plan = await answer(PLAN, { kind: 'plan', plan: PLAN_INPUT.plan }, [planCall], {
    kind: 'question',
    chat: true,
  });
  assert.ok(plan.result instanceof Error);
  assert.equal(plan.sim.keys.length, 0);
});

test('The card hears why a question takes no typed answer, and that it can chat instead', async () => {
  const sim = new Claude(PREVIEW_SHOWN);
  const h = await harness(sim, { calls: [ask(PREVIEW_INPUT)] });
  try {
    const view = await inspectPrompt(
      claudeCodePrompts,
      asking(QUESTION(PREVIEW_INPUT)),
      h.target,
      'on',
    );
    assert.equal(view.status, 'ready');
    if (view.status === 'ready') {
      assert.deepEqual(view.other, [false, false, true]);
      assert.deepEqual(view.noText, ['preview', 'multi', null]);
      assert.equal(view.chat, true);
    }
    // A dialog-like screen it cannot read is said to be one, never "no prompt open".
    sim.notes[0] = 'x';
    const odd = new Claude(PREVIEW_SHOWN);
    odd.render = () =>
      plainScreen('q322-preview-multi').text.replace(
        /(\n {2}2\. 별도 폴더에 단독 예시 {8})│/,
        '$1x',
      );
    const h2 = await harness(odd, { calls: [ask(PREVIEW_INPUT)] });
    try {
      const unknown = await inspectPrompt(
        claudeCodePrompts,
        asking(QUESTION(PREVIEW_INPUT)),
        h2.target,
        'on',
      );
      assert.equal(unknown.status === 'unavailable' && unknown.reason, 'unknown');
    } finally {
      await h2.done();
    }
    assert.equal(sim.keys.length, 0);
  } finally {
    await h.done();
  }
});
