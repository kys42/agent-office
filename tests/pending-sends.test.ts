import test from 'node:test';
import assert from 'node:assert/strict';
import { settleSends, type PendingSend } from '../src/lib/pendingSends.js';

const send = (id: string, text: string, at: number, sessionId = 's1'): PendingSend => ({
  id,
  sessionId,
  text,
  at,
});
const user = (id: string, text: string, at: number) => ({ id, kind: 'user', text, at });

test('One recorded request settles one send, even over later updates', () => {
  const taken = new Set<string>();
  let list = [send('a', '계속해 줘', 1000), send('b', '계속해 줘', 2000)];
  list = settleSends(list, 's1', [user('u1', '계속해 줘', 3000)], taken, 4000);
  assert.deepEqual(
    list.map((p) => p.id),
    ['b'],
  );
  // An unrelated update re-reads the same record: it must not clear the second send.
  list = settleSends(list, 's1', [user('u1', '계속해 줘', 3000)], taken, 5000);
  assert.deepEqual(
    list.map((p) => p.id),
    ['b'],
  );
  list = settleSends(
    list,
    's1',
    [user('u1', '계속해 줘', 3000), user('u2', '계속해 줘', 6000)],
    taken,
    7000,
  );
  assert.deepEqual(list, []);
});

test('Sends wait for their own session, match tidied words, ignore older records and expire', () => {
  const taken = new Set<string>();
  const long = 'x'.repeat(80);
  let list = [
    send('a', '테스트  돌려\n줘', 10_000),
    send('b', long, 10_000),
    send('c', '다른 세션', 10_000, 's2'),
    send('d', '예전 말', 20_000),
  ];
  list = settleSends(
    list,
    's1',
    [
      user('u0', '예전 말', 0),
      user('u1', '테스트 돌려 줘', 11_000),
      user('u2', `${'x'.repeat(70)}…`, 11_000),
    ],
    taken,
    12_000,
  );
  // A short word typed in the terminal does not settle a longer send.
  const short = settleSends(
    [send('s', 'ok then run tests', 30_000)],
    's1',
    [user('u3', 'ok', 31_000)],
    taken,
    32_000,
  );
  assert.equal(short.length, 1);
  assert.deepEqual(
    list.map((p) => p.id),
    ['c', 'd'],
  );
  assert.deepEqual(settleSends(list, 's1', [], taken, 10_000 + 31 * 60_000), []);
});

test('A send with images settles against the record each agent writes around its text', () => {
  const dir = '/Users/me/Library/Application Support/Agent Office/attachments';
  const a = `${dir}/11111111-2222-4333-8444-555555555555.png`;
  const b = `${dir}/66666666-7777-4888-9999-000000000000.jpg`;
  const settles = (record: string, text: string, images: number) =>
    settleSends(
      [{ ...send('p', text, 1000), images }],
      's1',
      [user('u', record, 2000)],
      new Set(),
      3000,
    ).length === 0;
  // Claude Code: its own placeholders (or a path it did not attach) before the text.
  assert.ok(settles('[Image #1] [Image #2]이 화면 봐줘', '이 화면 봐줘', 2));
  assert.ok(settles(`[Image #3] ${b} 봐줘`, '봐줘', 2));
  assert.ok(settles('[Image #1]', '', 1));
  // Codex CLI queue: the text, a blank line, then one saved path per line.
  assert.ok(settles(`이 화면 봐줘\n\n${a}\n${b}`, '이 화면 봐줘', 2));
  assert.ok(settles(a, '', 1));
  // Codex Desktop: the text alone.
  assert.ok(settles('이 화면 봐줘', '이 화면 봐줘', 2));
  // Not another number of images, other text, or paths that are not the app's own.
  assert.ok(!settles('[Image #1]이 화면 봐줘', '이 화면 봐줘', 2));
  assert.ok(!settles('[Image #1] [Image #2]이 화면 봐줘 그리고', '이 화면 봐줘', 2));
  assert.ok(!settles(`이 화면 봐줘\n\n${a}`, '이 화면 봐줘', 2));
  assert.ok(!settles('이 화면 봐줘\n\n/tmp/x.png', '이 화면 봐줘', 1));
  assert.ok(!settles('[Image #1] 봐줘', '봐줘', 0));
});
