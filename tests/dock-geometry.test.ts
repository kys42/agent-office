import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_MIN,
  CARD_MIN_HEIGHT,
  CARD_SIZE,
  readCardSize,
  cardBounds,
  FLOOR_HEIGHT,
  FLOOR_SCENE_HEIGHT,
  PET_SIZE,
  ROW_HEIGHT,
  ROW_SCALE,
  ROW_SCENE_HEIGHT,
  ROW_BAND,
  dockBand,
  dockHeight,
  readDockPrefs,
  TINY_HEIGHT,
  TINY_SCENE_HEIGHT,
  TINY_SCALE,
  TINY_BAND,
  PILL_CENTER,
  PILL_MARGIN,
  pillLeft,
  readPillSpot,
  TINY_TOP,
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
  assert.ok(ROW_SCENE_HEIGHT * ROW_SCALE + ROW_BAND <= ROW_HEIGHT, 'desks stand on the pill band');
});

test('floor desks: the scene ends at the desk feet, and the window holds it over the band', () => {
  assert.ok(FLOOR_SCENE_HEIGHT >= FLOOR_TOP + DESK_FOOT, 'desk legs fit in the scene');
  assert.ok(FLOOR_SCENE_HEIGHT - (FLOOR_TOP + DESK_FOOT) <= 12, 'and stand right on its bottom');
  assert.ok(FLOOR_SCENE_HEIGHT * ROW_SCALE + ROW_BAND <= FLOOR_HEIGHT);
  assert.ok(FLOOR_HEIGHT < ROW_HEIGHT, 'no rugs or name cards: a shorter strip');
  const floor = rowBounds(area, FLOOR_HEIGHT);
  assert.equal(floor.y + floor.height, area.y + area.height);
  assert.equal(floor.width, area.width);
});

const inside = (b: { x: number; y: number; width: number; height: number }, a: typeof area) =>
  b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;

test('the dock card opens above the clicked desk, centred, inside the work area', () => {
  // A row desk near the bottom middle of the screen.
  const desk = { x: 700, y: 700, width: 164, height: 160 };
  const b = cardBounds(desk, area);
  assert.equal(b.width, CARD_SIZE.width);
  assert.ok(b.y + b.height <= desk.y, 'the card does not cover the desk');
  // A laptop screen has less room than the full card: it shortens rather than move aside.
  assert.ok(b.height < CARD_SIZE.height && b.height >= CARD_MIN_HEIGHT);
  // A tall screen gets the full card.
  const tall = { x: 0, y: 0, width: 2560, height: 1415 };
  assert.equal(
    cardBounds({ x: 1200, y: 1100, width: 164, height: 160 }, tall).height,
    CARD_SIZE.height,
  );
  assert.equal(Math.round(b.x + b.width / 2), Math.round(desk.x + desk.width / 2));
  assert.ok(inside(b, area));
});

test('the dock card stays on screen at the edges and beside a desk with no room above', () => {
  // At the far right of the row: shifted left, still above the desk.
  const right = cardBounds({ x: 1450, y: 760, width: 60, height: 80 }, area);
  assert.ok(inside(right, area));
  assert.ok(right.y + right.height <= 760);
  // A pet bubble near the top: no room above, so it opens beside, never over it.
  const high = { x: 300, y: 120, width: 160, height: 90 };
  const side = cardBounds(high, area);
  assert.ok(inside(side, area));
  assert.ok(side.x >= high.x + high.width || side.x + side.width <= high.x);
  // Near the right edge with no room above: it opens on the left side instead.
  const corner = { x: 1300, y: 100, width: 150, height: 90 };
  const left = cardBounds(corner, area);
  assert.ok(left.x + left.width <= corner.x);
  // On a second display, and on a short screen the card shrinks to fit.
  assert.ok(inside(cardBounds({ x: 2400, y: 900, width: 164, height: 160 }, second), second));
  const short = { x: 0, y: 0, width: 1280, height: 600 };
  const fitted = cardBounds({ x: 600, y: 500, width: 164, height: 90 }, short);
  assert.ok(fitted.height < CARD_SIZE.height && inside(fitted, short));
});

