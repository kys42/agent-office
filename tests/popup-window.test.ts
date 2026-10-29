import test from 'node:test';
import assert from 'node:assert/strict';
import {
  floatLayer,
  popupFloats,
  popupOpenPlan,
  popupReopenFloats,
  popupWindowBounds,
  readWindowSize,
} from '../src/shared/popup-window.js';
import { shellWindowBounds, SHELL_WINDOW_SIZE } from '../src/shared/shell-window.js';
import {
  parseReaderTarget,
  READER_WINDOW_MIN,
  READER_WINDOW_SIZE,
  READER_WINDOW_SIZE_FILE,
  readerOpens,
} from '../src/shared/bookmark-window.js';

const area = { x: 0, y: 25, width: 1440, height: 875 };
const inside = (r: { x: number; y: number; width: number; height: number }) =>
  r.x >= area.x &&
  r.y >= area.y &&
  r.x + r.width <= area.x + area.width &&
  r.y + r.height <= area.y + area.height;

test('every popup kind opens beside its opener by the same rule', () => {
  const card = { x: 100, y: 200, width: 480, height: 600 };
  // The terminal's rule is the shared one at its own size.
  assert.deepEqual(shellWindowBounds(card, area), popupWindowBounds(card, area, SHELL_WINDOW_SIZE));
  // A reader opens to the right of the card, top-aligned, at its own size.
  const r = popupWindowBounds(card, area, READER_WINDOW_SIZE);
  assert.deepEqual(r, { x: 588, y: 200, ...READER_WINDOW_SIZE });
  // A big office filling the screen: inside its right edge, never off screen.
  const full = popupWindowBounds(area, area, READER_WINDOW_SIZE);
  assert.ok(inside(full));
  assert.ok(full.x + full.width <= area.x + area.width);
});

test('several popups of one kind step aside diagonally, each still on screen', () => {
  const card = { x: 100, y: 200, width: 480, height: 600 };
  const placed: { x: number; y: number; width: number; height: number }[] = [];
  for (let i = 0; i < 5; i++) {
    const next = popupWindowBounds(card, area, READER_WINDOW_SIZE, placed);
    assert.ok(inside(next));
    for (const o of placed)
      assert.ok(Math.abs(o.x - next.x) >= 24 || Math.abs(o.y - next.y) >= 24, 'not on top');
    placed.push(next);
  }
});

test('a remembered size is read per kind, against that kind’s minimum', () => {
  assert.deepEqual(readWindowSize({ width: 500.4, height: 400.6 }, READER_WINDOW_MIN), {
    width: 500,
    height: 401,
  });
  assert.equal(readWindowSize({ width: 300, height: 400 }, READER_WINDOW_MIN), null);
  assert.equal(readWindowSize({ width: 500, height: 5000 }, READER_WINDOW_MIN), null);
  assert.equal(readWindowSize('x', READER_WINDOW_MIN), null);
  // Readers keep their own file, apart from the terminal's.
  assert.notEqual(READER_WINDOW_SIZE_FILE, 'shell-window-size.json');
});

test('a popup floats only beside a floating window that is not the big office', () => {
  assert.equal(popupFloats({ main: false, alwaysOnTop: true }), true);
  assert.equal(popupFloats({ main: false, alwaysOnTop: false }), false);
  assert.equal(popupFloats({ main: true, alwaysOnTop: true }), false);
});

test('a floating window sits at the preview level on every Space; an ordinary one does not', () => {
  assert.deepEqual(floatLayer(true), {
    alwaysOnTop: true,
    level: 'pop-up-menu',
    allSpaces: true,
  });
  assert.deepEqual(floatLayer(false), {
    alwaysOnTop: false,
    level: 'pop-up-menu',
    allSpaces: false,
  });
});

test('a popup asked again keeps its own on-top choice unless a floating window asks', () => {
  // Set on top by the person: asked again from the big office, it stays on top.
  assert.equal(popupReopenFloats(true, false), true);
  // Set back to an ordinary window: a floating card asking again floats it (not hidden behind).
  assert.equal(popupReopenFloats(false, true), true);
  assert.equal(popupReopenFloats(false, false), false);
  assert.equal(popupReopenFloats(true, true), true);
});

test('opening by key brings the open one forward, else makes one (closing the oldest at max)', () => {
  const open = [{ key: 'a' }, { key: 'b' }];
  assert.deepEqual(popupOpenPlan(open, 'b', 3), { focus: open[1] });
  assert.deepEqual(popupOpenPlan(open, 'c', 3), { create: true });
  assert.deepEqual(popupOpenPlan(open, 'c', 2), { create: true, evict: open[0] });
  assert.deepEqual(popupOpenPlan([], 'a', 1), { create: true });
});

test('a reader window is asked for by bookmark id only', () => {
  assert.deepEqual(parseReaderTarget({ id: 'b-1' }), { id: 'b-1' });
  // Anything else given along (e.g. the text) is not taken.
  assert.deepEqual(parseReaderTarget({ id: 'b-1', text: 'secret' }), { id: 'b-1' });
  for (const bad of [null, [], 'b-1', {}, { id: '' }, { id: 5 }, { id: 'x'.repeat(101) }])
    assert.throws(() => parseReaderTarget(bad));
});

test('the desktop app reads a bookmark in a window; the web preview and the demo in the page', () => {
  assert.equal(readerOpens({ windows: true, demo: false }), 'window');
  assert.equal(readerOpens({ windows: true, demo: true }), 'modal');
  assert.equal(readerOpens({ windows: false, demo: false }), 'modal');
});
