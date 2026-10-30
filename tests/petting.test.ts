import test from 'node:test';
import assert from 'node:assert/strict';
import { RUB_COOLDOWN_MS, RUB_WINDOW_MS, rubTracker } from '../src/lib/usePetting.js';

/** Moves the pointer through these x positions, `gap` ms apart; whether any of them pats. */
const rub = (t: ReturnType<typeof rubTracker>, xs: number[], start = 0, gap = 60, buttons = 0) =>
  xs.map((x, i) => t.move(x, start + i * gap, buttons));

test('rubbing back and forth over a pet pats it once three turns are made', () => {
  const t = rubTracker();
  // right, left, right, left: three turns
  const out = rub(t, [0, 20, 40, 20, 0, 20, 40, 20]);
  assert.equal(out.filter(Boolean).length, 1);
  assert.equal(out.indexOf(true), 7, 'on the third turn, not before');
});

test('passing over, holding a button, tiny jitters or slow turns never pat', () => {
  assert.ok(!rub(rubTracker(), [0, 20, 40, 60, 80, 100]).some(Boolean), 'a pass');
  assert.ok(!rub(rubTracker(), [0, 20, 0, 20, 0, 20], 0, 60, 1).some(Boolean), 'a drag');
  assert.ok(!rub(rubTracker(), [0, 2, 0, 2, 0, 2, 0, 2]).some(Boolean), 'jitter');
  const slow = RUB_WINDOW_MS / 2 + 10;
  assert.ok(!rub(rubTracker(), [0, 20, 0, 20, 0], 0, slow).some(Boolean), 'too slow');
});

test('after a pat the pet rests a moment; leaving starts the count over', () => {
  const t = rubTracker();
  rub(t, [0, 20, 0, 20, 0]);
  assert.ok(!rub(t, [20, 0, 20, 0, 20, 0], 300).some(Boolean), 'cooldown');
  assert.ok(rub(t, [0, 20, 0, 20, 0], 300 + RUB_COOLDOWN_MS).some(Boolean), 'again later');
  const u = rubTracker();
  rub(u, [0, 20, 0, 20]);
  u.leave();
  assert.ok(!rub(u, [20], 300).some(Boolean), 'a fresh pass after leaving');
});
