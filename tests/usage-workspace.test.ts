import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { QuotaService, normalizeQuota, codexUsage } from '../server/quotas.js';
import { parseRecords } from '../server/adapters/normalize.js';
import {
  admissible,
  editLocation,
  isSupportFolder,
  toolLocation,
  wrappedLocations,
} from '../server/adapters/working-location.js';
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
test('A desk moves only on work evidence: edits, Git writes and PRs — never a look-around cd, a read, dynamic code or prose', () => {
  const where = (name: string, args: unknown, start?: string) =>
    toolLocation(name, args, now, start)?.path;
  const at = (command: string, start = '/work/repo') => where('Bash', { command }, start);
  // Looking around is not working there.
  assert.equal(at("cd '/work/repo b' && npm test"), undefined);
  assert.equal(
    where('exec_command', { workdir: '/work/repo', cmd: 'git log --oneline' }),
    undefined,
  );
  assert.equal(where('exec_command', { cmd: 'cat /work/repo/a.ts' }), undefined);
  assert.equal(toolLocation('Read', { file_path: '/work/repo/a.ts' }, now), undefined);
  // Git and PR writes report where they ran.
  assert.equal(at("cd '/work/repo b' && git commit -qm x"), '/work/repo b');
  assert.equal(
    where('exec_command', { workdir: '/work/wt', cmd: 'git push -u origin x' }),
    '/work/wt',
  );
  assert.equal(at('git -C /work/other commit -m x'), '/work/other');
  assert.equal(at('git switch -c feat/x'), '/work/repo');
  assert.equal(at('git checkout main'), undefined, 'not a new branch');
  assert.equal(at('cd /work/repo && gh pr create --base main'), '/work/repo');
  assert.equal(at('rtk proxy git commit -m x'), '/work/repo');
  assert.equal(
    at('git worktree add ../feature-x -b feature/x', '/work/main'),
    '/work/feature-x',
    'a new worktree is where the work goes next',
  );
  assert.equal(at('git worktree add --reason wip ../wt', '/work/main'), '/work/wt');
  assert.equal(where('exec_command', { workdir: 'relative', cmd: 'git commit' }), undefined);
  assert.equal(at('cd $DIR && git commit'), undefined);
  // Asking changes nothing.
  assert.equal(at('git -C /work/other push --dry-run'), undefined);
  assert.equal(at('git push -n'), undefined);
  assert.equal(at('git -C /work/other commit --help'), undefined);
  assert.equal(at('git -C /work/other --help commit'), undefined);
  // Escaped heredoc tags are read; an unreadable heredoc makes the whole line unknown.
  assert.equal(at('cat <<\\EOF\ncd /work/other\ngit push\nEOF'), undefined);
  assert.equal(at('cat <<\\EOF\nnotes\nEOF\ngit push'), '/work/repo');
  assert.equal(at('cat <<<"x"; git push'), '/work/repo', 'a here-string is not a heredoc');
  assert.equal(at('cat <<<"x"\ngit -C /work/other push'), '/work/other');
  // Attached and combined options.
  assert.equal(at('git -C/work/other commit -m x'), '/work/other');
  assert.equal(at('git worktree add -qb feature /work/wt', '/work/base'), '/work/wt');
  // A PR in another named repository isn't this folder's work.
  assert.equal(at('gh pr merge https://github.com/other/repo/pull/123'), undefined);
  assert.equal(at('gh pr create --repo owner/other --title x'), undefined);
  // A repository set earlier in the line (export, bare assignment) points Git elsewhere.
  assert.equal(at('export GIT_DIR=/work/other/.git; git push'), undefined);
  assert.equal(at('GIT_WORK_TREE=/work/other; git commit -m x'), undefined);
  // After `||` a command runs only on failure: no write is claimed, a cd makes the place unknown.
  assert.equal(at('cd /work/other || git push'), undefined);
  assert.equal(at('cd /x || cd /work/other && git push'), undefined);
  assert.equal(at('git push || echo failed'), '/work/repo');
  assert.equal(at('false || true; git push'), '/work/repo', 'a new list starts fresh');
  // Quoted text, heredocs, substitutions, pipelines, comments and background lists.
  assert.equal(at('git commit -m "notes\ncd /work/other\ngit push"'), '/work/repo');
  assert.equal(at("cat <<'EOF' > plan.md\ncd /work/other\ngit push\nEOF\nls"), undefined);
  assert.equal(at('python3 - <<EOF\nprint("git commit")\nEOF\ngit push'), '/work/repo');
  assert.equal(at("echo 'a; git push'"), undefined);
  assert.equal(at('echo $(pwd; cd /work/other; pwd); git push'), '/work/repo');
  assert.equal(at('echo `cd /work/other`; git push'), '/work/repo');
  assert.equal(at('echo "$(pwd)"; cd /work/other; git push'), '/work/other');
  assert.equal(at('cd /work/other | cat; git push'), '/work/repo');
  assert.equal(at('# e.g. cd /work/other; git push\ngit status'), undefined);
  assert.equal(at('git status # then git push'), undefined);
  assert.equal(
    at('cd /work/other && npm run dev & git push'),
    '/work/repo',
    'a background cd stays there',
  );
  assert.equal(at('cd /work/other && git push &'), '/work/other', 'the background push ran there');
  assert.equal(
    at('git commit -m "$(cat <<\'EOF\'\nfix: x\ncd /work/other\nEOF\n)" && git push'),
    '/work/repo',
  );
  // cd options; repository overrides this doesn't follow claim nothing, whatever their order.
  assert.equal(at('cd -- /work/other && git commit -m x'), '/work/other');
  assert.equal(at('cd -P /work/other && git commit -m x'), '/work/other');
  assert.equal(at('git --git-dir=/work/other/.git --work-tree=/work/other commit -m x'), undefined);
  assert.equal(at('GIT_DIR=/work/other/.git git commit -m x'), undefined);
  assert.equal(
    at('GIT_DIR=/r/.git GIT_WORK_TREE=/r git commit -m x'),
    undefined,
    'and it terminates',
  );
  assert.equal(at('GIT_DIR=/work/other/.git git -C /work/base commit -m x'), undefined);
  assert.equal(at('git --git-dir /work/other/.git -C /work/base commit -m x'), undefined);
  // What runs inside control flow or a function body isn't certain: no write is claimed.
  assert.equal(at('if false; then\ncd /work/other\ngit push\nfi'), undefined);
  assert.equal(at('if true; then cd /work/other; fi; git push'), undefined);
  assert.equal(at('ship() { cd /work/other && git push; }'), undefined);
  assert.equal(at('(cd /work/other && git push)'), undefined);
  // An explicit workdir: relative ones read from the call's start, unreadable ones stay unknown.
  assert.equal(
    where('exec_command', { cmd: 'git push', workdir: '../other' }, '/work/base'),
    '/work/other',
  );
  assert.equal(
    where('exec_command', { cmd: 'git push', workdir: '$HOME/x' }, '/work/base'),
    undefined,
  );
  // Edits count where the file is (Claude tools; Codex apply_patch, relative to the cwd).
  assert.equal(
    editLocation('Edit', { file_path: '/work/repo/src/a.ts' }, undefined, now)?.path,
    '/work/repo/src',
  );
  assert.equal(
    editLocation('Read', { file_path: '/work/repo/src/a.ts' }, undefined, now),
    undefined,
  );
  assert.equal(
    editLocation(
      'apply_patch',
      '*** Begin Patch\n*** Update File: src/b.ts\n@@\n',
      '/work/repo',
      now,
    )?.path,
    '/work/repo/src',
  );
  assert.equal(
    editLocation(
      'apply_patch',
      JSON.stringify({ input: '*** Begin Patch\n*** Add File: /work/x/n.ts\n' }),
      undefined,
      now,
    )?.path,
    '/work/x',
    'function_call arguments arrive as JSON',
  );
  // Agent homes and temporary folders support the work; a session launched there may come home.
  const home = os.homedir();
  const memory = editLocation(
    'Write',
    { file_path: path.join(home, '.claude/projects/x/memory/a.md') },
    undefined,
    now,
  );
  assert.equal(admissible(memory, '/work/repo'), false);
  assert.equal(admissible(memory, path.join(home, '.claude')), true);
  assert.ok(isSupportFolder('/private/tmp/claude-501/s/scratchpad'));
  assert.ok(isSupportFolder('/tmp/x.py'));
  assert.ok(isSupportFolder(path.join(os.tmpdir(), 'x')));
  assert.ok(
    isSupportFolder('/work/agent-config/memo', home, { CLAUDE_CONFIG_DIR: '/work/agent-config' }),
  );
  assert.ok(!isSupportFolder('/work/.claude-notes'));
  // Wrapped Codex calls use the same evidence rule, starting in the turn's cwd.
  assert.equal(
    wrappedLocations('await tools.exec_command({cmd: "npm test", workdir: "/work/repo"});', now)[0],
    undefined,
  );
  assert.equal(
    wrappedLocations(
      'await tools.exec_command({cmd: "git commit -m x", workdir: "/work/repo"});',
      now,
    )[0]?.path,
    '/work/repo',
  );
  assert.equal(
    wrappedLocations('await tools.exec_command({cmd: "git push"});', now, '/work/base')[0]?.path,
    '/work/base',
  );
  assert.deepEqual(
    wrappedLocations('await tools.exec_command({workdir: dir, cmd: "git push"});', now),
    [],
  );
  assert.equal(
    wrappedLocations(
      'await tools.apply_patch(`*** Begin Patch\n*** Update File: src/c.ts\n`);',
      now,
      '/work/repo',
    )[0]?.path,
    '/work/repo/src',
  );
  // Parsed Codex sessions: a workdir alone stays at its start; a commit there moves it; a commit
  // back home after an edit elsewhere brings it home.
  const codex = (...items: object[]) =>
    parse(
      [
        { type: 'session_meta', payload: { id: 'c', cwd: '/work/base' } },
        ...items.map((payload) => ({ type: 'response_item', payload })),
      ],
      'codex',
    );
  const exec = (cmd: string, workdir?: string) => ({
    type: 'function_call',
    name: 'functions.exec_command',
    arguments: JSON.stringify({ cmd, ...(workdir ? { workdir } : {}) }),
  });
  assert.equal(codex(exec('npm test', '/work/wt')).workingLocation, undefined);
  assert.equal(codex(exec('git commit -m x', '/work/wt')).cwd, '/work/base');
  assert.equal(codex(exec('git commit -m x', '/work/wt')).workingLocation?.path, '/work/wt');
  assert.equal(
    codex(
      {
        type: 'custom_tool_call',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Update File: /work/other/a.ts\n',
      },
      exec('git commit -m x'),
    ).workingLocation?.path,
    '/work/base',
  );
});

