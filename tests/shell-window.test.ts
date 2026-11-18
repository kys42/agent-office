import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseShellWindowTarget,
  readShellWindowSize,
  shellWindowBounds,
  SHELL_WINDOW_SIZE,
} from '../src/shared/shell-window.js';

const area = { x: 0, y: 25, width: 1440, height: 875 };
const size = { width: 640, height: 400 };
const inside = (r: { x: number; y: number; width: number; height: number }) =>
  r.x >= area.x &&
  r.y >= area.y &&
  r.x + r.width <= area.x + area.width &&
  r.y + r.height <= area.y + area.height;

test('a terminal window opens to the right of a card when there is room', () => {
  const card = { x: 100, y: 200, width: 480, height: 600 };
  assert.deepEqual(shellWindowBounds(card, area, size), {
    x: 588,
    y: 200,
    width: 640,
    height: 400,
  });
});

test('no room on the right: it opens to the left, still top-aligned', () => {
  const card = { x: 900, y: 120, width: 480, height: 600 };
  assert.deepEqual(shellWindowBounds(card, area, size), {
    x: 252,
    y: 120,
    width: 640,
    height: 400,
  });
});

test('a card low on the screen keeps the terminal inside the work area', () => {
  const card = { x: 100, y: 700, width: 480, height: 190 };
  const r = shellWindowBounds(card, area, size);
  assert.equal(r.x, 588);
  assert.equal(r.y + r.height, area.y + area.height);
  assert.ok(inside(r));
});

test('a full-width row: above it, at its right end', () => {
  const row = { x: 0, y: 720, width: 1440, height: 180 };
  const r = shellWindowBounds(row, area, size);
  assert.deepEqual(r, { x: 800, y: 312, width: 640, height: 400 });
});

test('a big window that fills the screen: just inside its right edge', () => {
  const main = { x: 0, y: 25, width: 1440, height: 875 };
  const r = shellWindowBounds(main, area, size);
  assert.equal(r.x + r.width, 1440 - 8);
  assert.ok(inside(r));
  assert.ok(r.y > main.y, 'below the big window title bar');
});

test('a window on a second display opens on that display', () => {
  const right = { x: 1440, y: 0, width: 1920, height: 1080 };
  const card = { x: 2000, y: 100, width: 480, height: 600 };
  const r = shellWindowBounds(card, right, size);
  assert.deepEqual(r, { x: 2488, y: 100, width: 640, height: 400 });
});

test('a remembered size bigger than the screen is cut to it', () => {
  const small = { x: 0, y: 0, width: 800, height: 500 };
  const r = shellWindowBounds({ x: 0, y: 0, width: 800, height: 500 }, small, {
    width: 2000,
    height: 1200,
  });
  assert.deepEqual(r, { x: 0, y: 0, width: 800, height: 500 });
});

test('a second terminal for the same card steps aside instead of covering the first', () => {
  const card = { x: 100, y: 200, width: 480, height: 600 };
  const first = shellWindowBounds(card, area, size);
  const second = shellWindowBounds(card, area, size, [first]);
  assert.notDeepEqual(second, first);
  assert.ok(Math.abs(second.x - first.x) >= 24 || Math.abs(second.y - first.y) >= 24);
  assert.ok(inside(second));
  const third = shellWindowBounds(card, area, size, [first, second]);
  for (const r of [first, second])
    assert.ok(Math.abs(third.x - r.x) >= 24 || Math.abs(third.y - r.y) >= 24);
});

test('a stored size is used only when sane', () => {
  assert.deepEqual(readShellWindowSize({ width: 700.4, height: 420.6 }), {
    width: 700,
    height: 421,
  });
  assert.equal(readShellWindowSize({ width: 100, height: 420 }), null);
  assert.equal(readShellWindowSize({ width: 700, height: 99_999 }), null);
  assert.equal(readShellWindowSize({ width: '700', height: 420 }), null);
  assert.equal(readShellWindowSize(null), null);
  assert.ok(SHELL_WINDOW_SIZE.width >= 360);
});

test('a window may ask for a session or an existing shell, nothing else', () => {
  assert.deepEqual(parseShellWindowTarget({ id: 'claude:abc', cwd: '/x' }), {
    id: 'claude:abc',
    cwd: '/x',
  });
  assert.deepEqual(parseShellWindowTarget({ name: 'shell-0123456789abcdef', cwd: '/x' }), {
    name: 'shell-0123456789abcdef',
    cwd: '/x',
  });
  // The folder is a label only: main reads the real one.
  assert.deepEqual(parseShellWindowTarget({ id: 'a', cwd: 5 }), { id: 'a', cwd: '' });
  for (const bad of [
    null,
    [],
    'shell-0123456789abcdef',
    { name: 'agent-office', cwd: '/x' },
    { name: 'shell-0123', cwd: '/x' },
    { id: '', cwd: '/x' },
    { id: 'x'.repeat(401), cwd: '/x' },
    { cwd: '/x' },
  ])
    assert.throws(() => parseShellWindowTarget(bad));
});

test('at a corner the next terminal steps the way that still has room', () => {
  const area = { x: 0, y: 0, width: 1200, height: 800 };
  const anchor = { x: 0, y: 400, width: 1200, height: 400 };
  const first = shellWindowBounds(anchor, area, { width: 640, height: 400 }, []);
  const second = shellWindowBounds(anchor, area, { width: 640, height: 400 }, [first]);
  assert.notDeepEqual([second.x, second.y], [first.x, first.y]);
});
