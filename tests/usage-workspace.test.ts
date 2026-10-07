import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { QuotaService, normalizeQuota, codexUsage } from '../server/quotas.js';
import { parseRecords } from '../server/adapters/normalize.js';
import { toolLocation, wrappedLocations } from '../server/adapters/working-location.js';
import { OfficeStore } from '../server/store.js';
import { enrichWorkspaces } from '../server/workspaces.js';
import { entryCost } from '../server/pricing.js';
import { branchInfo } from '../src/shared/branch.js';
import { focusLevel } from '../src/shared/presentation.js';
import { demoSnapshot } from '../src/lib/demo.js';
import { setLocale } from '../src/shared/i18n/index.js';
// These tests assert the original Korean copy: pin the language so results never depend on the
// machine (services resolve `auto` through AGENT_OFFICE_LOCALE first).
process.env.AGENT_OFFICE_LOCALE = 'ko';
setLocale('ko');
const now = Date.now();
const parse = (raw: any[], provider: 'claude' | 'codex' = 'claude', partial = false) =>
  parseRecords(raw, { provider, sourcePath: '/fixture/session.jsonl', mtime: now, now, partial });
const message = (output: number, id = 'm1') => ({
  type: 'assistant',
  sessionId: 'work',
  timestamp: new Date(now).toISOString(),
  message: {
    id,
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: '테스트 작업' }],
    usage: {
      input_tokens: 100,
      output_tokens: output,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_1h_input_tokens: 20 },
    },
  },
});

