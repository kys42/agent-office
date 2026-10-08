import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, utimes, rm, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficeService } from '../server/service.js';

/** #64: what the collector keeps stays bounded however long it runs. */
test('A long-running collector keeps only bounded, recent things in memory', async (t) => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-bounds-'));
  const project = path.join(temp, 'claude', 'projects', 'bounds');
  await mkdir(project, { recursive: true });
  const id = (i: number) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const file = (i: number) => path.join(project, `${id(i)}.jsonl`);
  let n = 0;
  const touch = async (i: number) => {
    const at = Date.now();
    await appendFile(
      file(i),
      JSON.stringify({
        type: 'user',
        sessionId: id(i),
        timestamp: new Date(at).toISOString(),
        cwd: '/tmp/b',
        message: { role: 'user', content: `요청 ${++n} ${'긴 출력 '.repeat(400)}` },
      }) + '\n',
    );
    await utimes(file(i), at / 1000, at / 1000);
  };
  for (let i = 0; i < 8; i++) {
    await writeFile(file(i), '');
    await touch(i);
  }
  const service = new OfficeService(path.join(temp, 'data'), temp);
  service.roots.claude = path.join(temp, 'claude', 'projects');
  service.store.preferences({ enabledProviders: ['claude'] });
  try {
    await service.refresh();
    for (let c = 0; c < 30; c++) {
      t.mock.timers.tick(5000);
      // Two sessions at work; the rest went quiet long ago.
      await touch(0);
      await touch(1);
      await service.refresh();
      assert.ok(service.windows.bytes <= service.windows.budgetBytes);
    }
    // Twenty minutes on, only the two still at work keep a window.
    t.mock.timers.tick(20 * 60_000);
    await touch(0);
    await touch(1);
    await service.refresh();
    assert.equal(service.windows.size, 2, 'windows only for the files still being written');
    assert.ok(service.windows.has(file(0)) && service.windows.has(file(1)));
    // Quiet for longer than the active window: their windows are let go too.
    t.mock.timers.tick(16 * 60_000);
    await service.refresh();
    assert.equal(service.windows.size, 0, 'no window for files that went quiet');
    // The office view keeps a few events per colleague, not the conversation.
    const resident = (service.store as unknown as { cached: Map<string, { events: unknown[] }> })
      .cached;
    for (const s of resident.values()) assert.ok(s.events.length <= 7);
    // The whole conversation is still one read away.
    const busy = service.snapshot().sessions.find((s) => s.nativeId === id(0))!;
    assert.ok(service.store.get(busy.id).events.length > 7);
  } finally {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  }
});

test('A pass that cannot read a hidden project keeps its records as stored', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-partial-'));
  const project = path.join(temp, 'claude', 'projects', 'hidden');
  await mkdir(project, { recursive: true });
  const ids = ['aaaa1111-0000-4000-8000-000000000001', 'bbbb2222-0000-4000-8000-000000000002'];
  for (const id of ids)
    await writeFile(
      path.join(project, `${id}.jsonl`),
      JSON.stringify({
        type: 'user',
        sessionId: id,
        timestamp: new Date().toISOString(),
        cwd: '/tmp/hidden-project',
        message: { role: 'user', content: '작업' },
      }) + '\n',
    );
  const service = new OfficeService(path.join(temp, 'data'), temp);
  service.roots.claude = path.join(temp, 'claude', 'projects');
  service.store.preferences({ enabledProviders: ['claude'] });
  try {
    await service.refresh();
    assert.equal(service.store.storedRecords('claude').length, 2);
    // The person hides the project; then one of its files cannot be read for a pass.
    service.store.preferences({ excludedProjects: ['hidden-project'] });
    const unreadable = path.join(project, `${ids[1]}.jsonl`);
    await appendFile(unreadable, '\n');
    await chmod(unreadable, 0o000);
    await service.refresh().finally(() => chmod(unreadable, 0o644));
    // Still both records, as collected (no personal settings mixed in).
    const kept = service.store.storedRecords('claude');
    assert.equal(kept.length, 2);
    assert.ok(kept.every((s) => s.officeSeat === undefined));
  } finally {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  }
});
