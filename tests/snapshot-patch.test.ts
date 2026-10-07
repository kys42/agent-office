import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, utimes, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { demoSnapshot } from '../src/lib/demo.js';
import {
  adoptSnapshot,
  applyPatch,
  composePatches,
  diffSnapshot,
  indexSnapshot,
  type SnapshotMessage,
  type SnapshotPatch,
} from '../src/shared/snapshot-patch.js';
import { SnapshotDelivery, type Viewer } from '../desktop/delivery.js';
import { OfficeService } from '../server/service.js';
import type { Snapshot } from '../src/shared/types.js';

const base = (): Snapshot => ({ ...demoSnapshot(), epoch: 'run', version: 1 });
const patchOf = (prev: Snapshot, next: Snapshot): SnapshotPatch => ({
  kind: 'patch',
  epoch: 'run',
  base: prev.version,
  version: next.version,
  ...diffSnapshot(indexSnapshot(prev), next),
});
/** A later office: one colleague renamed, one gone, one new, order moved, a notice and a field. */
function later(prev: Snapshot, version: number): Snapshot {
  const [first, , ...rest] = structuredClone(prev.sessions);
  const added = { ...structuredClone(rest[0]), id: `new-${version}`, title: '새 동료' };
  return {
    ...structuredClone(prev),
    version,
    sessions: [added, ...rest, { ...first, title: `${first.title} (고침 ${version})` }],
    notices: [
      ...(prev.notices ?? []).slice(1).map((n) => structuredClone(n)),
      { ...structuredClone(prev.notices![0]), id: `notice-${version}`, text: '새 소식' },
    ],
    lastSync: (prev.lastSync ?? 0) + version,
    error: version % 2 ? null : '확인 필요',
  };
}

test('A patch carries only what changed and rebuilds the same office', () => {
  const prev = base();
  const next = later(prev, 2);
  const patch = patchOf(prev, next);
  assert.equal(patch.sessions?.length, 2, 'the renamed and the new colleague only');
  assert.deepEqual(patch.removed, [prev.sessions[1].id]);
  assert.ok(patch.order && patch.noticeOrder && patch.fields);
  assert.deepEqual(Object.keys(patch.fields!).sort(), ['error', 'lastSync']);
  const applied = applyPatch(prev, patch);
  assert.deepEqual(applied, next);
  // Colleagues that did not change are the very same objects: nothing to redraw for them.
  for (const s of applied.sessions.slice(1, -1))
    assert.equal(
      s,
      prev.sessions.find((p) => p.id === s.id),
    );
  // Nothing changed: an empty patch, and applying it changes nothing.
  const quiet = diffSnapshot(indexSnapshot(next), next);
  assert.deepEqual(quiet, {});
});

test('Several patches in a row compose into one, including a colleague who left and came back', () => {
  const v1 = base();
  const v2 = later(v1, 2);
  const v3: Snapshot = {
    ...structuredClone(v2),
    version: 3,
    sessions: [...v2.sessions, v1.sessions[1]],
  };
  const v4 = later(v3, 4);
  const patches = [patchOf(v1, v2), patchOf(v2, v3), patchOf(v3, v4)];
  const stepwise = patches.reduce(applyPatch, v1);
  assert.deepEqual(stepwise, v4);
  const composed = composePatches(patches);
  assert.equal(composed.base, 1);
  assert.equal(composed.version, 4);
  assert.deepEqual(applyPatch(v1, composed), v4);
});

test('A whole office reuses unchanged objects; an older version of the same run is dropped', () => {
  const prev = base();
  const next = { ...later(prev, 2) };
  const adopted = adoptSnapshot(prev, next);
  assert.deepEqual(adopted, next);
  const same = adopted.sessions.find((s) => s.id === prev.sessions[2].id);
  assert.equal(same, prev.sessions[2]);
  assert.equal(adoptSnapshot(adopted, prev), adopted, 'version 1 after version 2 is stale');
  assert.equal(adoptSnapshot(adopted, { ...next }), adopted, 'the same version again');
  // Another run (the collector restarted) always replaces it.
  const restarted = { ...prev, epoch: 'other', version: 1 };
  assert.equal(adoptSnapshot(adopted, restarted).epoch, 'other');
  // Fixtures without a run always apply.
  const fixture = { ...prev, epoch: undefined, version: 1 };
  assert.equal(adoptSnapshot({ ...fixture }, fixture).epoch, undefined);
});

