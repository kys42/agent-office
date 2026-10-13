import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecords } from '../server/adapters/normalize.js';
import { applyLiveWait, type ClaudeProcess } from '../server/adapters/claude-live.js';
import { inputRequest, permissionRequest, REQUEST_LIMITS } from '../server/adapters/requests.js';
import { openRequest, requestHeadline } from '../src/shared/requests.js';
import { stationSpeech } from '../src/shared/speech.js';
import { localizeSession } from '../src/shared/canonical.js';
import { messagesFor, setLocale } from '../src/shared/i18n/index.js';
import type { InputRequest, Session } from '../src/shared/types.js';

process.env.AGENT_OFFICE_LOCALE = 'ko';
setLocale('ko');
const ko = messagesFor('ko');

const SID = '6dd9f1ee-30b0-4650-9b8f-6f2961115e8b';
const now = Date.now();
const iso = (at: number) => new Date(at).toISOString();
const base = { sessionId: SID, cwd: '/tmp/ask-project' };
const user = (uuid: string, at: number, text: string) => ({
  ...base,
  type: 'user',
  uuid,
  timestamp: iso(at),
  message: { role: 'user', content: text },
});
const toolUse = (uuid: string, at: number, id: string, name: string, input: unknown) => ({
  ...base,
  type: 'assistant',
  uuid,
  timestamp: iso(at),
  message: {
    id: `msg-${uuid}`,
    role: 'assistant',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id, name, input }],
  },
});
const toolResult = (uuid: string, at: number, id: string, text: string, isError = false) => ({
  ...base,
  type: 'user',
  uuid,
  timestamp: iso(at),
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: id, content: text, ...(isError && { is_error: true }) },
    ],
  },
});
const parse = (records: Record<string, unknown>[], provider: 'claude' | 'codex' = 'claude') =>
  parseRecords(records, {
    provider,
    sourcePath: `/tmp/ask-project/${SID}.jsonl`,
    mtime: now,
    now,
  });

/** AskUserQuestion input as Claude Code 2.1.296 wrote it (measured, see TERMINAL.md). */
const COLOR = {
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
const FRUITS = {
  questions: [
    {
      question: 'Pick fruits',
      header: 'Fruit',
      multiSelect: true,
      options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }],
    },
  ],
};

test('An open question keeps its questions and options; an answered one keeps nothing', () => {
  const asking = parse([
    user('u1', now - 5000, 'ask me'),
    toolUse('a1', now - 4000, 'toolu_q', 'AskUserQuestion', COLOR),
  ]);
  const open = openRequest(asking);
  assert.ok(open);
  assert.deepEqual(open.request, {
    kind: 'question',
    questions: [
      {
        header: 'Color',
        question: 'Pick a color',
        multiSelect: false,
        options: COLOR.questions[0].options,
      },
    ],
  });
  assert.equal(asking.status, 'call');
  const answered = parse([
    user('u1', now - 5000, 'ask me'),
    toolUse('a1', now - 4000, 'toolu_q', 'AskUserQuestion', COLOR),
    toolResult(
      'r1',
      now - 3000,
      'toolu_q',
      'Your questions have been answered: "Pick a color"="Blue".',
    ),
  ]);
  assert.equal(openRequest(answered), undefined);
  assert.ok(answered.events.every((e) => !e.request));
  // Event ids never depend on the new field.
  assert.deepEqual(
    asking.events.map((e) => e.id),
    answered.events.slice(0, asking.events.length).map((e) => e.id),
  );
});

test('Multi-select, plans and Codex questions are mapped; bad input is left out', () => {
  assert.equal(
    (inputRequest('AskUserQuestion', FRUITS) as Extract<InputRequest, { kind: 'question' }>)
      .questions[0].multiSelect,
    true,
  );
  assert.deepEqual(
    inputRequest('ExitPlanMode', {
      plan: '# Plan\n\n1. Create hello.txt',
      planFilePath: '/Users/me/.claude/plans/x.md',
    }),
    {
      kind: 'plan',
      plan: '# Plan\n\n1. Create hello.txt',
      planFile: '/Users/me/.claude/plans/x.md',
    },
  );
  // Codex request_user_input: JSON string arguments; options as { label } or plain strings, and
  // the question as `question` or (later builds) `title`.
  assert.deepEqual(
    inputRequest(
      'request_user_input_async',
      JSON.stringify({ questions: [{ title: 'Go ahead?', options: ['Yes', 'Only locally'] }] }),
    ),
    {
      kind: 'question',
      questions: [
        {
          question: 'Go ahead?',
          multiSelect: false,
          options: [{ label: 'Yes' }, { label: 'Only locally' }],
        },
      ],
    },
  );
  assert.equal(inputRequest('AskUserQuestion', {}), undefined);
  assert.equal(inputRequest('AskUserQuestion', '{not json'), undefined);
  assert.equal(inputRequest('ExitPlanMode', { plan: '   ' }), undefined);
  assert.equal(inputRequest('request_user_input', { questions: [{ options: ['x'] }] }), undefined);
});

