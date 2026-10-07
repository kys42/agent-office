import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficeService } from '../server/service.js';
import { parseRecords } from '../server/adapters/normalize.js';
import type { Snapshot } from '../src/shared/types.js';

test('Newest activity wins when two rollout files describe the same session', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-duplicate-'));
  const root = path.join(temp, 'sessions');
  await mkdir(root);
  const id = '01a102c7-f8f8-71a0-82a0-aaaa4defdf64';
  const now = Date.now();
  const service = new OfficeService(path.join(temp, 'data'), temp);
  service.roots.codex = root;
  service.store.preferences({ enabledProviders: ['codex'] });
  try {
    for (const [label, at] of [
      ['new', now],
      ['old', now - 3600_000],
    ] as const) {
      const file = path.join(root, `rollout-${label}-${id}.jsonl`);
      await writeFile(
        file,
        [
          { type: 'session_meta', timestamp: new Date(at).toISOString(), payload: { id } },
          {
            type: 'response_item',
            timestamp: new Date(at).toISOString(),
            payload: { type: 'function_call', name: 'exec', call_id: label },
          },
        ]
          .map((x) => JSON.stringify(x))
          .join('\n') + '\n',
      );
      await utimes(file, at / 1000, at / 1000);
    }
    const snapshot = await service.refresh();
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0].updatedAt, now);
    assert.equal(snapshot.sessions[0].status, 'work');
    assert.match(snapshot.sessions[0].sourcePath, /rollout-new-/);
  } finally {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  }
});

test('Stopping the collector ends polling without touching the closed store', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-stop-'));
  const service = new OfficeService(path.join(temp, 'data'), temp);
  const missing = path.join(temp, 'missing');
  service.roots = { claude: missing, codex: missing, openclaw: missing };
  const refresh = t.mock.method(service, 'refresh');
  try {
    service.start();
    await service.pending;
    // Stopped while a polling pass is under way: it ends without emitting from the closed
    // store, nothing is rescheduled and no rejection escapes the timer.
    t.mock.timers.tick(5000);
    assert.equal(refresh.mock.callCount(), 2);
    const inflight = service.pending!;
    service.stop();
    await assert.rejects(inflight);
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(5000);
    t.mock.timers.tick(5000);
    assert.equal(refresh.mock.callCount(), 2);
    await assert.rejects(service.refresh());
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('Pinning a persona is one validated call and one snapshot; identities are read-only', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-pin-'));
  const service = new OfficeService(path.join(temp, 'data'), temp);
  try {
    const sessions = ['a', 'b', 'c'].map((id) =>
      parseRecords([{ type: 'session_meta', payload: { id, cwd: '/test/project' } }], {
        provider: 'codex',
        sourcePath: `/test/${id}.jsonl`,
        mtime: Date.now(),
      }),
    );
    service.store.upsert(sessions, 'codex');
    const ids = sessions.map((s) => s.id);
    let emitted = 0;
    service.on('snapshot', () => emitted++);
    const snapshot = (await service.call('pin', [ids, true])) as Snapshot;
    assert.equal(emitted, 1, 'one snapshot for the whole persona');
    assert.ok(snapshot.sessions.every((s) => s.pinned));
    for (const args of [
      [ids, 'yes'],
      ['a', true],
      [Array.from({ length: 501 }, (_, i) => `codex:${i}`), true],
      [['x'.repeat(401)], true],
    ])
      await assert.rejects(service.call('pin', args));
    await assert.rejects(service.call('pin', [[ids[0], 'codex:missing'], false]));
    assert.ok(service.store.get(ids[0]).pinned, 'all or nothing');
    assert.equal(emitted, 1, 'a refused request emits nothing');

    const found = (await service.call('identities', [[ids[0], 'codex:missing']])) as unknown[];
    assert.deepEqual(found, [
      { id: ids[0], provider: 'codex', nativeId: 'a', sourcePath: '/test/a.jsonl' },
    ]);
    for (const args of [[ids[0]], [[1]], [Array.from({ length: 501 }, () => ids[0])]])
      await assert.rejects(service.call('identities', args));
    assert.equal(emitted, 1);
  } finally {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  }
});
