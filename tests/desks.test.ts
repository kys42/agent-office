import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  DEFAULT_DESK_LOOK,
  DESK_CHAIRS,
  DESK_COLLEAGUE_CAP,
  DESK_ITEMS,
  DESK_MONITORS,
  deskAssets,
  deskLayer,
  deskLook,
  mergeDeskCustomization,
  normalizeDeskCustomization,
  type DeskChair,
  type DeskCustomization,
  type DeskItem,
  type DeskMonitor,
} from '../src/shared/desks.js';
import { demoSnapshot } from '../src/lib/demo.js';
import { OfficeService } from '../server/service.js';
import type { Snapshot } from '../src/shared/types.js';

const lead = { id: 'claude:one', actor: undefined };
const persona = { id: 'claude:two', actor: { id: 'p1' } } as never;
const layered: DeskCustomization = {
  version: 1,
  office: { top: 'walnut', monitor: 'wide', itemLeft: 'plant' },
  projects: { 'team-a': { top: 'mint', chair: 'navy' } },
  colleagues: {
    'claude:one': { top: 'charcoal', monitor: 'crt', itemRight: 'duck' },
    'actor:p1': { chair: 'gaming' },
  },
};

test('Every catalog part resolves to a shipped PNG', async () => {
  const root = path.resolve('public');
  for (const monitor of Object.keys(DESK_MONITORS) as DeskMonitor[])
    for (const chair of Object.keys(DESK_CHAIRS) as DeskChair[])
      for (const item of Object.keys(DESK_ITEMS) as DeskItem[]) {
        const assets = deskAssets({
          ...DEFAULT_DESK_LOOK,
          monitor,
          chair,
          itemLeft: item,
          itemRight: item,
        });
        for (const url of [assets.monitor, assets.chair, assets.itemLeft].filter(Boolean))
          await access(path.join(root, url!));
        assert.equal(assets.itemRight === undefined, item === 'none');
      }
});
test('The default desk is today’s: oak, basic screen, green chair, a cup on the right', () => {
  assert.deepEqual(deskLook(undefined, 'team-a', lead), {
    top: 'oak',
    monitor: 'basic',
    chair: 'green',
    itemLeft: 'none',
    itemRight: 'cup',
  });
  assert.deepEqual(deskLook({ version: 1, projects: {}, colleagues: {} }), DEFAULT_DESK_LOOK);
});
test('Layers apply default → office → project → colleague, but a colleague never sets the top', () => {
  assert.deepEqual(deskLook(layered), {
    ...DEFAULT_DESK_LOOK,
    top: 'walnut',
    monitor: 'wide',
    itemLeft: 'plant',
  });
  assert.deepEqual(deskLook(layered, 'team-b', { id: 'claude:x' }), deskLook(layered));
  assert.deepEqual(deskLook(layered, 'team-a'), {
    ...DEFAULT_DESK_LOOK,
    top: 'mint',
    monitor: 'wide',
    chair: 'navy',
    itemLeft: 'plant',
  });
  // The colleague's own top is ignored: the bench is the zone's.
  assert.deepEqual(deskLook(layered, 'team-a', lead), {
    top: 'mint',
    monitor: 'crt',
    chair: 'navy',
    itemLeft: 'plant',
    itemRight: 'duck',
  });
  // A persona's desk follows the persona, across its runs.
  assert.equal(deskLook(layered, 'team-a', persona).chair, 'gaming');
});
test('Normalize keeps only catalog parts, drops colleague tops and empty layers', () => {
  const settings = normalizeDeskCustomization({
    ...layered,
    office: { top: 'https://example.com/x.png', monitor: 'dual', extra: 1 },
    projects: { 'team-a': { chair: 'toString' }, '': { chair: 'pink' }, ok: { chair: 'pink' } },
  });
  assert.deepEqual(settings.office, { monitor: 'dual' });
  assert.deepEqual(settings.projects, { ok: { chair: 'pink' } });
  assert.deepEqual(settings.colleagues['claude:one'], { monitor: 'crt', itemRight: 'duck' });
  for (const value of [null, 'x', { version: 2 }, { version: 1, projects: 'x' }])
    assert.deepEqual(deskLook(normalizeDeskCustomization(value)), DEFAULT_DESK_LOOK);
});
test('Merge replaces a layer whole, null deletes, and the cap keeps what was just chosen', () => {
  let settings = mergeDeskCustomization(layered, {
    version: 1,
    office: null,
    projects: { 'team-a': { monitor: 'laptop' } },
    colleagues: { 'claude:one': null },
  });
  assert.equal(settings.office, undefined);
  assert.deepEqual(settings.projects, { 'team-a': { monitor: 'laptop' } });
  assert.deepEqual(Object.keys(settings.colleagues), ['actor:p1']);
  // Left out: kept as it was.
  settings = mergeDeskCustomization(settings, { version: 1, projects: {}, colleagues: {} });
  assert.deepEqual(settings.projects, { 'team-a': { monitor: 'laptop' } });
  const crowd = Object.fromEntries(
    Array.from({ length: DESK_COLLEAGUE_CAP }, (_, i) => [`c${i}`, { chair: 'pink' as const }]),
  );
  settings = mergeDeskCustomization(
    { version: 1, projects: {}, colleagues: crowd },
    {
      version: 1,
      projects: {},
      colleagues: { c0: { chair: 'stool' }, fresh: { chair: 'gaming' } },
    },
  );
  const keys = Object.keys(settings.colleagues);
  assert.equal(keys.length, DESK_COLLEAGUE_CAP);
  assert.deepEqual(keys.slice(-2), ['c0', 'fresh']);
  assert.equal(settings.colleagues.c1, undefined);
});
test('A layer stores only what differs from the layers below', () => {
  const below = deskLook(layered, 'team-a');
  assert.deepEqual(deskLayer(below, below), {});
  assert.deepEqual(deskLayer({ ...below, chair: 'stool' }, below), { chair: 'stool' });
});
test('The service saves desk looks through preferences and rejects unknown parts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-desk-service-'));
  const service = new OfficeService(dir, dir);
  try {
    const s = demoSnapshot().sessions[0];
    const snapshot = (await service.call('preferences', [
      {
        deskAppearance: {
          version: 1,
          office: { monitor: 'crt' },
          projects: {},
          colleagues: { [s.id]: { chair: 'gaming' } },
        },
      },
    ])) as Snapshot;
    assert.deepEqual(snapshot.preferences.deskAppearance?.office, { monitor: 'crt' });
    await service.call('preferences', [
      { deskAppearance: { version: 1, projects: { p: { top: 'sea' } }, colleagues: {} } },
    ]);
    const saved = service.store.preferences().deskAppearance;
    assert.deepEqual(deskLook(saved, 'p', s), {
      ...DEFAULT_DESK_LOOK,
      top: 'sea',
      monitor: 'crt',
      chair: 'gaming',
    });
    for (const layer of [
      { monitor: 'https://example.com/m.png' },
      { chair: 'throne' },
      { itemLeft: 'sword' },
      { script: 'bad' },
    ])
      await assert.rejects(
        service.call('preferences', [
          { deskAppearance: { version: 1, office: layer, projects: {}, colleagues: {} } },
        ]),
      );
    assert.deepEqual(service.store.preferences().deskAppearance?.office, { monitor: 'crt' });
  } finally {
    service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('dual screens take the left end of the desk: no left item is drawn beside them', () => {
  const look = { ...DEFAULT_DESK_LOOK, itemLeft: 'lamp' as const, itemRight: 'duck' as const };
  assert.ok(deskAssets(look).itemLeft?.endsWith('item-lamp.png'));
  const dual = deskAssets({ ...look, monitor: 'dual' });
  assert.equal(dual.itemLeft, undefined);
  assert.ok(dual.itemRight?.endsWith('item-duck.png'), 'the right item stays');
});
