import test from 'node:test';
import assert from 'node:assert/strict';
import { lastMentions } from '../src/shared/links.js';
import { mergeSessions } from '../server/adapters/merge.js';
import { parseRecords } from '../server/adapters/normalize.js';
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

test('A collected session lists a PR it brings up again as the latest', () => {
  const now = Date.parse('2026-10-19T10:00:00Z');
  const say = (text: string, offset: number) => ({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    timestamp: new Date(now + offset).toISOString(),
  });
  const s = parseRecords(
    [say(`올렸어요 ${pr(886)}`, 0), say(`새 PR ${pr(890)}`, 10), say(`${pr(886)} 리뷰 반영`, 20)],
    { provider: 'codex', sourcePath: '/test/artifacts.jsonl', mtime: now, now },
  );
  assert.deepEqual(s.artifacts, [pr(890), pr(886)]);
});
