import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficeService } from '../server/service.js';
import { OfficeStore } from '../server/store.js';
import { ServiceBridge } from '../server/bridge.js';
import { buildOfficeModel } from '../src/shared/office-model.js';
import { officeResidents } from '../src/shared/residents.js';
import { demoSnapshot } from '../src/lib/demo.js';
import type { Session, Snapshot } from '../src/shared/types.js';

async function claudeHome(ids: string[]) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-persist-'));
  const project = path.join(temp, 'claude', 'projects', 'demo');
  await mkdir(project, { recursive: true });
  const at = Date.now() - 60_000;
  for (const id of ids)
    await writeFile(
      path.join(project, `${id}.jsonl`),
      [
        {
          type: 'user',
          sessionId: id,
          timestamp: new Date(at).toISOString(),
          cwd: '/tmp/demo',
          message: { role: 'user', content: '작업해 줘' },
        },
        {
          type: 'assistant',
          sessionId: id,
          timestamp: new Date(at + 1000).toISOString(),
          message: {
            id: `m-${id}`,
            role: 'assistant',
            content: [{ type: 'text', text: '끝났어요' }],
            stop_reason: 'end_turn',
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
  return temp;
}

function open(temp: string) {
  const service = new OfficeService(path.join(temp, 'data'), temp);
  service.roots.claude = path.join(temp, 'claude', 'projects');
  service.store.preferences({ enabledProviders: ['claude'] });
  return service;
}

test('pin and hide survive closing and reopening the app', async () => {
  const temp = await claudeHome([
    'aaaa1111-0000-0000-0000-000000000001',
    'bbbb2222-0000-0000-0000-000000000002',
  ]);
  try {
    let service = open(temp);
    let snapshot = (await service.refresh()) as Snapshot;
    const [a, b] = snapshot.sessions.map((s) => s.id);
    await service.call('patch', [a, { pinned: true }]);
    await service.call('veil', [[b], true]);
    service.stop();

    service = open(temp);
    snapshot = (await service.refresh()) as Snapshot;
    const get = (id: string) => snapshot.sessions.find((s) => s.id === id)!;
    assert.equal(get(a).pinned, true);
    assert.ok(get(b).hiddenAt);
    const model = buildOfficeModel(snapshot, Date.now());
    assert.ok(model.hiddenSessionIds.includes(b));
    assert.ok(!model.scene.some((s) => s.id === b), 'still hidden after reopening');
    service.stop();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('a persona colleague stays pinned when another of its runs speaks for it', () => {
  const now = Date.now();
  const run = (id: string, patch: Partial<Session>): Session => ({
    ...demoSnapshot().sessions[0],
    id,
    nativeId: id,
    provider: 'openclaw',
    status: 'idle',
    updatedAt: now - 10 * 3600_000,
    startedAt: now - 11 * 3600_000,
    events: [],
    activity: undefined,
    runtime: undefined,
    archived: false,
    pinned: false,
    zone: 'waiting',
    relation: { kind: 'root', parentNativeId: null, source: 'fixture' },
    actor: { id: 'openclaw:aki', name: 'aki', source: 'fixture' },
    ...patch,
  });
  // The older run was pinned; a newer run that is calling for the person now speaks for the
  // colleague. The pin must not vanish with that switch.
  const [colleague] = officeResidents(
    [
      run('old', { pinned: true, zone: 'office' }),
      run('new', { status: 'call', updatedAt: now - 60_000, zone: 'office' }),
    ],
    now,
  ).sessions;
  assert.equal(colleague.id, 'new');
  assert.equal(colleague.pinned, true);
});

test('the store waits out another instance holding the database at startup', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-locked-'));
  try {
    new OfficeStore(dir).close();
    const file = path.join(dir, 'office.sqlite');
    // Another process takes the write lock for ~4s (longer than SQLite's own 3s busy wait).
    const holder = spawn(
      process.execPath,
      [
        '--no-warnings',
        '-e',
        `const { DatabaseSync } = require('node:sqlite');
         const db = new DatabaseSync(${JSON.stringify(file)});
         db.exec('BEGIN EXCLUSIVE');
         process.stdout.write('locked\\n');
         setTimeout(() => { db.exec('COMMIT'); db.close(); }, 4000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await new Promise<void>((resolve) => holder.stdout!.once('data', () => resolve()));
    const started = Date.now();
    const store = new OfficeStore(dir);
    assert.ok(Date.now() - started >= 2500, 'it waited for the lock');
    assert.equal(store.preferences().paused, false);
    store.close();
    await new Promise((resolve) => holder.once('exit', resolve));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a stopped collector starts again on the next call', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-bridge-'));
  try {
    // First start fails (as with a locked database); the restarted one answers.
    const worker = path.join(dir, 'worker.mjs');
    const flag = path.join(dir, 'started-once');
    await writeFile(
      worker,
      `import { parentPort } from 'node:worker_threads';
       import { existsSync, writeFileSync } from 'node:fs';
       if (!existsSync(${JSON.stringify(flag)})) {
         writeFileSync(${JSON.stringify(flag)}, '1');
         throw new Error('database is locked');
       }
       parentPort.on('message', ({ id, method }) => parentPort.postMessage({ id, result: method }));`,
    );
    const bridge = new ServiceBridge(worker);
    const failed = await new Promise<string>((resolve) => bridge.once('failure', resolve));
    assert.match(failed, /database is locked/);
    assert.equal(bridge.dead, true);
    assert.equal(await bridge.call('refresh'), 'refresh');
    assert.equal(bridge.dead, false);
    await bridge.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
