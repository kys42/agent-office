import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseStyledScreen } from '../desktop/composer/index.js';
import {
  claudeCodePrompts,
  parseDialog,
  promptsFor,
  type Dialog,
  type PromptKey,
} from '../desktop/prompts/index.js';
import { answerRequest, inspectPrompt, type AnswerDeps } from '../desktop/answers.js';
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

const COLOR: InputRequest = {
  kind: 'question',
  questions: [
    {
      header: 'Color',
      question: 'Pick a color',
      multiSelect: false,
      options: [
        { label: 'Red', description: '따뜻하고 강렬한 색' },
        { label: 'Green', description: '자연스럽고 차분한 색' },
        { label: 'Blue', description: '시원하고 안정적인 색' },
      ],
    },
  ],
};
const FRUITS: InputRequest = {
  kind: 'question',
  questions: [
    {
      header: 'Fruit',
      question: 'Pick fruits',
      multiSelect: true,
      options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }],
    },
  ],
};
const TWO: InputRequest = {
  kind: 'question',
  questions: [
    {
      header: 'Color',
      question: 'Pick a color',
      multiSelect: false,
      options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
    },
    {
      header: 'Size',
      question: 'Pick a size',
      multiSelect: false,
      options: [{ label: 'Small' }, { label: 'Medium' }, { label: 'Large' }],
    },
  ],
};
const PLAN: InputRequest = {
  kind: 'plan',
  plan: '1. 작업 디렉터리에 `hello.txt` 파일을 만들고 내용으로 "hi"를 쓴다.\n2. 확인: `cat hello.txt`를 실행해 출력이 `hi`인지 본다.\n',
  planFile: '/Users/someone.xyz/.claude/plans/plan-to-create-hello-txt-linear-tome.md',
};
const BASH: InputRequest = {
  kind: 'permission',
  tool: 'Bash',
  summary: 'echo hi > hello.txt',
  detail: 'Write hi to a text file',
};
const WRITE: InputRequest = { kind: 'permission', tool: 'Write', summary: '/tmp/p/hello.txt' };

test('Every captured dialog reads the same from plain and styled captures', () => {
  const names = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.e.txt'))
    .map((f) => f.slice(0, -'.e.txt'.length));
  assert.ok(names.length >= 20);
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
  assert.equal(claudeCodePrompts.takesText(d), true);
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
  assert.equal(claudeCodePrompts.takesText(multi), false);
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

test('Reviews, plans and permission prompts', () => {
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
  assert.deepEqual(claudeCodePrompts.choices(plan), [
    { number: 1, label: 'Yes, and use auto mode', role: 'always' },
    { number: 2, label: 'Yes, manually approve edits', role: 'allow' },
    { number: 3, label: 'Tell Claude what to change', role: 'text' },
  ]);
  const bash = dialog('e2-open');
  assert.equal(bash.kind, 'permission');
  if (bash.kind !== 'permission') return;
  assert.equal(bash.title, 'Bash command');
  assert.equal(bash.ask, 'Do you want to proceed?');
  assert.ok(bash.body.includes('echo hi > hello.txt'));
  const choices = claudeCodePrompts.choices(bash);
  assert.deepEqual(
    choices.map((c) => [c.number, c.role]),
    [
      [1, 'allow'],
      [2, 'always'],
      [3, 'always'],
      [4, 'deny'],
    ],
  );
  // A label wrapped at the pane's edge reads whole (the path breaks mid-word).
  assert.ok(
    choices[1].label.endsWith(
      '/ec84eaa1-6d0f-496d-a35d-8dcf586a1cf8/scratchpad/measure/proj-e from this project',
    ),
  );
  // Narrow pane: the wrapped choice reads whole too.
  assert.equal(
    claudeCodePrompts.choices(dialog('g3-narrow-write'))[1].label,
    'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
  );
  // Tab turned Yes into a text row: never a plain Yes.
  assert.equal(claudeCodePrompts.choices(dialog('f5-tab-amend'))[0].role, 'text');
});

test('A hook that rewrote the command shows another command: never answered from here', () => {
  // Measured: a PreToolUse hook turned `cat <file>` into `rtk read <file>`; the long command
  // wraps behind a faint border, mid-path.
  const file =
    '/private/tmp/claude-501/-Users-someone-xyz-orca-workspaces-agent-office-global/ec84eaa1-6d0f-496d-a35d-8dcf586a1cf8/scratchpad/measure/proj-e/e2e-plan.txt';
  const d = dialog('k-bash-hook');
  assert.equal(d.kind, 'permission');
  assert.ok(
    claudeCodePrompts.matches(d, { kind: 'permission', tool: 'Bash', summary: `rtk read ${file}` }),
  );
  assert.ok(
    !claudeCodePrompts.matches(d, { kind: 'permission', tool: 'Bash', summary: `cat ${file}` }),
  );
  assert.equal(claudeCodePrompts.choices(d)[1].label, 'Yes, and don’t ask again for: rtk read *');
});

test('Orca reports the same dialog (no blank lines, no draft)', () => {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES, 'o5-orca-bash.json'), 'utf8'));
  const d = parseDialog({ text: raw.result.terminal.tail.join('\n') });
  assert.equal(d.kind, 'permission');
  assert.ok(claudeCodePrompts.matches(d as Dialog, { ...BASH, summary: 'echo hi > hello3.txt' }));
});