test('the card opens at the size the person gave it, and a bad remembered size is ignored', () => {
  assert.deepEqual(readCardSize({ width: 600.4, height: 820 }), { width: 600, height: 820 });
  for (const bad of [null, {}, { width: 200, height: 800 }, { width: 600, height: 9000 }, 'x'])
    assert.equal(readCardSize(bad), null);
  const tall = { x: 0, y: 0, width: 2560, height: 1415 };
  const b = cardBounds({ x: 1200, y: 1100, width: 164, height: 160 }, tall, {
    width: 600,
    height: 900,
  });
  assert.deepEqual([b.width, b.height], [600, 900]);
  assert.ok(CARD_SIZE.width >= CARD_MIN.width && CARD_SIZE.height >= CARD_MIN.height);
});

test('tiny drops the bubble headroom and draws the scene at helper-desk size', () => {
  assert.ok(Math.abs(TINY_SCALE - 68 / 164) < 1e-9);
  // The scene ends at the desk legs (plus shadow) and starts just above the heads.
  assert.equal(TINY_SCENE_HEIGHT, TINY_TOP + DESK_FOOT + 4);
  assert.equal(TINY_HEIGHT, Math.ceil(TINY_SCENE_HEIGHT * TINY_SCALE) + TINY_BAND);
  assert.ok(TINY_HEIGHT < 100 && TINY_HEIGHT < ROW_HEIGHT / 4);
  assert.ok(TINY_HEIGHT < FLOOR_HEIGHT / 3);
  assert.equal(dockHeight(false, false), ROW_HEIGHT);
  assert.equal(dockHeight(true, false), FLOOR_HEIGHT);
  assert.equal(dockHeight(false, true), TINY_HEIGHT);
  assert.equal(dockHeight(true, true), TINY_HEIGHT);
  // The tiny strip still rests on the work area's bottom edge.
  const strip = rowBounds(area, TINY_HEIGHT);
  assert.equal(strip.y + strip.height, area.y + area.height);
});

test('dock.json remembers tiny; anything unexpected is the normal size', () => {
  assert.deepEqual(readDockPrefs({ v: 1, tiny: true }), { tiny: true });
  assert.deepEqual(readDockPrefs({ v: 1, tiny: false }), { tiny: false });
  const bad = [null, undefined, 'x', 1, [], {}, { tiny: true }, { v: 2, tiny: true }];
  for (const raw of [...bad, { v: 1, tiny: 'yes' }])
    assert.deepEqual(readDockPrefs(raw), { tiny: false });
});

test('the dock pill band holds a 34px pill (24px tiny) under the desks', () => {
  assert.equal(dockBand(false), ROW_BAND);
  assert.equal(dockBand(true), TINY_BAND);
  assert.ok(ROW_BAND >= 34 + 5 && TINY_BAND >= 24 + 2);
});

test('the pill spot is a centre fraction, the middle when unreadable', () => {
  assert.equal(readPillSpot({ v: 1, x: 0.25 }), 0.25);
  assert.equal(readPillSpot({ v: 1, x: 1.4 }), 1, 'clamped to the window');
  assert.equal(readPillSpot({ v: 1, x: -3 }), 0);
  for (const raw of [null, undefined, 'x', 0.3, {}, { x: 0.3 }, { v: 2, x: 0.3 }, { v: 1, x: NaN }])
    assert.equal(readPillSpot(raw), PILL_CENTER);
});

test('the pill stays whole inside the window, wherever its spot is', () => {
  assert.equal(pillLeft(0.5, 1000, 400), 300, 'centred');
  assert.equal(pillLeft(0.25, 2000, 400), 300, 'same fraction on a wider screen');
  assert.equal(pillLeft(0, 1000, 400), PILL_MARGIN, 'left edge');
  assert.equal(pillLeft(1, 1000, 400), 1000 - 400 - PILL_MARGIN, 'right edge');
  assert.equal(pillLeft(0.5, 300, 400), PILL_MARGIN, 'wider than the window: from the left');
});
