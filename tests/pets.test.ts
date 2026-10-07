import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  PET_CHARACTERS,
  PET_COLORS,
  PET_ACCESSORIES,
  petLook,
  petKey,
  petAssets,
  normalizePetCustomization,
  mergePetCustomization,
  defaultPetLook,
  type PetLook,
  type PetCharacter,
  type PetColor,
  type PetAccessory,
} from '../src/shared/pets.js';
import { demoSnapshot } from '../src/lib/demo.js';
import { OfficeStore } from '../server/store.js';
import { OfficeService } from '../server/service.js';
import type { Snapshot } from '../src/shared/types.js';

const slime: PetLook = { character: 'slime', color: 'mint', accessory: 'crown' };
const cat: PetLook = { character: 'devcat', color: 'peach', accessory: 'beret' };
test('Every catalog combination resolves to shipped PNGs with four frames and all mood/walk rows', async () => {
  for (const character of Object.keys(PET_CHARACTERS) as PetCharacter[]) {
    for (const color of Object.keys(PET_COLORS) as PetColor[]) {
      for (const accessory of Object.keys(PET_ACCESSORIES) as PetAccessory[]) {
        const assets = petAssets({ character, color, accessory });
        for (const [file, rows] of [
          [assets.sheet, 8],
          [assets.walk, 3],
          [assets.decoration, 8],
          [assets.decorationWalk, 3],
        ] as const) {
          if (!file) continue;
          const data = await readFile(path.resolve('public', file));
          assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', file);
          assert.equal(data.toString('ascii', 12, 16), 'IHDR', file);
          const width = data.readUInt32BE(16),
            height = data.readUInt32BE(20);
          assert.equal(width / 4, height / rows, file);
          assert.ok([32, 128].includes(width / 4), file);
          assert.equal(data[25], 6, `RGBA transparency: ${file}`);
        }
      }
    }
  }
});
test('Appearance follows provider defaults and stable colleague identity, independent of aliases and new runs', () => {
  const s = demoSnapshot().sessions[0];
  const settings = mergePetCustomization(undefined, {
    version: 1,
    providers: { claude: slime },
    colleagues: { [s.id]: cat },
  });
  assert.deepEqual(petLook('claude', settings, s), cat);
  assert.deepEqual(petLook('claude', settings, { ...s, id: 'other' }), slime);
  assert.deepEqual(petLook('codex', settings), defaultPetLook('codex'));
  const actorA = { ...s, actor: { id: 'claw:assistant', name: '친구', source: 'test' } };
  const actorB = { ...actorA, id: 'new-run', alias: '새 별명' };
  settings.colleagues[petKey(actorA)] = cat;
  assert.equal(petKey(actorA), petKey(actorB));
  assert.deepEqual(petLook('openclaw', settings, actorB), cat);
});
test('Small appearance patches preserve unrelated windows and null resets resume inheritance', () => {
  const first = mergePetCustomization(undefined, {
    version: 1,
    providers: { claude: slime },
    colleagues: { one: cat },
  });
  const second = mergePetCustomization(first, {
    version: 1,
    providers: { codex: cat },
    colleagues: { two: slime },
  });
  const reset = mergePetCustomization(second, {
    version: 1,
    providers: { codex: null },
    colleagues: { one: null },
  });
  assert.deepEqual(reset.providers, { claude: slime });
  assert.deepEqual(reset.colleagues, { two: slime });
  assert.deepEqual(petLook('claude', reset, { id: 'one' }), slime);
  assert.deepEqual(petLook('claude', reset, { id: 'two' }), slime);
});
test('At the colleague cap a new or changed look is kept and the oldest untouched one goes', () => {
  const full = mergePetCustomization(undefined, {
    version: 1,
    providers: {},
    colleagues: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`c${i}`, slime])),
  });
  assert.equal(Object.keys(full.colleagues).length, 3000);
  const added = mergePetCustomization(full, {
    version: 1,
    providers: {},
    colleagues: { new: cat },
  });
  assert.equal(Object.keys(added.colleagues).length, 3000);
  assert.deepEqual(petLook('claude', added, { id: 'new' }), cat);
  assert.equal(Object.hasOwn(added.colleagues, 'c0'), false);
  assert.ok(Object.hasOwn(added.colleagues, 'c1'));
  // Changing the oldest colleague while adding another keeps both.
  const both = mergePetCustomization(added, {
    version: 1,
    providers: {},
    colleagues: { c1: cat, other: cat },
  });
  assert.equal(Object.keys(both.colleagues).length, 3000);
  assert.deepEqual(petLook('claude', both, { id: 'c1' }), cat);
  assert.deepEqual(petLook('claude', both, { id: 'other' }), cat);
  assert.deepEqual(petLook('claude', both, { id: 'new' }), cat);
  assert.equal(Object.hasOwn(both.colleagues, 'c2'), false);
});
test('Unknown versions, assets, inherited object keys and malformed colors recover to original characters', () => {
  const bad = { ...slime, character: '../../remote.png' };
  const recovered = normalizePetCustomization({
    version: 1,
    providers: { claude: bad, codex: cat },
    colleagues: { bad: { ...cat, color: 90 }, good: slime },
  });
  assert.deepEqual(recovered.providers, { codex: cat });
  assert.deepEqual(recovered.colleagues, { good: slime });
  for (const value of [
    null,
    [],
    { version: 2 },
    { version: 1, providers: { claude: { ...cat, character: 'toString' } } },
  ]) {
    const settings = normalizePetCustomization(value);
    assert.deepEqual(petLook('claude', settings), defaultPetLook('claude'));
  }
});
test('Customization survives source re-import and SQLite restart without modifying source sessions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-pet-store-'));
  let store = new OfficeStore(dir);
  try {
    const s = { ...demoSnapshot().sessions[0], sourceKind: 'jsonl' as const };
    store.upsert([s], 'claude');
    store.preferences({
      petAppearance: { version: 1, providers: { claude: slime }, colleagues: { [s.id]: cat } },
    });
    store.upsert([{ ...s, title: '이름이 바뀐 원본', revision: 'new-version' }], 'claude');
    const before = store.get(s.id);
    store.close();
    store = new OfficeStore(dir);
    const prefs = store.preferences();
    assert.deepEqual(petLook('claude', prefs.petAppearance, store.get(s.id)), cat);
    assert.equal(store.get(s.id).title, before.title);
    assert.equal(store.get(s.id).revision, before.revision);
    const raw = store.db.prepare('SELECT data FROM sessions WHERE id=?').get(s.id) as {
      data: string;
    };
    assert.equal(Object.hasOwn(JSON.parse(raw.data), 'petAppearance'), false);
    store.preferences({
      petAppearance: { version: 1, providers: {}, colleagues: { [s.id]: null } },
    });
    assert.deepEqual(petLook('claude', store.preferences().petAppearance, s), slime);
    store.db
      .prepare("UPDATE settings SET value=? WHERE key='preferences'")
      .run(JSON.stringify({ petAppearance: { version: 99 } }));
    assert.deepEqual(
      petLook('claude', store.preferences().petAppearance, s),
      defaultPetLook('claude'),
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('Service accepts catalog appearance patches and rejects unsupported fields without mutating preferences', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-pet-service-'));
  const service = new OfficeService(dir, dir);
  try {
    const snapshot = (await service.call('preferences', [
      { petAppearance: { version: 1, providers: { claude: slime }, colleagues: {} } },
    ])) as Snapshot;
    assert.deepEqual(snapshot.preferences.petAppearance?.providers.claude, slime);
    for (const look of [
      { ...slime, character: 'https://example.com/pet.png' },
      { ...slime, color: 'unknown' },
      { ...slime, accessory: 'unknown' },
      { ...slime, script: 'bad' },
    ]) {
      await assert.rejects(
        service.call('preferences', [
          { petAppearance: { version: 1, providers: { claude: look }, colleagues: {} } },
        ]),
      );
    }
    await assert.rejects(
      service.call('preferences', [
        { petAppearance: { version: 2, providers: {}, colleagues: {} } },
      ]),
    );
    assert.deepEqual(service.store.preferences().petAppearance?.providers.claude, slime);
  } finally {
    service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
