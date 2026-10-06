import test from 'node:test';
import assert from 'node:assert/strict';
import { findPath } from '../src/lib/pathfinding.js';
test('Walking paths route around furniture on four connected tiles', () => {
  const blocked = new Set(['3,8', '3,9', '3,10']);
  const result = findPath({ col: 2, row: 9 }, { col: 4, row: 9 }, blocked);
  assert.ok(result.length > 2);
  assert.ok(result.every((t) => !blocked.has(`${t.col},${t.row}`)));
  assert.deepEqual(result.at(-1), { col: 4, row: 9 });
  let p = { col: 2, row: 9 };
  for (const n of result) {
    assert.equal(Math.abs(n.col - p.col) + Math.abs(n.row - p.row), 1);
    p = n;
  }
});
test('A blocked destination cannot be reached', () =>
  assert.deepEqual(findPath({ col: 2, row: 8 }, { col: 3, row: 8 }, new Set(['3,8'])), []));
