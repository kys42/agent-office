import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cardActivatesApp,
  cardFloats,
  cardHandAction,
  cardLeftBehind,
  cardOwnWindow,
  cardPinAction,
  cardPinOfAction,
  cardWindowToggle,
  nextCardPin,
  readCardPin,
  readCardPosition,
  readPinnedCards,
  popupBounds,
  type CardPin,
  type PinnedCard,
} from '../src/shared/card-windows.js';
import { floatLayer, popupFloats } from '../src/shared/popup-window.js';
import { cardBounds, CARD_SIZE } from '../src/shared/dock-geometry.js';
import { cardWindowStyle, CARD_TRAFFIC_LIGHTS } from '../desktop/window-style.js';
import {
  CARD_HANDOFF_MS,
  readHandoffShelf,
  shelveHandoff,
  takeHandoff,
} from '../src/shared/card-handoff.js';

const area = { x: 0, y: 24, width: 1440, height: 876 };
const anchor = { x: 1100, y: 850, width: 120, height: 40 };

test('Handing bubbles on turns only the preview; a kept card stays on its conversation', () => {
  assert.equal(cardHandAction('off'), 'select');
  for (const pin of ['pinned', 'top', 'window'] satisfies CardPin[])
    assert.equal(cardHandAction(pin), 'reveal');
});

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