test('No dialog: the open prompt, an unreadable screen, or nothing on it', () => {
  assert.deepEqual(parseDialog(styled('a3-q-after-other')), { kind: 'closed' });
  assert.deepEqual(parseDialog(null), { kind: 'unreadable' });
  assert.deepEqual(parseDialog({ text: '' }), { kind: 'closed' });
  // A numbered list in the output above the open prompt is no dialog.
  assert.deepEqual(
    parseDialog({
      text: [
        '⏺ Steps:',
        '  1. one',
        '  2. two',
        '─'.repeat(40),
        '❯ ',
        '─'.repeat(40),
        '  ⏸ manual',
      ].join('\n'),
    }),
    { kind: 'closed' },
  );
});

test('The dialog must ask exactly what the record asked', () => {
  const m = claudeCodePrompts.matches;
  assert.ok(m(dialog('a2-q-open'), COLOR), 'case 1');
  assert.ok(m(dialog('b1-open'), FRUITS), 'case 2');
  assert.ok(m(dialog('c1-open'), TWO), 'case 3');
  assert.ok(m(dialog('c2-digit2'), TWO), 'case 4');
  assert.ok(m(dialog('c5-review'), TWO), 'case 5');
  assert.ok(m(dialog('d1-open'), PLAN), 'case 6');
  assert.ok(
    m(dialog('d1-open'), { kind: 'plan', plan: PLAN.kind === 'plan' ? PLAN.plan : '' }),
    'case 7',
  );
  assert.ok(m(dialog('e2-open'), BASH), 'case 8');
  assert.ok(m(dialog('f1-write-open'), WRITE), 'case 9');
  // Other words, other options, another kind, another command or file: never.
  const other = (q: Partial<Extract<InputRequest, { kind: 'question' }>['questions'][0]>) =>
    ({
      kind: 'question',
      questions: [{ ...(COLOR as Extract<InputRequest, { kind: 'question' }>).questions[0], ...q }],
    }) as InputRequest;
  assert.ok(!m(dialog('a2-q-open'), other({ question: 'Pick a colour' })), 'case 10');
  assert.ok(
    !m(dialog('a2-q-open'), other({ options: [{ label: 'Red' }, { label: 'Green' }] })),
    'case 11',
  );
  assert.ok(!m(dialog('a2-q-open'), other({ multiSelect: true })), 'case 12');
  assert.ok(!m(dialog('a2-q-open'), other({ header: 'Colour' })), 'case 13');
  assert.ok(!m(dialog('a2-q-open'), FRUITS), 'case 14');
  assert.ok(!m(dialog('a2-q-open'), BASH), 'case 15');
  assert.ok(!m(dialog('e2-open'), { ...BASH, summary: 'echo hi > other.txt' }), 'case 16');
  assert.ok(!m(dialog('e2-open'), { ...BASH, summary: 'rm -rf hello.txt' }), 'case 17');
  assert.ok(!m(dialog('e2-open'), WRITE), 'case 18');
  assert.ok(!m(dialog('f1-write-open'), { ...WRITE, summary: '/tmp/p/other.txt' }), 'case 19');
  assert.ok(
    !m(dialog('d1-open'), {
      ...PLAN,
      planFile: '/x/.claude/plans/another-plan.md',
    } as InputRequest),
    'case 20',
  );
  // A long label wrapped in a narrow pane no longer equals the recorded option: refused.
  assert.ok(
    !m(dialog('g1-narrow'), {
      kind: 'question',
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
  );
});

// ── A simulated Claude Code dialog (the measured drawing and key behaviour) ────────────────

const RULE = '─'.repeat(120);
type Answer = Record<string, string> | 'rejected' | 'chat' | { choice: string };

/** One dialog as Claude Code 2.1.296 draws it and reacts to keys (TERMINAL.md, measured). */
class Claude {
  answer: Answer | null = null;
  keys: string[] = [];
  /** Called after every key: tests change the screen mid-way. */
  onKey?: (sim: Claude) => void;
  private q = 0;
  private review = false;
  private cursor: number[];
  private checked: boolean[][];
  private typed: string[];
  private picked: (string | null)[];
  private choice = 0;
  constructor(public request: InputRequest) {
    const qs = request.kind === 'question' ? request.questions : [];
    this.cursor = qs.map(() => 0);
    this.checked = qs.map((q) => q.options.map(() => false));
    this.typed = qs.map(() => '');
    this.picked = qs.map(() => null);
  }
  get closed() {
    return this.answer !== null;
  }
  private questions() {
    return this.request.kind === 'question' ? this.request.questions : [];
  }
  /** Stops: options, the text row, (multi) Submit, Chat about this. */
  private stops(q = this.q) {
    const question = this.questions()[q];
    return question.options.length + 1 + (question.multiSelect ? 1 : 0) + 1;
  }
  render(): string {
    if (this.closed) return ['⏺ Done.', RULE, '❯ ', RULE, '  ⏸ manual mode on'].join('\n');
    const r = this.request;
    if (r.kind === 'plan') {
      const rows = [
        'Yes, and use auto mode',
        'Yes, manually approve edits',
        'Tell Claude what to change',
      ];
      return [
        '  ' + '─'.repeat(116),
        '   Ready to code?',
        '',
        "   Here is Claude's plan:",
        '  ' + '╌'.repeat(116),
        ...r.plan
          .trim()
          .split('\n')
          .map((l) => '   ' + l.replace(/`/g, '')),
        '  ' + '╌'.repeat(116),
        '  ' + '─'.repeat(116),
        '   Claude has written up a plan and is ready to execute. Would you like to proceed?',
        '',
        ...rows.map((l, i) => `   ${i === this.choice ? '❯' : ' '} ${i + 1}. ${l}`),
        '        shift+tab to approve with this feedback',
        '',
        '   ctrl+g to edit in VS Code · ~/.claude/plans/plan-to-create-hello-txt-linear-tome.md',
      ].join('\n');
    }
    if (r.kind === 'permission') {
      const rows = ['Yes', "Yes, and don't ask again for echo commands in this project", 'No'];
      return [
        RULE,
        ' Bash command',
        r.detail ?? '',
        '╌'.repeat(120),
        ' ' + r.summary,
        '╌'.repeat(120),
        ' Do you want to proceed?',
        ...rows.map((l, i) => ` ${i === this.choice ? '❯' : ' '} ${i + 1}. ${l}`),
        '',
        ' Esc to cancel · Tab to amend',
      ].join('\n');
    }
    const qs = this.questions();
    const many = qs.length > 1 || qs.some((q) => q.multiSelect);
    const bar = many
      ? `←  ${qs.map((q, i) => `${this.done(i) ? '☒' : '☐'} ${q.header}`).join('  ')}  ✔ Submit  →`
      : ` ☐ ${qs[0].header}`;
    if (this.review) {
      const all = qs.every((_, i) => this.done(i));
      return [
        RULE,
        bar,
        '',
        'Review your answers',
        ...(all ? [] : ['', '⚠ You have not answered all questions']),
        '',
        ...qs.flatMap((q, i) =>
          this.done(i) ? [` ● ${q.question}`, `   → ${this.answerOf(i)}`] : [],
        ),
        '',
        'Ready to submit your answers?',
        '',
        `${this.choice === 0 ? '❯' : ' '} 1. Submit answers`,
        `${this.choice === 1 ? '❯' : ' '} 2. Cancel`,
      ].join('\n');
    }
    const q = qs[this.q];
    const c = this.cursor[this.q];
    const n = q.options.length;
    const mark = (i: number) => (c === i ? '❯' : ' ');
    const box = (i: number) => (q.multiSelect ? `[${this.checked[this.q][i] ? '✔' : ' '}] ` : '');
    return [
      RULE,
      bar,
      '',
      q.question,
      '',
      ...q.options.flatMap((o, i) => [
        `${mark(i)} ${i + 1}. ${box(i)}${o.label}`,
        ...(o.description ? [`     ${o.description}`] : []),
      ]),
      `${mark(n)} ${n + 1}. ${q.multiSelect ? '[ ] ' : ''}${this.typed[this.q] || (q.multiSelect ? 'Type something' : 'Type something.')}`,
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
          .map((o) => o.label)
          .join(', ')
      : (this.picked[i] ?? '');
  }
  private next() {
    const qs = this.questions();
    if (qs.length === 1 && !qs[0].multiSelect) return this.submit();
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
    if (this.closed || this.review || this.request.kind !== 'question') return;
    if (this.cursor[this.q] === this.questions()[this.q].options.length) this.typed[this.q] += text;
  }
  key(name: string) {
    this.keys.push(name);
    const r = this.request;
    if (this.closed) return;
    if (r.kind !== 'question' || this.review) {
      const rows = r.kind === 'question' ? 2 : 3;
      if (name === 'Down') this.choice = Math.min(rows - 1, this.choice + 1);
      if (name === 'Up') this.choice = Math.max(0, this.choice - 1);
      if (name === 'Enter') {
        if (r.kind === 'question') {
          if (this.choice === 0) this.submit();
          else this.answer = 'rejected';
        } else this.answer = { choice: String(this.choice + 1) };
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

const SID = '6dd9f1ee-30b0-4650-9b8f-6f2961115e8b';
const START = 'Tue Oct 13 06:41:08 2026';
const SOCKET = '/private/tmp/tmux-501/default';
const ORCA = 'term_205af179-74b5-4973-9cd8-0fb07bf63fa9';

/** Fake CLIs around a simulated Claude: tmux or Orca, the process table and its record. */
async function harness(
  sim: Claude,
  options: { host?: 'tmux' | 'orca'; fg?: () => string; status?: () => string } = {},
) {
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
  const deps: AnswerDeps = {
    sessionsDir: dir,
    codexHome: '/nonexistent',
    alive: () => true,
    bin: (name) => `/bin/${name}`,
    wait: async () => {
      await writeFile(path.join(dir, '4242.json'), record());
    },
    readTail: async () => (sim.closed ? `{"tool_use_id":"toolu_q"}` : ''),
    run: async (file: string, args: string[], run?: RunOptions) => {
      calls.push([file, ...args]);
      await writeFile(path.join(dir, '4242.json'), record());
      if (file === '/bin/ps') {
        if (args.includes('lstart=')) return `${START}\n`;
        if (args.includes('stat=,pgid=,tpgid=')) return `${options.fg?.() ?? 'S+ 4242 4242'}\n`;
      }
      if (file === '/bin/tmux') {
        if (args.some((a) => a.startsWith('#{pane_in_mode}'))) return '0 40\n';
        if (args.includes('capture-pane')) return sim.render();
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
                tail: sim
                  .render()
                  .split('\n')
                  .filter((l) => l.trim()),
                source: 'screen',
              },
            },
          });
        if (args[1] === 'send') {
          const text = args.find((a) => a.startsWith('--text='))?.slice(7) ?? '';
          if (text.startsWith('\x1b[200~')) sim.type(text.slice(6, -6));
          else
            for (const key of text.match(/\x1b\[[ABCD]|./gs) ?? [])
              sim.key(
                {
                  '\x1b[A': 'Up',
                  '\x1b[B': 'Down',
                  '\x1b[C': 'Right',
                  ' ': 'Space',
                  '\r': 'Enter',
                }[key] ?? key,
              );
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
  return { deps, live, calls, done: () => rm(dir, { recursive: true, force: true }) };
}

const asking = (request: InputRequest): AskingEvent => ({
  id: 'toolu_q:tool0',
  at: 1,
  kind: 'tool',
  text: 'tool',
  tool:
    request.kind === 'plan'
      ? 'ExitPlanMode'
      : request.kind === 'question'
        ? 'AskUserQuestion'
        : 'Bash',
  intent: 'request-input',
  callId: 'toolu_q',
  sourceRef: 'x',
  request,
});

async function answer(
  request: InputRequest,
  choice: Record<string, unknown>,
  setup: (sim: Claude) => void = () => {},
  options: Parameters<typeof harness>[1] = {},
) {
  const sim = new Claude(request);
  setup(sim);
  const h = await harness(sim, options);
  try {
    const event = asking(request);
    const result = await answerRequest(
      claudeCodePrompts,
      event,
      h.live,
      { eventId: event.id, kind: request.kind, ...choice },
      {
        sourcePath: '/tmp/x.jsonl',
        deps: h.deps,
      },
    ).catch((e: Error) => e);
    return { result, sim, calls: h.calls };
  } finally {
    await h.done();
  }
}
const keysOf = (calls: string[][]) =>
  calls
    .filter((c) => c.includes('send-keys'))
    .map((c) => c.slice(c.indexOf('send-keys') + 3).join(' '));

test('A single question: arrows to the option, verified, then Enter', async () => {
  const { result, sim, calls } = await answer(COLOR, { answers: [{ options: [2] }] });
  assert.deepEqual(result, { status: 'answered', message: 'tmux work:1.0에서 답했어요' });
  assert.deepEqual(sim.answer, { 'Pick a color': 'Blue' });
  // Never a digit, Tab or Esc: Down twice, then Enter alone.
  assert.deepEqual(keysOf(calls), ['Down Down', 'Enter']);
});

test('Typed words go into the text row, verified before Enter', async () => {
  const { result, sim, calls } = await answer(COLOR, { answers: [{ other: 'teal\nplease' }] });
  assert.equal((result as { status: string }).status, 'answered');
  assert.deepEqual(sim.answer, { 'Pick a color': 'teal please' });
  assert.ok(calls.some((c) => c.includes('paste-buffer') && c.includes('-p')));
  assert.deepEqual(keysOf(calls), ['Down Down Down', 'Enter']);
});

test('Multi-select: Space on each row that differs, then → and the review', async () => {
  const { result, sim, calls } = await answer(FRUITS, { answers: [{ options: [0, 2] }] });
  assert.equal((result as { status: string }).status, 'answered');
  assert.deepEqual(sim.answer, { 'Pick fruits': 'Apple, Cherry' });
  assert.deepEqual(keysOf(calls), ['Space', 'Down Down', 'Space', 'Right', 'Enter']);
});

test('Two questions: each answered in turn, the review checked, then submitted', async () => {
  const { result, sim, calls } = await answer(TWO, {
    answers: [{ options: [1] }, { options: [0] }],
  });
  assert.equal((result as { status: string }).status, 'answered');
  assert.deepEqual(sim.answer, { 'Pick a color': 'Green', 'Pick a size': 'Small' });
  assert.deepEqual(keysOf(calls), ['Down', 'Enter', 'Enter', 'Enter']);
});

test('Plan approval and permission: the row the person saw, by its words', async () => {
  const plan = await answer(PLAN, { number: 2, label: 'Yes, manually approve edits' });
  assert.equal((plan.result as { status: string }).status, 'answered');
  assert.deepEqual(plan.sim.answer, { choice: '2' });
  assert.deepEqual(keysOf(plan.calls), ['Down', 'Enter']);
  const no = await answer(BASH, { number: 3, label: 'No' });
  assert.deepEqual(no.sim.answer, { choice: '3' });
  assert.deepEqual(keysOf(no.calls), ['Down Down', 'Enter']);
  // The text row is never pressed from here, and a label that is not on screen is refused.
  const text = await answer(PLAN, { number: 3, label: 'Tell Claude what to change' });
  assert.match((text.result as Error).message, /화면에 없는 선택지/);
  const wrong = await answer(BASH, { number: 2, label: 'Yes' });
  assert.match((wrong.result as Error).message, /화면에 없는 선택지/);
  assert.equal(wrong.sim.keys.length, 0);
});

test('Orca: the same keys as bytes, Enter as its own submit', async () => {
  const { result, sim, calls } = await answer(BASH, { number: 1, label: 'Yes' }, () => {}, {
    host: 'orca',
  });
  assert.equal((result as { status: string }).status, 'answered');
  assert.deepEqual(sim.answer, { choice: '1' });
  const sends = calls.filter((c) => c[0] === '/bin/orca' && c[2] === 'send');
  assert.deepEqual(
    sends.map((c) => c.slice(3, -1)),
    [[`--terminal=${ORCA}`, '--enter']],
  );
});

test('Refused: another dialog on screen, a dialog that changes mid-way, or Claude losing the terminal', async () => {
  // The screen asks something else: nothing is pressed.
  const other = await answer(BASH, { number: 1, label: 'Yes' }, (sim) => {
    sim.request = { ...BASH, summary: 'rm -rf build' };
  });
  assert.match((other.result as Error).message, /화면의 질문이 달라요/);
  assert.equal(other.sim.keys.length, 0);
  // The dialog turns into another one after the first key: Enter never goes in.
  const changed = await answer(COLOR, { answers: [{ options: [2] }] }, (sim) => {
    sim.onKey = (s) => {
      s.request = { ...BASH };
    };
  });
  assert.match((changed.result as Error).message, /화면이 바뀌어 멈췄어요/);
  assert.ok(!changed.sim.keys.includes('Enter'));
  // Claude stops being in front (ctrl+z) after the first key: stops before the next one.
  let presses = 0;
  const lost = await answer(
    COLOR,
    { answers: [{ options: [2] }] },
    (sim) => {
      sim.onKey = () => presses++;
    },
    { fg: () => (presses ? 'T 4242 4000' : 'S+ 4242 4242') },
  );
  assert.match((lost.result as Error).message, /터미널 앞에 있지 않아요/);
  assert.deepEqual(lost.sim.keys, ['Down', 'Down']);
  // Not waiting any more (the record moved on): nothing is pressed.
  const moved = await answer(COLOR, { answers: [{ options: [0] }] }, () => {}, {
    status: () => 'busy',
  });
  assert.ok(moved.result instanceof Error);
  // Already partly answered in the terminal: left to the terminal.
  const partial = await answer(FRUITS, { answers: [{ options: [1] }] }, (sim) => {
    sim.key('Space');
    sim.keys = [];
  });
  assert.match((partial.result as Error).message, /이미 고르던 답/);
  assert.equal(partial.sim.keys.length, 0);
  // A choice for another request, or options that do not exist.
  const stale = await answer(COLOR, { answers: [{ options: [5] }] });
  assert.match((stale.result as Error).message, /화면에 없는 선택지/);
});

test('The card only offers answers when the screen shows the same request', async () => {
  const sim = new Claude(BASH);
  const h = await harness(sim);
  try {
    const ready = await inspectPrompt(claudeCodePrompts, asking(BASH), h.live, h.deps);
    assert.equal(ready.status, 'ready');
    if (ready.status === 'ready')
      assert.deepEqual(
        ready.choices.map((c) => [c.label, c.role]),
        [
          ['Yes', 'allow'],
          ["Yes, and don't ask again for echo commands in this project", 'always'],
          ['No', 'deny'],
        ],
      );
    const mismatch = await inspectPrompt(
      claudeCodePrompts,
      asking({ ...BASH, summary: 'echo bye' }),
      h.live,
      h.deps,
    );
    assert.deepEqual(mismatch.status === 'unavailable' && mismatch.reason, 'mismatch');
    assert.equal(
      (await inspectPrompt(claudeCodePrompts, asking(BASH), null, h.deps)).status,
      'unavailable',
    );
    // Codex and others: shown, never answered from here.
    const codex = await inspectPrompt(promptsFor('codex'), asking(COLOR), h.live, h.deps);
    assert.deepEqual(codex.status === 'unavailable' && codex.reason, 'unsupported');
    assert.equal(sim.keys.length, 0);
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
});