test('Requests are redacted and capped at rest', () => {
  const secret = `sk-proj-${'a1B2'.repeat(8)}`;
  const r = inputRequest('ExitPlanMode', { plan: `use ${secret}\n${'x'.repeat(30_000)}` });
  assert.ok(r && r.kind === 'plan');
  assert.ok(!r.plan.includes(secret));
  assert.ok(r.plan.includes(ko.shared.redaction.token));
  assert.equal(r.plan.length, REQUEST_LIMITS.plan);
  const many = inputRequest('AskUserQuestion', {
    questions: Array.from({ length: 10 }, (_, i) => ({
      question: `Q${i}`,
      options: Array.from({ length: 20 }, (_, j) => ({ label: `o${j}` })),
    })),
  });
  assert.ok(many && many.kind === 'question');
  assert.equal(many.questions.length, REQUEST_LIMITS.questions);
  assert.equal(many.questions[0].options.length, REQUEST_LIMITS.options);
  const p = permissionRequest('Bash', { command: `curl -H "Authorization: Bearer ${secret}"` });
  assert.ok(p && p.kind === 'permission' && !p.summary.includes(secret));
});

test('A permission prompt shows the pending call: command, file, or a compact input', () => {
  assert.deepEqual(permissionRequest('Bash', { command: 'echo hi', description: 'Print hi' }), {
    kind: 'permission',
    tool: 'Bash',
    summary: 'echo hi',
    detail: 'Print hi',
  });
  assert.deepEqual(permissionRequest('Write', { file_path: '/tmp/p/hello.txt', content: 'hi' }), {
    kind: 'permission',
    tool: 'Write',
    summary: '/tmp/p/hello.txt',
  });
  assert.deepEqual(permissionRequest('WebFetch', { url: 'https://example.com', prompt: 'read' }), {
    kind: 'permission',
    tool: 'WebFetch',
    summary: 'https://example.com',
    detail: 'read',
  });
  assert.deepEqual(permissionRequest('mcp__x__do', { a: 1 }), {
    kind: 'permission',
    tool: 'mcp__x__do',
    summary: '{"a":1}',
  });
});

const waiting = (over: Partial<ClaudeProcess> = {}): ClaudeProcess => ({
  pid: 4242,
  sessionId: SID,
  procStart: 'Tue Oct 13 06:41:08 2026',
  status: 'waiting',
  updatedAt: now - 500,
  statusUpdatedAt: now - 500,
  waitingFor: 'permission prompt',
  ...over,
});

test('The live permission overlay carries what the pending Bash call would run', () => {
  const s = parse([
    user('u1', now - 5000, 'run echo hi'),
    toolUse('a1', now - 4000, 'toolu_b', 'Bash', { command: 'echo hi', description: 'Print hi' }),
  ]);
  // Not waiting yet: a running call is no request (the candidate is not shown).
  assert.equal(openRequest(s), undefined);
  const live = applyLiveWait(s, waiting());
  assert.ok(live);
  const open = openRequest(live);
  assert.deepEqual(open?.request, {
    kind: 'permission',
    tool: 'Bash',
    summary: 'echo hi',
    detail: 'Print hi',
  });
  // The bubble says what it asks, in the display language.
  const speech = stationSpeech(live, []);
  assert.equal(speech.tone, 'attention');
  assert.equal(speech.text, 'Bash 허락할까요: echo hi');
  setLocale('en');
  try {
    assert.equal(requestHeadline(open!.request), 'Allow Bash: echo hi');
  } finally {
    setLocale('ko');
  }
  // Once it ran, nothing of its input is kept.
  const done = parse([
    user('u1', now - 5000, 'say hi in the shell'),
    toolUse('a1', now - 4000, 'toolu_b', 'Bash', { command: 'echo hi' }),
    toolResult('r1', now - 3000, 'toolu_b', 'hi'),
  ]);
  assert.ok(!JSON.stringify(done).includes('echo hi'));
});

test('Codex tool arguments are never kept; its questions are', () => {
  const codex = parse(
    [
      {
        type: 'response_item',
        timestamp: iso(now - 2000),
        payload: {
          type: 'function_call',
          name: 'exec',
          arguments: JSON.stringify({ cmd: 'secret command' }),
          call_id: 'c1',
        },
      },
      {
        type: 'response_item',
        timestamp: iso(now - 1000),
        payload: {
          type: 'function_call',
          name: 'request_user_input',
          arguments: JSON.stringify({
            questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }],
          }),
          call_id: 'c2',
        },
      },
    ],
    'codex',
  );
  assert.ok(!JSON.stringify(codex).includes('secret command'));
  assert.equal(openRequest(codex)?.request.kind, 'question');
  assert.equal(stationSpeech(codex, []).text, 'Ship it?');
});

test('Headlines: first question line, plan approval, and English placeholders on read', () => {
  assert.equal(
    requestHeadline({
      kind: 'question',
      questions: [
        { question: '\nWhich one?\nMore context', multiSelect: false, options: [] },
        { question: 'Size?', multiSelect: false, options: [] },
      ],
    }),
    'Which one? (외 1개)',
  );
  assert.equal(requestHeadline({ kind: 'plan', plan: '# x' }), '플랜 승인');
  const s = parse([
    user('u1', now - 5000, 'plan it'),
    toolUse('a1', now - 4000, 'toolu_p', 'ExitPlanMode', { plan: 'password=hunter2 then go' }),
  ]);
  const plan = openRequest(s)!.request as Extract<InputRequest, { kind: 'plan' }>;
  assert.equal(plan.plan, `password=${ko.shared.redaction.hidden} then go`);
  const shown = openRequest(localizeSession(s as Session, 'en'))!.request as typeof plan;
  assert.equal(shown.plan, 'password=[hidden] then go');
});
