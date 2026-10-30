import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTicker,
  FRAME_MS,
  RESTING_AFTER_MS,
  RESTING_FRAME_MS,
  stepKey,
  tickInterval,
} from '../src/lib/office-tick.js';

/** A fake clock: timers run only when the test moves time forward. */
function harness() {
  let now = 1000;
  let timers: { at: number; run: () => void; id: number }[] = [];
  let ids = 0;
  const ticks: number[] = [];
  const ticker = createTicker({
    now: () => now,
    setTimer: (run, ms) => {
      const id = ++ids;
      timers.push({ at: now + ms, run, id });
      return id;
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
    onTick: (at) => ticks.push(at),
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      now = next.at;
      next.run();
    }
    now = end;
  };
  return { ticker, ticks, advance, pending: () => timers.length };
}

const base = { hidden: false, still: false, focused: true, blurredAt: null, busy: true };

test('The pace follows sight, focus and motion', () => {
  assert.equal(tickInterval(base, 0), FRAME_MS);
  assert.equal(FRAME_MS, 125, '8 office frames a second');
  assert.equal(tickInterval({ ...base, hidden: true }, 0), null);
  assert.equal(tickInterval({ ...base, still: true }, 0), null);
  assert.equal(tickInterval({ ...base, busy: false }, 0), null);
  // Another app for a moment keeps the full rate; a longer stay halves it.
  const away = { ...base, focused: false, blurredAt: 0 };
  assert.equal(tickInterval(away, RESTING_AFTER_MS - 1), FRAME_MS);
  assert.equal(tickInterval(away, RESTING_AFTER_MS), RESTING_FRAME_MS);
  assert.equal(RESTING_FRAME_MS, 250, '4 frames a second');
  // Out of sight wins over everything.
  assert.equal(tickInterval({ ...away, hidden: true }, RESTING_AFTER_MS), null);
});

test('Steps land on the office grid at 8 a second, and nothing runs until something loops', () => {
  const { ticker, ticks, advance, pending } = harness();
  advance(1000);
  assert.equal(pending(), 0, 'no timer without a loop');
  ticker.update({ busy: true });
  advance(1000);
  assert.equal(ticks.length, 8);
  assert.ok(ticks.every((t) => t % FRAME_MS === 0));
  assert.deepEqual(
    ticks.slice(1).map((t, i) => t - ticks[i]),
    Array(7).fill(FRAME_MS),
  );
  ticker.update({ busy: false });
  advance(1000);
  assert.equal(ticks.length, 8);
  assert.equal(pending(), 0);
});

test('Hidden stops the clock and showing resumes it', () => {
  const { ticker, ticks, advance, pending } = harness();
  ticker.update({ busy: true });
  advance(500);
  const before = ticks.length;
  ticker.update({ hidden: true });
  assert.equal(pending(), 0);
  assert.equal(ticker.interval, null);
  advance(5000);
  assert.equal(ticks.length, before);
  ticker.update({ hidden: false });
  advance(500);
  assert.equal(ticks.length, before + 4);
});

test('Less motion holds the clock still until it is lifted', () => {
  const { ticker, ticks, advance } = harness();
  ticker.update({ busy: true, still: true });
  advance(2000);
  assert.deepEqual(ticks, []);
  ticker.update({ still: false });
  advance(250);
  assert.equal(ticks.length, 2);
});

test('A window left for another app slows to 4 a second, and focus brings 8 back', () => {
  const { ticker, ticks, advance } = harness();
  ticker.update({ busy: true, focused: false });
  advance(RESTING_AFTER_MS);
  assert.equal(ticker.interval, RESTING_FRAME_MS);
  const slow = ticks.length;
  advance(1000);
  assert.equal(ticks.length - slow, 4);
  ticker.update({ focused: true });
  assert.equal(ticker.interval, FRAME_MS);
  const fast = ticks.length;
  advance(1000);
  assert.equal(ticks.length - fast, 8);
});

test('Repeating the same conditions does not reschedule', () => {
  const { ticker, advance, pending } = harness();
  ticker.update({ busy: true });
  ticker.update({ busy: true, hidden: false });
  assert.equal(pending(), 1);
  advance(60);
  ticker.update({ focused: true });
  assert.equal(pending(), 1);
});

test('A step key changes only when the picture does', () => {
  // A 2s idle sprite with 4 drawn frames changes every 500ms, not every office frame.
  const keys = [0, 125, 250, 375, 500, 625, 1000].map((t) => stepKey(t, 0, 2000, 4));
  assert.deepEqual(keys, [0, 0, 0, 0, 1, 1, 2]);
  // A smooth loop changes every office frame.
  assert.deepEqual(
    [0, 125, 250, 1625].map((t) => stepKey(t, 0, 1625)),
    [0, 1, 2, 13],
  );
  // Never finer than the office frame, however many steps are drawn.
  assert.equal(stepKey(125, 0, 500, 8), stepKey(200, 0, 500, 8));
  // Before its delay it is on its first frame and stays there.
  assert.equal(stepKey(100, 375, 1000), -1);
  assert.equal(stepKey(250, 375, 1000), -1);
  // A negative delay starts it part-way through.
  assert.equal(stepKey(0, -375, 750), 3);
});