test('A card panel activates the app only when no other window could pull it to another Space', () => {
  const dock = { visible: true, minimized: false, allSpaces: true };
  const hiddenOffice = { visible: false, minimized: false, allSpaces: false };
  const office = { visible: true, minimized: false, allSpaces: false };
  const minimizedOffice = { visible: true, minimized: true, allSpaces: false };
  for (const pin of ['off', 'pinned', 'top'] as const) {
    // Opened from the desk panel with the big office hidden: activating moves nothing, and without
    // it the keys would stay with the app in front (#417).
    assert.equal(cardActivatesApp(pin, [dock, hiddenOffice]), true, pin);
    assert.equal(cardActivatesApp(pin, [dock, minimizedOffice]), true, pin);
    assert.equal(cardActivatesApp(pin, []), true, pin);
    // The big office (or a plain pinned card) shown, maybe on another Space: stay on this one.
    assert.equal(cardActivatesApp(pin, [dock, office]), false, pin);
    // Those are the macOS panels: made non-activating when created.
    assert.equal(cardWindowStyle('darwin', cardOwnWindow(pin), 'popover', false).type, 'panel');
  }
  // An ordinary app window takes the keys only while its app is active: always.
  assert.equal(cardActivatesApp('window', [dock, office]), true);
  assert.equal(
    cardWindowStyle('darwin', cardOwnWindow('window'), 'popover', false).type,
    undefined,
  );
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

test('pinned cards to reopen: only well-formed ones, once each, a few at most', async () => {
  const { readPinnedCards, PINNED_CARDS_MAX } = await import('../src/shared/card-windows.js');
  const card = (id: string, extra: Record<string, unknown> = {}) => ({
    target: { id },
    pin: 'pinned',
    bounds: { x: 10.4, y: 20, width: 400, height: 500 },
    ...extra,
  });
  assert.deepEqual(readPinnedCards({ v: 1, cards: [card('a', { pin: 'top' })] }), [
    {
      target: { id: 'a' },
      pin: 'top',
      bounds: { x: 10, y: 20, width: 400, height: 500 },
    },
  ]);
  for (const bad of [null, {}, { v: 2, cards: [card('a')] }, { v: 1, cards: 'x' }])
    assert.deepEqual(readPinnedCards(bad), []);
  const mixed = readPinnedCards({
    v: 1,
    cards: [
      card('a'),
      card('a'),
      card(''),
      card('b', { pin: 'off' }),
      card('c', { bounds: { x: 0, y: 0, width: -1, height: 10 } }),
      card('d', { bounds: { x: Infinity, y: 0, width: 10, height: 10 } }),
      {
        target: { id: 'e', news: true },
        pin: 'pinned',
        bounds: { x: 0, y: 0, width: 300, height: 300 },
      },
    ],
  });
  // An older file's `news` flag (the removed news tab) is dropped: only whose card comes back.
  assert.deepEqual(
    mixed.map((c) => c.target),
    [{ id: 'a' }, { id: 'e' }],
  );
  const many = readPinnedCards({
    v: 1,
    cards: Array.from({ length: 20 }, (_, i) => card(`s${i}`)),
  });
  assert.equal(many.length, PINNED_CARDS_MAX);
});

test('창으로 띄우기 takes any card out into its own window and back in as a pinned card', () => {
  const pins: CardPin[] = ['off', 'pinned', 'top', 'window'];
  assert.deepEqual(pins.map(cardWindowToggle), ['window', 'window', 'window', 'pinned']);
  assert.deepEqual(pins.map(cardOwnWindow), [false, false, false, true]);
  // The pin button's cycle is unchanged, and never leads into a window of its own.
  assert.deepEqual(
    ['off', 'pinned', 'top'].map((p) => nextCardPin(p as CardPin)),
    ['pinned', 'top', 'off'],
  );
  assert.equal(nextCardPin('window'), 'pinned');
  // Each pin has its own IPC action, read back to the same pin; other actions are not pins.
  assert.equal(cardPinAction('window'), 'pin-window');
  for (const pin of pins) assert.equal(cardPinOfAction(cardPinAction(pin)), pin);
  for (const action of ['close', 'select', 'pin', 'window', 'pin-window ', undefined, 1])
    assert.equal(cardPinOfAction(action), null);
});

test('A card in its own window is an ordinary window on its own desktop, never floating', () => {
  assert.equal(cardFloats('window'), false);
  assert.deepEqual(floatLayer(cardFloats('window')), floatLayer(cardFloats('pinned')));
  assert.equal(floatLayer(cardFloats('window')).alwaysOnTop, false);
  assert.equal(floatLayer(cardFloats('window')).allSpaces, false);
  // A popup opened from it (mini terminal, reader) is an ordinary window too.
  assert.equal(popupFloats({ main: false, alwaysOnTop: cardFloats('window') }), false);
  assert.equal(readCardPin({ pin: 'window', pinned: true }), 'window');
});

test('A card in its own window is a real app window; card panels keep their frame', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const own = cardWindowStyle(platform, true, 'under-window', false);
    // Not a panel, not kept out of the taskbar / Mission Control, a frame the system draws.
    assert.equal(own.type, undefined, platform);
    assert.notEqual(own.skipTaskbar, true, platform);
    assert.notEqual(own.frame, false, platform);
    assert.notEqual(own.transparent, true, platform);
    assert.notEqual(own.alwaysOnTop, true, platform);
    const panel = cardWindowStyle(platform, false, 'under-window', false);
    assert.equal(panel.frame, false, platform);
    assert.equal(panel.transparent, true, platform);
    assert.equal(panel.skipTaskbar, true, platform);
    assert.equal(panel.maximizable, false, platform);
  }
  // macOS: the card's glass and the traffic lights over its header; the panel stays a panel.
  const mac = cardWindowStyle('darwin', true, 'popover', true);
  assert.equal(mac.titleBarStyle, 'hiddenInset');
  assert.deepEqual(mac.trafficLightPosition, CARD_TRAFFIC_LIGHTS);
  assert.equal(mac.vibrancy, 'popover');
  assert.equal(cardWindowStyle('darwin', false, 'popover', true).type, 'panel');
  assert.equal(cardWindowStyle('darwin', false, 'popover', true).vibrancy, 'popover');
  assert.equal(cardWindowStyle('win32', false, 'popover', true).type, undefined);
  // Windows/Linux: the system's own frame on the theme's background.
  assert.notEqual(
    cardWindowStyle('win32', true, 'under-window', true).backgroundColor,
    cardWindowStyle('win32', true, 'under-window', false).backgroundColor,
  );
  assert.equal(cardWindowStyle('linux', true, 'under-window', false).titleBarStyle, undefined);
});

test('Cards in their own window are written down and read back; older files still read', () => {
  const at = { x: 40, y: 60, width: 420, height: 560 };
  const cards: PinnedCard[] = [
    { target: { id: 'a' }, pin: 'window', bounds: at },
    { target: { id: 'b' }, pin: 'pinned', bounds: at },
    { target: { id: 'c' }, pin: 'top', bounds: at },
  ];
  // As written by rememberPinned: through JSON and back unchanged.
  assert.deepEqual(readPinnedCards(JSON.parse(JSON.stringify({ v: 1, cards }))), cards);
  // A file from before cards had their own window reads as it did.
  assert.deepEqual(
    readPinnedCards({
      v: 1,
      cards: [
        { target: { id: 'b' }, pin: 'pinned', bounds: at },
        { target: { id: 'c' }, pin: 'top', bounds: at },
      ],
    }),
    cards.slice(1),
  );
  // Still one card per colleague: a second entry for the same one is dropped.
  assert.deepEqual(
    readPinnedCards({ v: 1, cards: [cards[0], { ...cards[1], target: { id: 'a' } }] }),
    [cards[0]],
  );
  assert.deepEqual(readPinnedCards({ v: 1, cards: [{ ...cards[0], pin: 'windowed' }] }), []);
});

