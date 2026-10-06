import type { Snapshot } from '../src/shared/types.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OfficeService } from '../server/service.js';
import { OfficeStore } from '../server/store.js';
import { parseRecords } from '../server/adapters/normalize.js';
import { mergeSessions } from '../server/adapters/merge.js';
import { officeZone } from '../src/shared/office.js';
import { officeResidents } from '../src/shared/residents.js';
import { demoSnapshot } from '../src/lib/demo.js';
const now = Date.now(),
  day = 86400_000;

test('Days-long office schedules, automatic archive opt-out and pin/manual archive priorities', () => {
  const s = { ...demoSnapshot().sessions[0], updatedAt: now, pinned: false, archived: false };
  const p = { standbyHours: 72, archiveDays: 14 };
  assert.equal(officeZone(s, p, now + 2 * day), 'office');
  assert.equal(officeZone(s, p, now + 3 * day), 'waiting');
  assert.equal(officeZone(s, p, now + 14 * day), 'archive');
  assert.equal(officeZone(s, { ...p, autoArchive: false }, now + 400 * day), 'waiting');
  assert.equal(officeZone({ ...s, pinned: true }, p, now + 400 * day), 'office');
  assert.equal(
    officeZone({ ...s, pinned: true, archived: true }, { ...p, autoArchive: false }, now),
    'archive',
  );
});
test('Schedule preferences validate together through the service and persist without changing prior defaults', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-schedule-'));
  const service = new OfficeService(dir, dir);
  let stopped = false;
  try {
    assert.equal(service.store.preferences().standbyHours, 4);
    assert.equal(service.store.preferences().archiveDays, 7);
    const s = (await service.call('preferences', [
      { standbyHours: 72, archiveDays: 14, autoArchive: false },
    ])) as Snapshot;
    assert.equal(s.preferences.standbyHours, 72);
    await assert.rejects(service.call('preferences', [{ standbyHours: 2161 }]));
    await assert.rejects(service.call('preferences', [{ archiveDays: 1, autoArchive: true }]));
    assert.equal(service.store.preferences().autoArchive, false);
    assert.equal(service.store.preferences().archiveDays, 14);
    service.stop();
    stopped = true;
    const reopened = new OfficeStore(dir);
    assert.equal(reopened.preferences().standbyHours, 72);
    assert.equal(reopened.preferences().autoArchive, false);
    reopened.close();
  } finally {
    if (!stopped) service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test('Task boundary survives long tool tails, transport merge, compact snapshots and source re-reads', async () => {
  const rows = [
    {
      type: 'session_meta',
      timestamp: new Date(now - 10000).toISOString(),
      payload: { id: 'parent' },
    },
    {
      type: 'event_msg',
      timestamp: new Date(now).toISOString(),
      payload: { type: 'user_message', message: '다음 작업 시작' },
    },
    ...Array.from({ length: 220 }, (_, i) => ({
      type: 'response_item',
      timestamp: new Date(now + i + 1).toISOString(),
      payload: { type: 'function_call', name: 'exec', call_id: `c-${i}` },
    })),
  ];
  const parent = parseRecords(rows, {
    provider: 'codex',
    sourcePath: '/tmp/parent.jsonl',
    mtime: now + 300,
    now: now + 300,
  });
  assert.equal(
    parent.events.some((e) => e.kind === 'user'),
    false,
  );
  assert.equal(parent.taskStartedAt, now);
  const fragment = {
    ...parent,
    events: parent.events.slice(-4),
    taskStartedAt: undefined,
    updatedAt: now + 500,
    revision: 'tail',
  };
  assert.equal(mergeSessions([parent, fragment])[0].taskStartedAt, now);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-task-anchor-'));
  const store = new OfficeStore(dir);
  try {
    const child = {
      ...parent,
      id: 'codex:child',
      nativeId: 'child',
      taskStartedAt: now - 1000,
      startedAt: now - 1000,
      status: 'done' as const,
      observedStatus: 'done' as const,
      relation: { kind: 'subagent' as const, parentNativeId: 'parent', source: 'fixture' },
    };
    store.upsert([parent, child], 'codex');
    assert.equal(store.list().find((s) => s.id === parent.id)?.events.length, 4);
    assert.equal(officeResidents(store.list(), now + 300).hidden.length, 1);
    store.upsert([fragment, child], 'codex');
    assert.equal(store.get(parent.id).taskStartedAt, now);
    assert.equal(officeResidents(store.list(), now + 500).hidden.length, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