test('Claude calls start where the record says, and a denied or failed call is no evidence', () => {
  const bash = (
    id: string,
    command: string,
    cwd = '/work/repo',
    result: object = { content: 'ok' },
  ) => [
    {
      type: 'assistant',
      uuid: `${id}-u`,
      cwd,
      timestamp: new Date(now).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
      },
    },
    {
      type: 'user',
      uuid: `${id}-r`,
      cwd,
      timestamp: new Date(now).toISOString(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, ...result }] },
    },
  ];
  const claude = (...records: object[][]) => parse(records.flat(), 'claude');
  // Claude Code writes the shell's current directory on each record: a cd that persisted…
  assert.equal(
    claude(bash('a', 'cd packages/app'), bash('b', 'git commit -m x', '/work/repo/packages/app'))
      .workingLocation?.path,
    '/work/repo/packages/app',
  );
  // …or one it put back (the record stays in the project).
  assert.equal(
    claude(bash('a', 'cd /work/elsewhere && ls'), bash('b', 'git commit -m x')).workingLocation
      ?.path,
    '/work/repo',
  );
  // A head + tail read still knows where each call started.
  assert.equal(
    parse(bash('b', 'git commit -m x').flat(), 'claude', true).workingLocation?.path,
    '/work/repo',
  );
  // Denied or failed calls ran nothing.
  assert.equal(
    claude(
      bash('a', 'cd /work/other && git push', '/work/repo', { content: 'denied', is_error: true }),
    ).workingLocation,
    undefined,
  );
  // A call still waiting for its result isn't evidence yet.
  assert.equal(parse([bash('a', 'git push')[0]], 'claude').workingLocation, undefined);
  // Looking around elsewhere leaves no location at all: the desk stays where the session started.
  assert.equal(
    claude(bash('a', `cd ${os.homedir()}/.claude/projects/x && grep -n foo a.jsonl`))
      .workingLocation,
    undefined,
  );
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

