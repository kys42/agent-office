import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TmuxResume, summonSession, type ResumeDeps } from '../desktop/tmux-resume.js';
const session = {
  provider: 'claude' as const,
  nativeId: '12345678-abcd',
  cwd: "/projects/a 'quoted' folder",
};
function fixture() {
  const calls: { file: string; args: string[] }[] = [];
  let row = '';
  const deps: ResumeDeps = {
    platform: 'darwin',
    server: 'test-office',
    binary: async (name) => '/bin/' + name,
    directory: async () => true,
    run: async (file, args) => {
      calls.push({ file, args });
      if (args.includes('list-sessions')) return row;
      if (args.includes('list-panes')) return '%1\t0';
      if (args.includes('new-session')) row = args[args.indexOf('-s') + 1] + '\t' + args.at(-1);
      return '';
    },
  };
  return {
    calls,
    deps,
    manager: new TmuxResume(deps),
    setRow: (s: string) => {
      row = s;
    },
  };
}
test('status is read-only; cancellation never launches and the same name survives reopening', async () => {
  const f = fixture();
  const info = await f.manager.status(session);
  assert.equal(info.running, false);
  assert.deepEqual(await f.manager.start(session, async () => false), info);
  assert.equal(
    f.calls.some((x) => x.args.includes('new-session')),
    false,
  );
  assert.equal((await new TmuxResume(f.deps).status(session)).name, info.name);
});
test('concurrent starts ask once, reuse one owned session, pass literal cwd and native resume arguments', async () => {
  const f = fixture();
  let confirms = 0;
  const results = await Promise.all(
    [1, 2, 3].map(() =>
      f.manager.start(session, async () => {
        confirms++;
        return true;
      }),
    ),
  );
  assert.equal(confirms, 1);
  assert.ok(results.every((x) => x.running));
  const launches = f.calls.filter((x) => x.args.includes('new-session'));
  assert.equal(launches.length, 1);
  assert.equal(launches[0].args[launches[0].args.indexOf('-c') + 1], session.cwd);
  assert.ok(launches[0].args.includes('--resume'));
  assert.ok(launches[0].args.includes(session.nativeId));
  assert.match(results[0].command, /attach-session -t '=office-claude-/);
  await f.manager.open(session);
  assert.equal(f.calls.at(-1)?.file, '/usr/bin/osascript');
  assert.equal(f.calls.at(-1)?.args.at(-1), results[0].command);
});
test('Codex resumes an explicit existing conversation without a prompt or bypass flags', async () => {
  const f = fixture();
  await f.manager.start({ ...session, provider: 'codex' }, async () => true);
  const args = f.calls.find((x) => x.args.includes('new-session'))!.args;
  const at = args.indexOf('/bin/codex');
  assert.deepEqual(args.slice(at + 1, at + 3), ['resume', session.nativeId]);
});
test('unowned name collision and unreadable inventory refuse creation', async () => {
  const f = fixture();
  const info = await f.manager.status(session);
  f.setRow(info.name + '\tother');
  await assert.rejects(f.manager.start(session, async () => true));
  f.deps.run = async () => {
    throw new Error('permission denied');
  };
  await assert.rejects(f.manager.start(session, async () => true));
  assert.equal(
    f.calls.some((x) => x.args.includes('new-session')),
    false,
  );
});
test('missing server permits a start, missing CLI or folder and malformed sessions do not', async () => {
  const f = fixture();
  f.deps.run = async () => {
    throw new Error('no server running on socket');
  };
  assert.equal((await f.manager.status(session)).running, false);
  f.deps.directory = async () => false;
  await assert.rejects(
    f.manager.start(session, async () => {
      throw new Error('must not ask');
    }),
  );
  f.deps.directory = async () => true;
  f.deps.binary = async () => {
    throw new Error('missing');
  };
  await assert.rejects(f.manager.start(session, async () => true));
  for (const invalid of [
    { ...session, nativeId: '--last' },
    { ...session, nativeId: 'id;echo' },
    { ...session, cwd: 'relative' },
    { ...session, provider: 'openclaw' as const },
  ])
    await assert.rejects(f.manager.status(invalid));
});
test('a directory disappearing during confirmation aborts', async () => {
  const f = fixture();
  await assert.rejects(
    f.manager.start(session, async () => {
      f.deps.directory = async () => false;
      return true;
    }),
  );
  assert.equal(
    f.calls.some((x) => x.args.includes('new-session')),
    false,
  );
});
test('opening an ended session never launches an agent, Linux offers copying only', async () => {
  const f = fixture();
  await assert.rejects(f.manager.open(session));
  f.deps.platform = 'linux';
  assert.equal((await f.manager.status(session)).canOpen, false);
  f.deps.platform = 'win32';
  await assert.rejects(f.manager.status(session));
  assert.equal(
    f.calls.some((x) => x.args.includes('new-session')),
    false,
  );
});

test('an owned dead pane is offered for resumption without killing a live process', async () => {
  const f = fixture();
  await f.manager.start(session, async () => true);
  const run = f.deps.run;
  let dead = true;
  f.deps.run = async (file, args, options) => {
    if (args.includes('list-panes')) return `%1\t${dead ? '1' : '0'}`;
    if (args.includes('respawn-pane')) {
      assert.ok(!args.includes('-k'));
      dead = false;
    }
    return run(file, args, options);
  };
  assert.equal((await f.manager.status(session)).running, false);
  const result = await f.manager.start(session, async () => true);
  assert.equal(result.running, true);
  assert.equal(f.calls.filter((x) => x.args.includes('new-session')).length, 1);
  assert.equal(f.calls.filter((x) => x.args.includes('respawn-pane')).length, 1);
});

test('summoning starts a fresh CLI once and rediscovers it by project/provider', async () => {
  for (const provider of ['claude', 'codex'] as const) {
    const f = fixture();
    const fresh = summonSession(session.cwd, provider);
    const before = await f.manager.status(fresh);
    assert.notEqual(before.name, (await f.manager.status({ ...session, provider })).name);
    assert.notEqual(before.name, (await f.manager.status(summonSession('/other', provider))).name);
    let confirms = 0;
    await Promise.all(
      [1, 2].map(() =>
        f.manager.start(fresh, async () => {
          confirms++;
          return true;
        }),
      ),
    );
    assert.equal(confirms, 1);
    const launches = f.calls.filter((x) => x.args.includes('new-session'));
    assert.equal(launches.length, 1);
    const args = launches[0].args;
    assert.equal(args[args.indexOf('/bin/' + provider) + 1], ';');
    assert.ok(!args.includes('resume') && !args.includes('--resume'));
    assert.equal(
      (await new TmuxResume(f.deps).status(summonSession(session.cwd, provider))).running,
      true,
    );
    f.setRow('');
    await f.manager.start(fresh, async () => true);
    assert.equal(f.calls.filter((x) => x.args.includes('new-session')).length, 2);
  }
});

test('named summons accept Korean names, separate names and reject unsafe or empty names', async () => {
  const f = fixture();
  const one = summonSession(session.cwd, 'claude', '리뷰 봇');
  const a = await f.manager.status(one);
  assert.match(a.name, /^리뷰-봇-claude-[a-f0-9]{8}$/);
  assert.notEqual(
    a.name,
    (await f.manager.status(summonSession(session.cwd, 'claude', '개발 봇'))).name,
  );
  for (const bad of ['', ' ', 'x:y', 'x.y', '-$(touch x)', 'x\nmalicious', 'a'.repeat(41)])
    assert.throws(() => summonSession(session.cwd, 'codex', bad));
  await f.manager.start(one, async () => true);
  assert.equal((await new TmuxResume(f.deps).status(one)).running, true);
});
test('alias adoption requires the exact tmux server and valid owned metadata; claimed names stay cleared', async () => {
  const f = fixture();
  const alias = Buffer.from('리뷰 봇').toString('base64');
  let claimed = '';
  f.deps.run = async (_file, args) => {
    if (args.includes('display-message'))
      return ['/tmp/owned', 'a'.repeat(64), alias, claimed].join('\t');
    if (args.includes('set-option')) claimed = args.at(-1)!;
    return '';
  };
  const host = { kind: 'tmux' as const, socket: '/tmp/owned', pane: '%1', label: 'test' };
  assert.equal(await f.manager.aliasFor({ ...host, socket: '/tmp/other' }, 'codex:123'), null);
  assert.equal(await f.manager.aliasFor(host, 'codex:123'), '리뷰 봇');
  await f.manager.claimAlias(host, 'codex:123');
  assert.equal(await f.manager.aliasFor(host, 'codex:123'), null);
});