test('A card moving to a new window leaves its tab and unsaved notes there, taken once', () => {
  const at = 1_000_000;
  // Unsaved notes, and another colleague's hand-off already on the shelf.
  let shelf: unknown = shelveHandoff(null, { id: 'b', tab: 'history', at });
  shelf = JSON.parse(
    JSON.stringify(shelveHandoff(shelf, { id: 'a', tab: 'notes', notes: '저장 전 메모', at })),
  );
  const first = takeHandoff(shelf, 'a', at + 800);
  assert.deepEqual(first.handoff, { id: 'a', tab: 'notes', notes: '저장 전 메모', at });
  assert.deepEqual(Object.keys(first.rest), ['b']);
  // Taken once: the shelf left no longer has it.
  assert.equal(takeHandoff(first.rest, 'a', at + 900).handoff, null);
  // Saved notes are not carried: only the tab.
  assert.deepEqual(
    takeHandoff(shelveHandoff(null, { id: 'a', tab: 'outputs', at }), 'a', at).handoff,
    {
      id: 'a',
      tab: 'outputs',
      at,
    },
  );
  // A newer move of the same colleague replaces the older one.
  const twice = shelveHandoff(shelveHandoff(null, { id: 'a', tab: 'notes', notes: 'x', at }), {
    id: 'a',
    tab: 'history',
    at: at + 10,
  });
  assert.deepEqual(twice, { a: { id: 'a', tab: 'history', at: at + 10 } });
});

test('A hand-off left over (a move that never happened) goes stale; a malformed one is dropped', () => {
  const at = 1_000_000;
  const shelf = shelveHandoff(null, { id: 'a', tab: 'notes', notes: 'x', at });
  assert.equal(takeHandoff(shelf, 'a', at + CARD_HANDOFF_MS).handoff, null);
  assert.deepEqual(readHandoffShelf(shelf, at + CARD_HANDOFF_MS), {});
  // Stale ones are cleared from the shelf as another is put on it.
  assert.deepEqual(
    Object.keys(shelveHandoff(shelf, { id: 'b', tab: 'history', at: at + CARD_HANDOFF_MS })),
    ['b'],
  );
  const ok = { id: 'a', tab: 'notes', at };
  for (const bad of [
    null,
    [ok],
    'a',
    { a: { ...ok, id: 'b' } },
    { a: { ...ok, tab: 'news' } },
    { a: { ...ok, notes: 3 } },
    { a: { ...ok, notes: 'x'.repeat(12_001) } },
    { a: { ...ok, at: 'now' } },
    { '': { ...ok, id: '' } },
  ])
    assert.deepEqual(readHandoffShelf(bad, at), {}, JSON.stringify(bad)?.slice(0, 60));
});

test("A card's old window goes once the moved one shows, unless the person took it elsewhere", () => {
  // From the preview: put away and kept as the preview again for reuse.
  assert.deepEqual(cardLeftBehind({ pinned: false, id: 'a' }, 'a', false), {
    close: true,
    preview: true,
  });
  // Another colleague was opened while the new window loaded: it got its own preview, so this
  // one, still on the moved colleague, goes for good (and never the other colleague's card).
  assert.deepEqual(cardLeftBehind({ pinned: false, id: 'a' }, 'a', true), {
    close: true,
    preview: false,
  });
  // The person took the old card to another colleague from inside it: it stays, as the preview
  // again when there is none.
  assert.deepEqual(cardLeftBehind({ pinned: false, id: 'b' }, 'a', false), {
    close: false,
    preview: true,
  });
  assert.deepEqual(cardLeftBehind({ pinned: false, id: 'b' }, 'a', true), {
    close: false,
    preview: false,
  });
  // A pinned card or its own window: closed, never made the preview.
  assert.deepEqual(cardLeftBehind({ pinned: true, id: 'a' }, 'a', false), {
    close: true,
    preview: false,
  });
  assert.deepEqual(cardLeftBehind({ pinned: true, id: null }, 'a', false), {
    close: false,
    preview: false,
  });
});
