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
