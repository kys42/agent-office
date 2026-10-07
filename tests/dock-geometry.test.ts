import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLOOR_HEIGHT,
  FLOOR_SCENE_HEIGHT,
  PET_SIZE,
  ROW_HEIGHT,
  ROW_SCALE,
  ROW_SCENE_HEIGHT,
  ROW_TOOLS_BAND,
  clampInto,
  petBounds,
  petFeet,
  readPetSpot,
  rowBounds,
} from '../src/shared/dock-geometry.js';
import { DESK_FOOT, FLOOR_TOP } from '../src/shared/office-layout.js';

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

test('the pet starts in the bottom-right corner and keeps its standing spot', () => {
  const first = petBounds(null, area);
  assert.equal(first.width, PET_SIZE.width);
  assert.ok(first.x + first.width <= area.x + area.width);
  assert.ok(first.y + first.height <= area.y + area.height);
  assert.ok(first.x > area.width / 2);
  const feet = { x: 700, y: 800 };
  assert.deepEqual(petFeet(petBounds(feet, area)), feet);
  // A bigger or smaller pet window keeps the pet standing on the same spot.
  for (const size of [
    { width: 132, height: 148 },
    { width: 260, height: 400 },
  ])
    assert.deepEqual(petFeet(petBounds(feet, area, size)), feet);
});

test('a pet dragged past an edge or left on a removed display comes back inside', () => {
  const corner = petBounds({ x: -80, y: -40 }, area);
  assert.deepEqual([corner.x, corner.y], [0, 25]);
  const lost = petBounds({ x: 3000, y: 2000 }, area);
  assert.equal(lost.x, area.width - PET_SIZE.width);
  assert.equal(lost.y, area.y + area.height - PET_SIZE.height);
  assert.deepEqual(clampInto({ x: 5, y: 5, width: 4000, height: 50 }, area), {
    x: 0,
    y: 25,
    width: 1512,
    height: 50,
  });
});

test('desk-pet.json: the standing spot, and the first format converted in place', () => {
  assert.deepEqual(readPetSpot({ v: 2, x: 700, y: 800 }), { x: 700, y: 800 });
  // First format: top-left of the original 132×148 window → its feet.
  assert.deepEqual(readPetSpot({ x: 400, y: 300 }), { x: 466, y: 448 });
  assert.equal(readPetSpot(null), null);
  assert.equal(readPetSpot({ x: 'a', y: 1 }), null);
  assert.equal(readPetSpot({ x: Infinity, y: 1 }), null);
});

test('the row keeps desks at a fixed readable scale and its window holds the scene', () => {
  assert.equal(ROW_SCALE, 1, 'same size as the big office at 100%');
  assert.ok(ROW_SCENE_HEIGHT * ROW_SCALE + ROW_TOOLS_BAND <= ROW_HEIGHT, 'tools sit above bubbles');
});

test('floor desks: the scene ends at the desk feet, and the window holds it under the tools', () => {
  assert.ok(FLOOR_SCENE_HEIGHT >= FLOOR_TOP + DESK_FOOT, 'desk legs fit in the scene');
  assert.ok(FLOOR_SCENE_HEIGHT - (FLOOR_TOP + DESK_FOOT) <= 12, 'and stand right on its bottom');
  assert.ok(FLOOR_SCENE_HEIGHT * ROW_SCALE + ROW_TOOLS_BAND <= FLOOR_HEIGHT);
  assert.ok(FLOOR_HEIGHT < ROW_HEIGHT, 'no rugs or name cards: a shorter strip');
  const floor = rowBounds(area, FLOOR_HEIGHT);
  assert.equal(floor.y + floor.height, area.y + area.height);
  assert.equal(floor.width, area.width);
});
