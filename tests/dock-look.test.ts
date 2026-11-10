import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DOCK_LOOK,
  dockLookName,
  dockViewChecked,
  dockViewStep,
  readDockLook,
} from '../src/shared/dock-look.js';
import { m, setLocale } from '../src/shared/i18n/index.js';

test('the big office names the look the dock goes back to', () => {
  assert.equal(dockLookName({ mode: 'pet', tiny: false }), 'pet');
  // Tiny is the row's and the floor's: the pet keeps its size.
  assert.equal(dockLookName({ mode: 'pet', tiny: true }), 'pet');
  assert.equal(dockLookName({ mode: 'row', tiny: false }), 'row');
  assert.equal(dockLookName({ mode: 'floor', tiny: false }), 'floor');
  assert.equal(dockLookName({ mode: 'row', tiny: true }), 'tinyRow');
  assert.equal(dockLookName({ mode: 'floor', tiny: true }), 'tinyFloor');
  setLocale('ko');
  const looks = m().dock.view.looks;
  assert.equal(looks[dockLookName({ mode: 'row', tiny: true })], '쪼꼬미 줄');
  assert.equal(looks[dockLookName(DEFAULT_DOCK_LOOK)], '데스크 펫');
});

test('a look from another window is read safely, the pet by default', () => {
  assert.deepEqual(readDockLook({ mode: 'floor', tiny: true }), { mode: 'floor', tiny: true });
  assert.deepEqual(readDockLook({ mode: 'row' }), { mode: 'row', tiny: false });
  for (const raw of [null, undefined, 'row', 3, { mode: 'wall', tiny: 'yes' }])
    assert.deepEqual(readDockLook(raw), DEFAULT_DOCK_LOOK);
});

test('the 보기 menu: looks keep the tiny size, the tiny toggle flips it', () => {
  const tinyRow = { mode: 'row', tiny: true } as const;
  assert.deepEqual(dockViewStep(tinyRow, 'floor'), { mode: 'floor' });
  assert.deepEqual(dockViewStep(tinyRow, 'pet'), { mode: 'pet' });
  assert.deepEqual(dockViewStep(tinyRow, 'row'), {});
  assert.deepEqual(dockViewStep(tinyRow, 'tiny'), { tiny: false });
  assert.deepEqual(dockViewStep({ mode: 'floor', tiny: false }, 'tiny'), { tiny: true });
  // From the pet, tiny unfolds the last unfolded look small (the row the first time).
  assert.deepEqual(dockViewStep(DEFAULT_DOCK_LOOK, 'tiny'), { tiny: true, mode: 'row' });
  assert.deepEqual(dockViewStep(DEFAULT_DOCK_LOOK, 'tiny', 'floor'), {
    tiny: true,
    mode: 'floor',
  });
  // Tiny already remembered: just unfold.
  assert.deepEqual(dockViewStep({ mode: 'pet', tiny: true }, 'tiny', 'floor'), { mode: 'floor' });
});

test('the 보기 menu checks the current look, and tiny only on the row or floor', () => {
  const pet = { mode: 'pet', tiny: true } as const;
  assert.equal(dockViewChecked(pet, 'pet'), true);
  assert.equal(dockViewChecked(pet, 'row'), false);
  assert.equal(dockViewChecked(pet, 'tiny'), false);
  const floor = { mode: 'floor', tiny: true } as const;
  assert.equal(dockViewChecked(floor, 'floor'), true);
  assert.equal(dockViewChecked(floor, 'tiny'), true);
  assert.equal(dockViewChecked({ mode: 'row', tiny: false }, 'tiny'), false);
});
