import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecords } from '../server/adapters/normalize.js';
import { activityLabel, messageExcerpt, toolLabel } from '../src/shared/activity.js';
const now = Date.parse('2026-10-04T10:00:00Z');
const opts = { provider: 'codex' as const, sourcePath: '/test/progress.jsonl', mtime: now, now };
const record = (payload: object, offset = 0) => ({
  type: 'response_item',
  payload,
  timestamp: new Date(now + offset).toISOString(),
});
const message = (text: string, role = 'assistant', phase = 'commentary', offset = 0) =>
  record({ type: 'message', role, phase, content: [{ type: 'output_text', text }] }, offset);
const tool = (offset = 1) =>
  record({ type: 'function_call', name: 'exec', call_id: `call-${offset}` }, offset);

test('Progress description survives many tool calls and compact snapshots', () => {
  const s = parseRecords(
    [
      message('로그인 오류를 재현하고 원인을 확인하고 있어요.'),
      ...Array.from({ length: 190 }, (_, i) => tool(i + 1)),
    ],
    { ...opts, now: now + 500 },
  );
  assert.equal(s.action, '로그인 오류를 재현하고 원인을 확인하고 있어요.');
  assert.equal(s.activity?.kind, 'progress');
  assert.equal(s.activity?.tool?.name, 'exec');
  assert.equal(s.events.length, 180);
  assert.ok(!s.events.some((e) => e.kind === 'assistant'));
  assert.equal(activityLabel(s, now + 500), '진행 메시지');
});
test('A new request cannot reuse the previous final answer as current progress', () => {
  const s = parseRecords(
    [
      message('이전 작업을 마쳤어요.', 'assistant', 'final_answer'),
      message('검색 오류도 확인해 줘', 'user', '', 10),
      tool(20),
    ],
    opts,
  );
  assert.equal(s.activity?.kind, 'request');
  assert.equal(s.action, '검색 오류도 확인해 줘');
  assert.equal(activityLabel(s, now), '받은 요청');
});
test('Final answers and stale progress are labelled without claiming current work', () => {
  const progress = parseRecords([message('배포를 준비하고 있어요.'), tool()], opts);
  assert.equal(activityLabel(progress, now + 180_000), '마지막 진행 메시지');
  const done = parseRecords(
    [message('수정했고 테스트를 통과했습니다.', 'assistant', 'final_answer')],
    opts,
  );
  assert.equal(done.activity?.kind, 'reply');
  assert.equal(activityLabel(done, now), '최근 응답');
});
test('Internal analysis never becomes a public message or task description', () => {
  const s = parseRecords(
    [
      message('사용자에게 보이는 진행 설명'),
      message('internal-only', 'assistant', 'analysis', 1),
      tool(2),
    ],
    opts,
  );
  assert.equal(s.action, '사용자에게 보이는 진행 설명');
  assert.ok(!s.events.some((e) => e.text === 'internal-only'));
});
test('Tool-only records use an honest fallback and a separate tool detail', () => {
  const s = parseRecords([tool()], opts);
  assert.equal(s.activity?.kind, 'status');
  assert.match(s.action, /진행 설명은 아직 없어요/);
  assert.equal(toolLabel(s.activity!.tool!.name), '터미널');
});
test('Claude and OpenClaw public messages take precedence over tool blocks', () => {
  for (const provider of ['claude', 'openclaw'] as const) {
    const s = parseRecords(
      [
        {
          type: 'assistant',
          timestamp: new Date(now).toISOString(),
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: '연결 오류의 원인을 확인하고 있습니다.' },
              { type: 'tool_use', name: 'Bash', id: 'test', input: { command: 'secret command' } },
            ],
          },
        },
      ],
      { ...opts, provider },
    );
    assert.equal(s.action, '연결 오류의 원인을 확인하고 있습니다.');
    assert.equal(s.activity?.kind, 'progress');
    assert.equal(toolLabel(s.activity!.tool!.name), '터미널');
    assert.ok(!JSON.stringify(s.activity).includes('secret command'));
  }
});
test('Markdown excerpts stay readable and bounded', () => {
  assert.equal(
    messageExcerpt(
      '## 진행\n**테스트**와 [문서](https://example.com)를 확인해요.\n```sh\nsecret\n```',
    ),
    '진행 테스트와 문서를 확인해요.',
  );
  assert.equal(messageExcerpt('가'.repeat(500)).length, 220);
});
