import { createServer } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OfficeManager, findExecutable, nextSummaryAt } from '../server/manager/controller.js';
import { officeAction } from '../server/manager/actions.js';
import { request } from '../server/manager/protocol.js';
import { providerArgs, runProvider } from '../server/manager/provider.js';
import { OfficeService } from '../server/service.js';
import { parseRecords } from '../server/adapters/normalize.js';
import { isManagerSession, MANAGER_ID, type ManagerState } from '../src/shared/manager.js';

test('Briefings compute future hourly and local daily times, including after the daily cutoff', () => {
  const now = new Date(2026, 9, 18, 9, 0, 0).getTime();
  assert.equal(nextSummaryAt({ kind: 'off' }, now), undefined);
  assert.equal(nextSummaryAt({ kind: 'hourly', hours: 3 }, now), now + 3 * 3600000);
  assert.equal(
    nextSummaryAt({ kind: 'daily', time: '09:00' }, now),
    new Date(2026, 9, 19, 9).getTime(),
  );
  assert.equal(
    nextSummaryAt({ kind: 'daily', time: '10:30' }, now),
    new Date(2026, 9, 18, 10, 30).getTime(),
  );
});
test('Provider resume targets the manager ID, never the most recent user session', () => {
  for (const provider of ['codex', 'claude'] as const) {
    const args = providerArgs(provider, 'dedicated-id');
    assert.ok(args.includes('dedicated-id'));
    assert.ok(!args.includes('--last') && !args.includes('--continue'));
    assert.ok(!args.some((a) => a.includes('bypass')));
  }
});
test('Office actions preserve unrelated zone rules and enforce exclusions and summary read-only access', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-manager-actions-'));
  const service = new OfficeService(path.join(dir, 'data'), dir);
  try {
    const a = parseRecords(
      [{ type: 'session_meta', payload: { id: 'manager-test', cwd: '/test/one' } }],
      { provider: 'codex', sourcePath: '/test/manager-test.jsonl', mtime: Date.now() },
    );
    const b = parseRecords(
      [{ type: 'session_meta', payload: { id: 'other-test', cwd: '/test/two' } }],
      { provider: 'codex', sourcePath: '/test/other-test.jsonl', mtime: Date.now() },
    );
    service.store.upsert([a, b], 'codex');
    await service.call('preferences', [
      { zoneRules: [{ id: 'other', name: 'Other area', match: 'session', value: b.id }] },
    ]);
    const office = {
      call: (method: string, args?: unknown[]) => service.call(method, args),
      focus: () => {},
    };
    await officeAction(office, 'move', { id: a.id, name: 'Frontend' }, false);
    assert.equal(service.store.preferences().zoneRules?.length, 2);
    assert.equal(
      service.store.preferences().zoneRules?.find((r) => r.value === b.id)?.name,
      'Other area',
    );
    assert.equal(
      (await officeAction(office, 'zones', {}, true)).find((z: any) => z.name === 'Frontend').count,
      1,
    );
    for (const command of ['move', 'return', 'pin', 'focus'])
      await assert.rejects(officeAction(office, command, { id: a.id }, true), /read-only/);
    await assert.rejects(
      officeAction(office, 'move', { id: a.id, zoneKey: 'missing' }, false),
      /no longer/,
    );
    await service.call('preferences', [{ excludedProjects: [a.project] }]);
    await assert.rejects(officeAction(office, 'detail', { id: a.id }, true));
    await assert.rejects(officeAction(office, 'move', { id: a.id, name: 'Hidden' }, false));
    const overview = await officeAction(office, 'overview', {}, true);
    assert.ok(!overview.sessions.some((s: any) => s.id === a.id));
  } finally {
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
async function eventually(manager: OfficeManager, predicate: (state: ManagerState) => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await manager.call({ action: 'status' });
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('Manager did not reach the expected state.');
}
test(
  'Dedicated tmux runner executes the CLI, resumes, denies stale credentials, and persists reports',
  { timeout: 30000 },
  async (t) => {
    const tmux = await findExecutable('tmux');
    if (!tmux) {
      t.skip('tmux is not installed');
      return;
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'office-manager-runner-'));
    const bundleDir = path.join(dir, 'bundle');
    const { build } = await import('esbuild');
    await build({
      entryPoints: {
        'manager-runner': 'server/manager/runner.ts',
        'manager-cli': 'server/manager/cli.ts',
      },
      outdir: bundleDir,
      outExtension: { '.js': '.cjs' },
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'cjs',
    });
    await copyFile(
      'skills/office-manager/SKILL.md',
      path.join(bundleDir, 'office-manager.SKILL.md'),
    );
    const fake = path.join(dir, 'codex');
    await writeFile(
      fake,
      `#!${process.execPath}\nconst fs = require('node:fs'); const cp = require('node:child_process');
let input='';process.stdin.on('data', c=>input+=c);process.stdin.on('end',()=>{
 const args=process.argv.slice(2); const id='dedicated-test';
 if(input.includes('WAIT_FOR_STOP')) { fs.writeFileSync(${JSON.stringify(path.join(dir, 'agent.pid'))}, String(process.pid)); console.log(JSON.stringify({type:'thread.started',thread_id:id})); setInterval(()=>{},1000); return; }
 const result=cp.execFileSync('./office',['overview','{}'],{encoding:'utf8'});
 fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.jsonl'))},JSON.stringify({args, result, input})+'\\n');
 console.log(JSON.stringify({type:'thread.started',thread_id:id}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Verified office: '+JSON.parse(result).sessions.length}}));
 console.log(JSON.stringify({type:'turn.completed'}));
});\n`,
      { mode: 0o700 },
    );
    let notifications = 0;
    const options = {
      dataDir: dir,
      bundleDir,
      node: process.execPath,
      executables: { tmux, codex: fake },
      office: {
        call: async () => ({ sessions: [], notices: [], connectors: [], lastSync: Date.now() }),
        focus: () => {},
      },
      notify: () => {
        notifications++;
      },
    };
    const manager = new OfficeManager(options);
    try {
      await manager.init();
      await manager.call({ action: 'start' });
      await eventually(manager, (s) => s.ready);
      await manager.call({ action: 'chat', text: 'Inspect the office' });
      let state = await eventually(manager, (s) => s.jobs[0]?.status === 'completed');
      assert.equal(state.sessionId, 'dedicated-test');
      assert.deepEqual(state.ownedSessionIds, ['codex:dedicated-test']);
      assert.equal(isManagerSession(MANAGER_ID, state), true);
      assert.equal(isManagerSession('codex:dedicated-test', state), true);
      assert.equal(isManagerSession('claude:dedicated-test', state), false);
      assert.equal(isManagerSession('codex:office-manager', state), false);
      assert.equal(state.jobs[0].answer, 'Verified office: 0');
      const old = JSON.parse(
        await readFile(path.join(dir, 'manager/workspace/.office-connection.json'), 'utf8'),
      );
      await assert.rejects(request(old, 'overview'), /not authorized/);
      const job = await manager.call({ action: 'summary' });
      assert.equal(job.jobs[1].kind, 'summary');
      state = await eventually(manager, (s) => s.jobs[1]?.status === 'completed');
      assert.equal(notifications, 1);
      assert.ok(state.lastSummaryAt);
      const calls = (await readFile(path.join(dir, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s));
      assert.ok(!calls[0].args.includes('resume'));
      assert.ok(calls[1].args.includes('resume') && calls[1].args.includes('dedicated-test'));
      assert.match(calls[1].input, /read-only briefing/);
      await manager.call({ action: 'chat', text: 'WAIT_FOR_STOP' });
      await eventually(manager, (s) => s.jobs[2]?.status === 'running');
      let pid = 0;
      for (let i = 0; i < 30; i++) {
        try {
          pid = Number(await readFile(path.join(dir, 'agent.pid'), 'utf8'));
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      assert.ok(pid > 0);
      await manager.call({ action: 'stop' });
      assert.equal(manager.state().running, false);
      let alive = true;
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(pid, 0);
          await new Promise((r) => setTimeout(r, 100));
        } catch {
          alive = false;
          break;
        }
      }
      assert.equal(alive, false, 'Stopping tmux must stop the active provider process too');
      assert.equal(manager.state().jobs[2].status, 'failed');
      await manager.close();
      const restored = new OfficeManager(options);
      await restored.init();
      assert.equal(restored.state().jobs.length, 3);
      assert.equal(restored.state().sessionId, 'dedicated-test');
      assert.deepEqual(restored.state().ownedSessionIds, ['codex:dedicated-test']);
      assert.equal(restored.state().running, false);
      await restored.close();
      const stateFile = path.join(dir, 'manager/state.json');
      const saved = JSON.parse(await readFile(stateFile, 'utf8'));
      saved.enabled = true;
      saved.nextRunAt = Date.now() - 86400000;
      saved.settings.schedule = { kind: 'hourly', hours: 1 };
      await writeFile(stateFile, JSON.stringify(saved));
      const scheduled = new OfficeManager(options);
      try {
        await scheduled.init();
        const caughtUp = await eventually(
          scheduled,
          (s) => s.jobs.length === 4 && s.jobs[3].status === 'completed',
        );
        assert.equal(caughtUp.jobs[3].kind, 'summary');
        assert.equal(caughtUp.jobs[3].since, saved.lastSummaryAt);
        assert.ok(caughtUp.nextRunAt! > Date.now());
        assert.equal(
          caughtUp.jobs[2].status,
          'failed',
          'Interrupted user work must not be replayed',
        );
      } finally {
        await scheduled.call({ action: 'stop' });
        await scheduled.close();
      }
    } finally {
      await manager.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test('Provider failures are failures even when a result message exists', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-manager-failure-'));
  try {
    const cli = path.join(dir, 'failed');
    await writeFile(
      cli,
      `#!${process.execPath}\nconsole.log(JSON.stringify({type:'result',is_error:true,result:'Login required'}));\n`,
      { mode: 0o700 },
    );
    await assert.rejects(
      runProvider({
        provider: 'claude',
        executable: cli,
        cwd: dir,
        prompt: 'hello',
        onSession: () => {},
      }),
      /Login required/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Office protocol preserves Korean and emoji across socket chunks', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ao-unicode-'));
  const socket = path.join(dir, 'rpc.sock');
  const expected = '매니저가 동료를 찾았어요 🧑‍💻';
  const server = createServer((client) => {
    client.once('data', () => {
      const bytes = Buffer.from(JSON.stringify({ result: expected }) + '\n');
      let i = 0;
      const timer = setInterval(() => {
        if (i < bytes.length) client.write(bytes.subarray(i, ++i));
        else {
          clearInterval(timer);
          client.end();
        }
      }, 1);
      client.on('close', () => clearInterval(timer));
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    assert.equal(await request({ socket, token: 'test' }, 'overview'), expected);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
