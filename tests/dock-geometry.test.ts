import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PET_SIZE,
  ROW_HEIGHT,
  ROW_SCALE_MAX,
  ROW_SCALE_MIN,
  ROW_SCENE_HEIGHT,
  clampInto,
  petBounds,
  rowBounds,
  rowScale,
} from '../src/shared/dock-geometry.js';

// A 1512×982 MacBook display: 25px menu bar on top, 70px Dock at the bottom.
const area = { x: 0, y: 25, width: 1512, height: 887 };
const second = { x: 1512, y: 0, width: 1920, height: 1055 };

test('the row spans the whole work area width and rests on its bottom edge', () => {
  const row = rowBounds(area);
  assert.deepEqual(row, { x: 0, y: 25 + 887 - ROW_HEIGHT, width: 1512, height: ROW_HEIGHT });
  assert.equal(row.y + row.height, area.y + area.height, 'sits right above the Dock');
  assert.deepEqual(rowBounds(second).x, 1512, 'opens on the display the pet is on');
  assert.equal(rowBounds({ ...area, height: 120 }).height, 120);
});

test('the pet starts in the bottom-right corner and keeps a saved spot', () => {
  const first = petBounds(null, area);
  assert.equal(first.width, PET_SIZE.width);
  assert.ok(first.x + first.width <= area.x + area.width);
  assert.ok(first.y + first.height <= area.y + area.height);
  assert.ok(first.x > area.width / 2 && first.y > area.height / 2);
  assert.deepEqual(petBounds({ x: 400, y: 300 }, area), { x: 400, y: 300, ...PET_SIZE });
});

test('a pet dragged past an edge or left on a removed display comes back inside', () => {
  assert.deepEqual(petBounds({ x: -80, y: -40 }, area), { x: 0, y: 25, ...PET_SIZE });
  const lost = petBounds({ x: 3000, y: 900 }, area);
  assert.equal(lost.x, area.width - PET_SIZE.width);
  assert.equal(lost.y, area.y + area.height - PET_SIZE.height);
  assert.deepEqual(clampInto({ x: 5, y: 5, width: 4000, height: 50 }, area), {
    x: 0,
    y: 25,
    width: 1512,
    height: 50,
  });
});

test('the row scene shrinks to fit the screen, but never below a readable size', () => {
  assert.ok(ROW_SCENE_HEIGHT * ROW_SCALE_MAX <= ROW_HEIGHT, 'the window holds the scene');
  assert.equal(rowScale(800, 1092), ROW_SCALE_MAX);
  assert.equal(rowScale(1400, 1092), 1092 / 1400);
  assert.equal(rowScale(6000, 1092), ROW_SCALE_MIN, 'a big office scrolls instead');
  assert.equal(rowScale(0, 1092), ROW_SCALE_MAX);
});
