import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cardFloats,
  cardPinAction,
  nextCardPin,
  readCardPin,
  readCardPosition,
  popupBounds,
  type CardPin,
} from '../src/shared/card-windows.js';
import { floatLayer, popupFloats } from '../src/shared/popup-window.js';
import { cardBounds, CARD_SIZE } from '../src/shared/dock-geometry.js';

const area = { x: 0, y: 24, width: 1440, height: 876 };
const anchor = { x: 1100, y: 850, width: 120, height: 40 };

test('Position memory requires explicit enablement and finite screen coordinates', () => {
  assert.deepEqual(readCardPosition({ enabled: true, x: -900.2, y: 35.8 }), { x: -900, y: 36 });
  for (const raw of [
    null,
    {},
    { enabled: false, x: 1, y: 2 },
    { x: 1, y: 2 },
    { enabled: true, x: NaN, y: 2 },
    { enabled: true, x: Infinity, y: 2 },
    { enabled: true, x: '2', y: 2 },
    { enabled: true, x: 100001, y: 2 },
  ])
    assert.equal(readCardPosition(raw), null);
});

test('Ordinary popups follow the desk until a location is remembered', () => {
  assert.deepEqual(popupBounds(anchor, area, CARD_SIZE, null), cardBounds(anchor, area, CARD_SIZE));
  assert.deepEqual(popupBounds(anchor, area, CARD_SIZE, { x: 200, y: 80 }), {
    x: 200,
    y: 80,
    ...CARD_SIZE,
  });
  assert.deepEqual(popupBounds({ ...anchor, x: 0 }, area, CARD_SIZE, { x: 200, y: 80 }), {
    x: 200,
    y: 80,
    ...CARD_SIZE,
  });
});

test('Disconnected displays and changed work areas keep the whole popup reachable', () => {
  const fit = popupBounds(anchor, area, CARD_SIZE, { x: -1800, y: -700 });
  assert.deepEqual(fit, { x: 0, y: 24, ...CARD_SIZE });
  const small = { x: -900, y: 30, width: 800, height: 620 };
  assert.deepEqual(popupBounds(anchor, small, CARD_SIZE, { x: 2000, y: 2000 }), {
    x: -580,
    y: 30,
    width: 480,
    height: 620,
  });
});

test('New previews leave pinned headers reachable without changing the saved location or existing cards', () => {
  const position = { x: 200, y: 80 };
  const pinned = [{ ...position, ...CARD_SIZE }];
  const next = popupBounds(anchor, area, CARD_SIZE, position, pinned);
  assert.notDeepEqual(next, pinned[0]);
  assert.ok(Math.abs(next.x - position.x) >= 24 || Math.abs(next.y - position.y) >= 24);
  assert.deepEqual(position, { x: 200, y: 80 });
  assert.deepEqual(pinned[0], { x: 200, y: 80, ...CARD_SIZE });
  const third = popupBounds(anchor, area, CARD_SIZE, position, [...pinned, next]);
  assert.notDeepEqual(third, pinned[0]);
  assert.notDeepEqual(third, next);
});

test('The card pin button cycles off → pinned → on top → off, each with its own action', () => {
  const seen: CardPin[] = [];
  let pin: CardPin = 'off';
  for (let i = 0; i < 4; i++) {
    seen.push(pin);
    pin = nextCardPin(pin);
  }
  assert.deepEqual(seen, ['off', 'pinned', 'top', 'off']);
  assert.equal(cardPinAction('off'), 'pin-off');
  assert.equal(cardPinAction('pinned'), 'pin-on');
  assert.equal(cardPinAction('top'), 'pin-top');
});

test('Only a plain pinned card is an ordinary window; the preview and on-top pin float', () => {
  assert.equal(cardFloats('off'), true);
  assert.equal(cardFloats('pinned'), false);
  assert.equal(cardFloats('top'), true);
  // At the preview's level.
  assert.deepEqual(floatLayer(cardFloats('top')), floatLayer(cardFloats('off')));
  assert.equal(floatLayer(cardFloats('pinned')).alwaysOnTop, false);
  // A popup opened from a card pinned on top floats beside it; from a plain pinned card it doesn't.
  assert.equal(popupFloats({ main: false, alwaysOnTop: cardFloats('top') }), true);
  assert.equal(popupFloats({ main: false, alwaysOnTop: cardFloats('pinned') }), false);
});

test('A card window state reads its pin, falling back to the older pinned flag', () => {
  assert.equal(readCardPin({ pin: 'top', pinned: true }), 'top');
  assert.equal(readCardPin({ pin: 'pinned', pinned: true }), 'pinned');
  assert.equal(readCardPin({ pin: 'off', pinned: false }), 'off');
  assert.equal(readCardPin({ pinned: true }), 'pinned');
  assert.equal(readCardPin({ pinned: false }), 'off');
  assert.equal(readCardPin({ pin: 'floating', pinned: false }), 'off');
});
