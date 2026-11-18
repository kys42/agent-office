import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_READ_ATTEMPTS, CARD_READ_BUDGET, CardReads } from '../src/shared/card-reads.js';
import type { OfficeNotice } from '../src/shared/types.js';
const now = Date.now();
const notice = (id: string, patch: Partial<OfficeNotice> = {}): OfficeNotice => ({
  id,
  sessionId: 'a',
  eventId: id,
  kind: 'reply',
  phase: 'final',
  text: '결과',
  at: now,
  receivedAt: now,
  version: 'v1',
  seenAt: null,
  viewedAt: null,
  dismissedAt: null,
  resolvedAt: null,
  bootstrap: false,
  ...patch,
});
const ids = (list: OfficeNotice[]) => list.map((n) => n.id);

test('a reply read while the card is open is not read again when marked unread', () => {
  const reads = new CardReads('a');
  // Already read when the card opened (or read by another window).
  let list = [notice('old', { seenAt: now }), notice('new')];
  reads.observe(list, ['a']);
  assert.deepEqual(ids(reads.due(list, ['a'])), ['new']);
  // Read by the card, then both marked unread on purpose: they stay unread.
  reads.begin([list[1]]);
  assert.deepEqual(ids(reads.due(list, ['a'])), [], 'in flight, not asked twice');
  reads.settle([list[1]], true);
  list = list.map((n) => ({ ...n, seenAt: null }));
  reads.observe(list, ['a']);
  assert.deepEqual(ids(reads.due(list, ['a'])), []);
  // A new version of the same reply is new news.
  const updated = [{ ...list[1], version: 'v2' }];
  assert.deepEqual(ids(reads.due(updated, ['a'])), ['new']);
  // Opened anew, the colleague's unread replies are read again.
  assert.deepEqual(ids(new CardReads('a').due(list, ['a'])), ['old', 'new']);
});

test('a failed receipt is asked again a few times, then left alone', () => {
  const reads = new CardReads('a');
  const list = [notice('r')];
  for (let i = 0; i < CARD_READ_ATTEMPTS; i++) {
    assert.deepEqual(ids(reads.due(list, ['a'])), ['r'], `attempt ${i + 1}`);
    reads.begin(list);
    reads.settle(list, false);
  }
  assert.deepEqual(ids(reads.due(list, ['a'])), []);
});

test('only the colleague’s runs are observed and read; calls are not', () => {
  const reads = new CardReads('a');
  const list = [
    notice('b-read', { sessionId: 'b', seenAt: now }),
    notice('a2', { sessionId: 'a2' }),
    notice('call', { kind: 'attention', phase: undefined }),
  ];
  reads.observe(list, ['a', 'a2']);
  assert.deepEqual(ids(reads.due(list, ['a', 'a2'])), ['a2']);
});

test('A long-open card has a fixed receipt budget without forgetting intentional unread', () => {
  const reads = new CardReads('a');
  const first = Array.from({ length: 100 }, (_, i) => notice(`pending-${i}`));
  reads.begin(reads.due(first, ['a']));
  reads.observe(
    Array.from({ length: CARD_READ_BUDGET * 2 }, (_, i) => notice(`old-${i}`, { seenAt: now })),
    ['a'],
  );
  reads.settle(first, true);
  assert.equal((reads as any).done.size, CARD_READ_BUDGET);
  assert.deepEqual(reads.due([...first, notice('next')], ['a']), []);
  assert.deepEqual(ids(new CardReads('a').due([notice('next')], ['a'])), ['next']);
});