test('Windows holding the starting version get the patch; others the office; hidden nothing', () => {
  const v1 = base();
  const v2 = later(v1, 2);
  const got: Record<number, SnapshotMessage[]> = { 1: [], 2: [], 3: [] };
  let thirdShown = false;
  const viewers: Viewer[] = [
    { id: 1, shown: () => true, send: (m) => got[1].push(m) },
    { id: 2, shown: () => true, send: (m) => got[2].push(m) },
    { id: 3, shown: () => thirdShown, send: (m) => got[3].push(m) },
  ];
  const delivery = new SnapshotDelivery();
  delivery.publish(v1, viewers.slice(0, 1));
  assert.equal(delivery.update(patchOf(v1, v2), viewers), true);
  assert.equal((got[1][1] as SnapshotPatch).kind, 'patch', 'window 1 held v1');
  assert.deepEqual(got[2], [delivery.latest], 'window 2 held nothing: the whole office');
  assert.deepEqual(delivery.latest, v2);
  assert.equal(got[3].length, 0);
  thirdShown = true;
  delivery.reveal(viewers[2]);
  assert.deepEqual(got[3], [delivery.latest]);
  // A patch that does not start from what is held asks for the whole office.
  assert.equal(delivery.update({ ...patchOf(v1, v2), base: 7, version: 8 }, viewers), false);
});

test('The collector sends a changed colleague as a patch and catches a poller up', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-patch-'));
  const project = path.join(temp, 'claude', 'projects', 'demo');
  await mkdir(project, { recursive: true });
  const at = Date.now() - 60_000;
  const line = (id: string, i: number, text: string) =>
    JSON.stringify({
      type: 'user',
      sessionId: id,
      timestamp: new Date(at + i * 1000).toISOString(),
      cwd: '/tmp/demo',
      message: { role: 'user', content: text },
    }) + '\n';
  const ids = ['aaaa1111-0000-0000-0000-000000000001', 'bbbb2222-0000-0000-0000-000000000002'];
  for (const id of ids) await writeFile(path.join(project, `${id}.jsonl`), line(id, 0, '시작'));
  const service = new OfficeService(path.join(temp, 'data'), temp);
  service.roots.claude = path.join(temp, 'claude', 'projects');
  service.store.preferences({ enabledProviders: ['claude'] });
  const patches: SnapshotPatch[] = [];
  service.on(
    'snapshot',
    (_s: Snapshot, patch: SnapshotPatch | null) => patch && patches.push(patch),
  );
  try {
    const first = (await service.refresh()) as Snapshot;
    // Without a poller nothing is kept: one who asks first gets the whole office back.
    assert.equal(
      ((await service.call('snapshot', [first.epoch, first.version])) as { unchanged?: boolean })
        .unchanged,
      true,
    );
    const touch = async (n: number) => {
      const file = path.join(project, `${ids[0]}.jsonl`);
      await appendFile(file, line(ids[0], n, `요청 ${n}`));
      const t = (Date.now() + n * 1000) / 1000;
      await utimes(file, t, t);
      return (await service.refresh()) as Snapshot;
    };
    const second = await touch(1);
    assert.equal(patches.length, 1);
    assert.deepEqual(
      patches[0].sessions?.map((s) => s.id),
      [first.sessions.find((s) => s.nativeId === ids[0])!.id],
      'only the colleague who changed',
    );
    assert.deepEqual(applyPatch(first, patches[0]), second);
    const third = await touch(2);
    // A poller two versions behind gets both changes as one patch; a current one gets nothing.
    const caught = (await service.call('snapshot', [first.epoch, first.version])) as SnapshotPatch;
    assert.equal(caught.kind, 'patch');
    assert.deepEqual(applyPatch(first, caught), third);
    assert.deepEqual(await service.call('snapshot', [third.epoch, third.version]), {
      unchanged: true,
      epoch: third.epoch,
      version: third.version,
    });
    // Mid-collection, a new client still gets exactly what was published as this version.
    service.syncing = true;
    const boot = (await service.call('snapshot')) as Snapshot;
    service.syncing = false;
    assert.equal(boot.syncing, false);
    assert.deepEqual(boot, third);
    // A version it no longer has the changes for: the whole office.
    const whole = (await service.call('snapshot', [first.epoch, -5])) as Snapshot;
    assert.equal(whole.version, third.version);
    assert.ok(Array.isArray(whole.sessions));
  } finally {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  }
});
