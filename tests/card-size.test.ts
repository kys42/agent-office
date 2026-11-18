import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CardSizeMemory, CARD_RESIZE_SETTLE_MS, type Size } from '../desktop/card-size.js';

class FakeWindow extends EventEmitter {
  size = [380, 480];
  destroyed = false;
  isDestroyed() {
    return this.destroyed;
  }
  getSize() {
    return [...this.size];
  }
  /** The person drags an edge: the platform emits `resize` per step, then `resized` (macOS/Windows). */
  drag(steps: number[][], platform: 'linux' | 'other') {
    for (const step of steps) {
      this.size = step;
      this.emit('resize');
    }
    if (platform === 'other') this.emit('resized');
  }
  /** The app places the card (`setBounds`): `resize` on every platform, never `resized`. */
  place(size: number[]) {
    this.size = size;
    this.emit('resize');
  }
}

const setup = (platform: NodeJS.Platform) => {
  const saved: Size[] = [];
  const memory = new CardSizeMemory({ width: 380, height: 480 }, (s) => saved.push(s), platform);
  const window = new FakeWindow();
  const card = { placed: { width: 380, height: 480 }, pinned: false };
  memory.watch(window, card);
  return { memory, saved, window, card };
};

test('Linux saves a resized card once its edge stops moving (no `resized` event there)', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { memory, saved, window, card } = setup('linux');
    window.drag(
      [
        [400, 500],
        [450, 560],
        [500, 600],
      ],
      'linux',
    );
    assert.deepEqual(saved, [], 'not while the edge still moves');
    mock.timers.tick(CARD_RESIZE_SETTLE_MS - 1);
    window.drag([[520, 620]], 'linux');
    mock.timers.tick(CARD_RESIZE_SETTLE_MS - 1);
    assert.deepEqual(saved, []);
    mock.timers.tick(1);
    assert.deepEqual(saved, [{ width: 520, height: 620 }], 'saved once, at the final size');
    assert.deepEqual(memory.size, { width: 520, height: 620 });
    assert.deepEqual(card.placed, { width: 520, height: 620 });
    mock.timers.tick(CARD_RESIZE_SETTLE_MS * 5);
    assert.equal(saved.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test('macOS and Windows save on `resized` only, so a resize is not saved twice', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { saved, window } = setup(platform);
      window.drag(
        [
          [400, 500],
          [500, 600],
        ],
        'other',
      );
      assert.deepEqual(saved, [{ width: 500, height: 600 }], platform);
      mock.timers.tick(CARD_RESIZE_SETTLE_MS * 5);
      assert.equal(saved.length, 1, `${platform}: no second save from \`resize\``);
    } finally {
      mock.timers.reset();
    }
  }
});

test('A placement by the app is not taken as the person resizing (Linux `resize`)', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { memory, saved, window, card } = setup('linux');
    // open(): the placed size is set first, then the window is moved there.
    card.placed = { width: 380, height: 360 };
    window.place([380, 360]);
    mock.timers.tick(CARD_RESIZE_SETTLE_MS);
    assert.deepEqual(saved, [], 'a fitted placement is not saved');
    assert.deepEqual(memory.size, { width: 380, height: 480 });
    // Only the side the person changed is remembered; the fitted height stays the old choice.
    window.drag([[460, 360]], 'linux');
    mock.timers.tick(CARD_RESIZE_SETTLE_MS);
    assert.deepEqual(saved, [{ width: 460, height: 480 }]);
  } finally {
    mock.timers.reset();
  }
});

test('Pinned and closed cards do not change the opening size', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { saved, window, card } = setup('linux');
    card.pinned = true;
    window.drag([[600, 700]], 'linux');
    mock.timers.tick(CARD_RESIZE_SETTLE_MS);
    assert.deepEqual(saved, [], 'a pinned card keeps its own bounds');
    card.pinned = false;
    window.drag([[620, 720]], 'linux');
    window.emit('closed');
    window.destroyed = true;
    mock.timers.tick(CARD_RESIZE_SETTLE_MS);
    assert.deepEqual(saved, [], 'no write after the window closed');
  } finally {
    mock.timers.reset();
  }
  const mac = setup('darwin');
  mac.card.pinned = true;
  mac.window.drag([[600, 700]], 'other');
  assert.deepEqual(mac.saved, []);
});
