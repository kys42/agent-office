import test from 'node:test';
import assert from 'node:assert/strict';
import { lastMentions } from '../src/shared/links.js';
import { mergeSessions } from '../server/adapters/merge.js';
import { demoSnapshot } from '../src/lib/demo.js';

const pr = (n: number) => `https://github.com/org/repo/pull/${n}`;

test('A link brought up again counts as recent; the latest ones are kept', () => {
  assert.deepEqual(lastMentions([pr(1), pr(2), pr(1), pr(3)], 12), [pr(2), pr(1), pr(3)]);
  assert.deepEqual(lastMentions([pr(1), pr(2), pr(3), pr(2)], 2), [pr(3), pr(2)]);
  assert.deepEqual(lastMentions([], 12), []);
});

test('Merged records list the links the newer record mentioned last', () => {
  const base = demoSnapshot().sessions[0];
  const older = { ...base, updatedAt: 1000, observedAt: 1000, artifacts: [pr(886), pr(889)] };
  const newer = {
    ...base,
    updatedAt: 2000,
    observedAt: 2000,
    revision: 'newer',
    artifacts: [pr(890), pr(886)],
  };
  // Given in either order, the newer record's mentions come last (newest first on the card).
  for (const input of [
    [older, newer],
    [newer, older],
  ])
    assert.deepEqual(mergeSessions(input)[0].artifacts, [pr(889), pr(890), pr(886)]);
});
