import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changePoints,
  createTicker,
  loopPosition,
  pausedByCss,
  FRAME_MS,
  RESTING_AFTER_MS,
  RESTING_FRAME_MS,
  stepKey,
  tickInterval,
  type LoopState,
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

const kf = (...frames: [number, string][]) =>
  frames.map(([computedOffset, easing]) => ({ computedOffset, easing }));

test('A step key changes only when the picture does', () => {
  // A 2s idle sprite with 4 drawn frames changes every 500ms, not every office frame.
  const sprite = changePoints(kf([0, 'steps(4)'], [1, 'steps(4)']));
  assert.deepEqual(sprite, [0, 0.25, 0.5, 0.75]);
  const keys = [0, 125, 250, 375, 500, 625, 1000, 2000].map((t) => stepKey(t, 0, 2000, sprite));
  assert.deepEqual(keys, [0, 0, 0, 0, 1, 1, 2, 4]);
  // A smooth loop changes every office frame.
  assert.deepEqual(
    [0, 125, 250, 1625].map((t) => stepKey(t, 0, 1625, null)),
    [0, 1, 2, 13],
  );
  // Before its delay it is on its first frame and stays there.
  assert.equal(stepKey(100, 375, 1000, null), -1);
  assert.equal(stepKey(250, 375, 1000, sprite), -1);
  // A negative delay starts it part-way through.
  assert.equal(stepKey(0, -375, 750, null), 3);
});

test('Easing steps each keyframe segment, so a mid-loop keyframe adds changes', () => {
  // dock-pet-bang: steps(2) with a 50% keyframe changes four times a cycle, not twice.
  assert.deepEqual(
    changePoints(kf([0, 'steps(2)'], [0.5, 'steps(2)'], [1, 'steps(2)'])),
    [0, 0.25, 0.5, 0.75],
  );
  // A keyframe's own easing overrides the animation's for its segment.
  assert.deepEqual(
    changePoints(kf([0, 'steps(1)'], [0.4, 'steps(3)'], [1, 'linear'])),
    [0, 0.4, 0.6, 0.8],
  );
  // Any smooth segment, or an easing on the whole effect, changes continuously.
  assert.equal(changePoints(kf([0, 'steps(2)'], [0.5, 'ease-in-out'], [1, 'linear'])), null);
  assert.equal(changePoints(kf([0, 'linear'], [1, 'linear'])), null);
  assert.equal(changePoints(kf([0, 'steps(4)'], [1, 'steps(4)']), 'normal', 'ease'), null);
  // Any direction but normal is set every office frame (a reversed steps() jumps elsewhere).
  for (const direction of ['alternate', 'alternate-reverse', 'reverse'])
    assert.equal(changePoints(kf([0, 'steps(3)'], [1, 'steps(3)']), direction), null);
});

test('Sampling on office frames never misses a stepped change', () => {
  // The picture of a steps(n)-per-segment loop at a progress, computed the way CSS does.
  const frames = kf([0, 'steps(2)'], [0.3, 'steps(3)'], [0.5, 'steps(1)'], [1, 'steps(1)']);
  const picture = (p: number) => {
    for (let i = frames.length - 2; i >= 0; i--) {
      const from = frames[i].computedOffset;
      const to = frames[i + 1].computedOffset;
      if (p >= from) {
        const n = Number(frames[i].easing.match(/\d+/)![0]);
        return `${i}:${Math.floor(((p - from) / (to - from)) * n)}`;
      }
    }
    return 'start';
  };
  const points = changePoints(frames);
  const duration = 2000;
  let previous = { key: stepKey(0, 0, duration, points), picture: picture(0) };
  for (let t = FRAME_MS; t <= 3 * duration; t += FRAME_MS) {
    const now = {
      key: stepKey(t, 0, duration, points),
      picture: picture((t % duration) / duration),
    };
    if (now.picture !== previous.picture) assert.notEqual(now.key, previous.key, `at ${t}ms`);
    previous = now;
  }
});

test('work-meter (750ms steps(3) alternate): every CSS step change gets a new key', () => {
  // CSS: alternate plays odd iterations backwards and the easing applies to that directed
  // progress; steps(3) (jump-end) floors it into thirds, but an input of exactly 1 gives 1 (the
  // start of a backward turn shows the full meter).
  const duration = 750;
  const value = (t: number) => {
    const iteration = Math.floor(t / duration);
    const p = (t - iteration * duration) / duration;
    const directed = iteration % 2 ? 1 - p : p;
    return directed >= 1 ? 1 : Math.floor(directed * 3) / 3;
  };
  const points = changePoints(kf([0, 'steps(3)'], [1, 'steps(3)']), 'alternate');
  let changes = 0;
  for (let t = FRAME_MS; t <= 8 * duration; t += FRAME_MS) {
    const before = t - FRAME_MS;
    if (value(t) === value(before)) continue;
    changes++;
    assert.notEqual(
      stepKey(t, 0, duration, points),
      stepKey(before, 0, duration, points),
      `${t}ms`,
    );
  }
  assert.ok(changes > 8, 'the meter moved over several cycles');
  // The case from review: 750ms and 875ms show different steps, so they must differ in key.
  assert.notEqual(value(750), value(875));
  assert.notEqual(stepKey(750, 0, duration, points), stepKey(875, 0, duration, points));
});

test('A pause the stylesheet asks for holds the loop, and it resumes where it stopped', () => {
  assert.equal(pausedByCss('zone-flag-wave', 'paused', 'zone-flag-wave'), true);
  assert.equal(pausedByCss('a, zone-flag-wave', 'running, paused', 'zone-flag-wave'), true);
  assert.equal(pausedByCss('a, b', 'paused, running', 'b'), false);
  // A shorter play-state list repeats, as in CSS.
  assert.equal(pausedByCss('a, b, c', 'running, paused', 'c'), false);
  assert.equal(pausedByCss('a, b', 'paused', 'b'), true);
  assert.equal(pausedByCss('none', 'paused', 'b'), false);

  const loop: LoopState = { origin: 0, pausedAt: null, key: NaN };
  const timing = { delay: 0, duration: 4500 };
  assert.equal(loopPosition(loop, 1000, false, timing, null), 1000);
  // Dragging a zone flag: no moves while CSS holds it, however many ticks pass.
  assert.equal(loopPosition(loop, 1125, true, timing, null), null);
  assert.equal(loopPosition(loop, 3000, true, timing, null), null);
  // Released: it carries on from 1000ms into its loop, not 3125.
  assert.equal(loopPosition(loop, 3125, false, timing, null), 1125);
  assert.equal(loopPosition(loop, 3250, false, timing, null), 1250);
  // An unchanged picture is left alone.
  const sprite = { origin: 0, pausedAt: null, key: NaN };
  const quarters = [0, 0.25, 0.5, 0.75];
  assert.equal(loopPosition(sprite, 0, false, { delay: 0, duration: 2000 }, quarters), 0);
  assert.equal(loopPosition(sprite, 125, false, { delay: 0, duration: 2000 }, quarters), null);
  assert.equal(loopPosition(sprite, 500, false, { delay: 0, duration: 2000 }, quarters), 500);
});