test('A partial reread keeps the last work evidence, never an old cd-based guess', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-location-'));
  const store = new OfficeStore(dir);
  try {
    const base = { ...parse([]), id: 'claude:loc', nativeId: 'loc', partial: false };
    const reread = {
      ...base,
      partial: true,
      windowed: true,
      workingLocation: undefined,
      revision: 'tail',
    };
    // Stored by the old rule (any cd): a tail without evidence drops it — back to the start path.
    store.upsert(
      [{ ...base, workingLocation: { path: '/work/.claude', at: now, source: 'shell-cd' } }],
      'claude',
    );
    store.upsert([reread], 'claude');
    assert.equal(store.get(base.id).workingLocation, undefined);
    // …also when the record itself didn't change since (same revision as the stored row).
    const legacy = {
      ...base,
      revision: 'same',
      workingLocation: { path: '/work/.claude', at: now, source: 'shell-cd' as const },
    };
    store.upsert([legacy], 'claude');
    assert.equal(store.get(base.id).workingLocation?.source, 'shell-cd');
    store.upsert([{ ...reread, revision: 'same' }], 'claude');
    assert.equal(store.get(base.id).workingLocation, undefined);
    // Real work evidence survives a tail that no longer shows it.
    const commit = { path: '/work/wt', at: now, source: 'git-write' as const };
    store.upsert([{ ...base, workingLocation: commit, revision: 'commit' }], 'claude');
    store.upsert([{ ...reread, revision: 'tail-2' }], 'claude');
    assert.deepEqual(store.get(base.id).workingLocation, commit);
    // A full read that merely has many events (partial, not windowed) and no evidence: home.
    store.upsert([{ ...reread, windowed: undefined, revision: 'full' }], 'claude');
    assert.equal(store.get(base.id).workingLocation, undefined);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