test('Quota uses durations rather than primary=5h; preserves null and zero, all buckets, no invented windows', () => {
  assert.deepEqual(
    normalizeQuota('codex', {
      rateLimits: { primary: { usedPercent: 29, windowDurationMins: 10080, resetsAt: 1791599572 } },
    }).map((w) => [w.label, w.usedPercent, w.resetsAt]),
    [['일주일', 29, 1791599572000]],
  );
  assert.equal(
    normalizeQuota('codex', {
      rateLimitsByLimitId: {
        a: { primary: { usedPercent: 0, windowDurationMins: 300 } },
        b: { secondary: { usedPercent: 51, windowDurationMins: 60 } },
      },
      rateLimits: { primary: { usedPercent: 99 } },
    }).length,
    2,
  );
  assert.deepEqual(
    normalizeQuota('claude', { five_hour: { utilization: null }, seven_day: { utilization: NaN } }),
    [],
  );
  assert.equal(normalizeQuota('claude', { five_hour: { utilization: 0 } })[0].resetsAt, null);
  assert.equal(normalizeQuota('claude', { seven_day: { utilization: 101 } })[0].usedPercent, 100);
});
test('Quota is lazy, deduplicates concurrent requests, caches failures without exposing error content', async () => {
  let count = 0;
  const q = new QuotaService({
    codex: async () => {
      count++;
      return { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } } };
    },
    claude: async () => {
      throw new Error('secret-fixture');
    },
  });
  assert.equal(count, 0);
  await Promise.all([q.read('codex'), q.read('codex')]);
  await q.read('codex');
  assert.equal(count, 1);
  const failed = await q.read('claude');
  assert.equal(failed.state, 'error');
  assert.equal(JSON.stringify(failed).includes('secret-fixture'), false);
  assert.equal((await q.read('openclaw')).state, 'unavailable');
});
test('Codex probe initializes, reads only rate limits, and terminates its child', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-probe-'));
  try {
    const script = path.join(dir, 'fake-codex');
    await writeFile(
      script,
      `#!${process.execPath}\nlet b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));else if(m.method==='account/rateLimits/read')console.log(JSON.stringify({id:m.id,result:{rateLimits:{primary:{usedPercent:12,windowDurationMins:300}}}}));else if(m.method!=='initialized')process.exit(3);}});`,
      { mode: 0o700 },
    );
    const result: any = await codexUsage(script, 2000);
    assert.equal(result.rateLimits.primary.usedPercent, 12);
    await writeFile(
      script,
      `#!${process.execPath}\nprocess.stdin.resume();setInterval(()=>{},1000);`,
      { mode: 0o700 },
    );
    await assert.rejects(codexUsage(script, 50), /초과/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('Cost ledger deduplicates streaming snapshots, partial rereads and restart; model prices never guessed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-cost-'));
  let store = new OfficeStore(dir);
  try {
    const first = parse([message(10)]);
    store.upsert([first], 'claude');
    const s = parse([message(10), message(30)]);
    assert.notEqual(s.revision, first.revision);
    assert.equal(s.usageEntries?.length, 1);
    assert.equal(s.usageEntries![0].cacheWrite, 30);
    const expected = entryCost(s.usageEntries![0]);
    store.upsert([s], 'claude');
    store.upsert([s], 'claude');
    assert.equal(store.get(s.id).cost?.usd, expected);
    assert.equal(store.get(s.id).usageEntries, undefined);
    const tail = parse([message(5)], 'claude', true);
    tail.revision += 'tail';
    store.upsert([tail], 'claude');
    assert.equal(store.get(s.id).cost?.usd, expected);
    store.close();
    store = new OfficeStore(dir);
    const next = parse([message(20, 'm2')], 'claude', true);
    next.revision += 'next';
    store.upsert([next], 'claude');
    assert.equal(store.get(s.id).cost?.priced, 2);
    const unknown = { ...s.usageEntries![0], model: 'gpt-unknown' };
    assert.equal(entryCost(unknown), null);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('Codex native response usage wins over duplicate token_count; input cache is not double billed', () => {
  const records: any[] = [
    { type: 'session_meta', payload: { id: 'c' } },
    { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
  ];
  const usage = {
    input_tokens: 1000,
    cached_input_tokens: 800,
    cache_write_input_tokens: 50,
    output_tokens: 20,
    total_tokens: 1020,
  };
  records.push(
    {
      type: 'token_usage_record',
      payload: { response_id: 'r1', usage, thread_token_usage: usage },
    },
    {
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
    },
  );
  const s = parse(records, 'codex');
  assert.equal(s.usageEntries?.length, 1);
  assert.equal(s.usageEntries![0].input, 150);
  assert.ok(entryCost(s.usageEntries![0])! > 0);
});
test('Explicit execution location works across providers and wrapped calls, not file reads, dynamic expressions or prose', () => {
  assert.equal(
    toolLocation('Bash', { command: "cd '/tmp/repo work' && npm test" }, now)?.path,
    '/tmp/repo work',
  );
  assert.equal(toolLocation('Read', { file_path: '/tmp/repo/a.ts' }, now), undefined);
  assert.equal(toolLocation('exec_command', { cmd: 'cat /tmp/repo/a.ts' }, now), undefined);
  assert.equal(toolLocation('exec_command', { workdir: 'relative' }, now), undefined);
  assert.equal(
    wrappedLocations('await tools.exec_command({cmd: "npm test", workdir: "/tmp/repo"});', now)[0]
      ?.path,
    '/tmp/repo',
  );
  assert.deepEqual(wrappedLocations('await tools.exec_command({workdir: dir});', now), []);
  assert.deepEqual(
    wrappedLocations(
      'await Promise.all([tools.exec_command({workdir:"/a"}),tools.exec_command({workdir:"/b"})]);',
      now,
    ),
    [],
  );
  const s = parse(
    [
      { type: 'session_meta', payload: { id: 'c', cwd: '/tmp/base' } },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'functions.exec_command',
          arguments: '{"workdir":"/tmp/work"}',
        },
      },
    ],
    'codex',
  );
  assert.equal(s.cwd, '/tmp/base');
  assert.equal(s.workingLocation?.path, '/tmp/work');
});
test('Verified worktree follows actual Git branch while original cwd and recorded branch remain intact', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-worktrees-'));
  const repo = path.join(dir, 'repo'),
    wt = path.join(dir, 'branch');
  try {
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'init',
    ]);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-qb', 'feature/demo', wt]);
    const s = {
      ...demoSnapshot().sessions[0],
      cwd: repo,
      branch: 'main',
      workingLocation: { path: wt, at: now, source: 'tool-workdir' as const },
    };
    const [enriched] = await enrichWorkspaces([s]);
    assert.equal(enriched.cwd, repo);
    assert.equal(enriched.branch, 'main');
    assert.equal(enriched.workspace?.worktree, await realpath(wt));
    assert.equal(branchInfo(enriched).label, 'feature/demo · 작업');
    assert.equal(
      branchInfo({
        ...enriched,
        workspace: {
          ...enriched.workspace!,
          git: { branch: null, commit: '0123456789', state: 'detached', observedAt: now },
        },
      }).label,
      'HEAD · 0123456 · 작업',
    );
    const [invalid] = await enrichWorkspaces([
      { ...s, workingLocation: { ...s.workingLocation, path: '/missing-office-fixture' } },
    ]);
    assert.equal(branchInfo(invalid).label, 'main');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('Focus follows known current request and live work, never session lifetime, stale logs, or completion', () => {
  const s = {
    ...demoSnapshot().sessions[0],
    status: 'work' as const,
    archived: false,
    updatedAt: now,
    taskStartedAt: now - 6 * 60_000,
    events: [],
  };
  assert.equal(focusLevel(s, now), 1);
  assert.equal(focusLevel({ ...s, taskStartedAt: now - 16 * 60_000 }, now), 2);
  assert.equal(focusLevel({ ...s, taskStartedAt: now - 31 * 60_000 }, now), 3);
  assert.equal(focusLevel({ ...s, status: 'done' }, now), 0);
  assert.equal(focusLevel({ ...s, updatedAt: now - 3 * 60_000 }, now), 0);
  assert.equal(
    focusLevel({ ...s, taskStartedAt: undefined, startedAt: now - 10 * 86400_000 }, now),
    0,
  );
});
