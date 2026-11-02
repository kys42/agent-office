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
  // Detached but roomy: an 80×24 default would scroll Claude's prompt box at 7 rows.
  const created = args.indexOf('new-session');
  assert.deepEqual(args.slice(created, created + 6), [
    'new-session',
    '-d',
    '-x',
    '200',
    '-y',
    '50',
  ]);
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
    // Claude's new conversation gets its id up front (`--session-id`); Codex picks its own.
    const at = args.indexOf('/bin/' + provider);
    const own = provider === 'claude' ? 2 : 0;
    if (own) assert.equal(args[at + 1], '--session-id');
    assert.equal(args[at + 1 + own], ';');
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

for (const provider of ['claude', 'codex'] as const)
  test(`${provider} starts with a literal optional first message only once`, async () => {
    const f = fixture();
    const prompt = '--help\nreview $(touch /tmp/not-run) `echo nope` ";';
    const fresh = summonSession(session.cwd, provider, 'Review', prompt);
    const empty = summonSession(session.cwd, provider, 'Review');
    assert.equal((await f.manager.status(fresh)).name, (await f.manager.status(empty)).name);
    await f.manager.start(fresh, async () => false);
    assert.equal(
      f.calls.some((x) => x.args.includes('new-session')),
      false,
    );
    await f.manager.start(fresh, async () => true);
    const args = f.calls.find((x) => x.args.includes('new-session'))!.args;
    const at = args.indexOf('--', args.indexOf('/bin/' + provider));
    assert.deepEqual(args.slice(at, at + 2), ['--', prompt.slice(0, -1) + '\\;']);
    await f.manager.start(summonSession(session.cwd, provider, 'Review', 'second'), async () => {
      throw new Error('Existing session must not restart or send another message');
    });
    assert.equal(f.calls.filter((x) => x.args.includes('new-session')).length, 1);
    assert.equal(
      f.calls.some((x) => x.args.includes('send-keys')),
      false,
    );
  });

test('first-message validation allows multiline Unicode, optional blank, rejects controls and oversized IPC', () => {
  for (const bad of [null, 123, 'x'.repeat(4001), 'hi\0there', '\x1b[31m'])
    assert.throws(() => summonSession(session.cwd, 'claude', 'Review', bad as string));
  assert.equal(summonSession(session.cwd, 'claude', 'Review', ' \n\t').initialMessage, undefined);
  assert.equal(
    summonSession(session.cwd, 'claude', 'Review', '안녕\n다음 줄').initialMessage,
    '안녕\n다음 줄',
  );
});
test('without permission prompts only when the person chose it: each agent its own flag, an option of Codex resume', async () => {
  for (const provider of ['claude', 'codex'] as const) {
    const off = fixture();
    await off.manager.start({ ...session, provider }, async () => true);
    const plain = off.calls.find((x) => x.args.includes('new-session'))!.args;
    assert.ok(
      !plain.some((a) => a.startsWith('--dangerously')),
      `${provider} stays prompted by default`,
    );
    const on = fixture();
    await on.manager.start({ ...session, provider, skipPermissions: true }, async () => true);
    const args = on.calls.find((x) => x.args.includes('new-session'))!.args;
    const at = args.indexOf('/bin/' + provider);
    assert.deepEqual(
      args.slice(at + 1, at + 4),
      provider === 'claude'
        ? ['--dangerously-skip-permissions', '--resume', session.nativeId]
        : ['resume', '--dangerously-bypass-approvals-and-sandbox', session.nativeId],
    );
    const fresh = fixture();
    await fresh.manager.start(
      { ...summonSession(session.cwd, provider, undefined, 'hello;'), skipPermissions: true },
      async () => true,
    );
    const summoned = fresh.calls.find((x) => x.args.includes('new-session'))!.args;
    const from = summoned.indexOf('/bin/' + provider);
    const until = summoned.indexOf(';', from);
    const agentArgs = summoned.slice(from + 1, until);
    assert.deepEqual(
      agentArgs.filter((_, i) => agentArgs[i - 1] !== '--session-id'),
      provider === 'claude'
        ? ['--dangerously-skip-permissions', '--session-id', '--', 'hello\\;']
        : ['--dangerously-bypass-approvals-and-sandbox', '--', 'hello\\;'],
    );
  }
});
test('an agent that exits right after tmux started it is told apart from tmux failing', async () => {
  const { m } = await import('../src/shared/i18n/index.js');
  // tmux created the session, but it is gone at once: the agent itself ended (login, trust).
  const exited = fixture();
  exited.deps.run = async (_file, args) => {
    exited.calls.push({ file: _file, args });
    return '';
  };
  await assert.rejects(
    new TmuxResume(exited.deps).start(session, async () => true),
    {
      message: m().tmux.exitedAtStart,
    },
  );
  // tmux itself refused the command: the install hint.
  const broken = fixture();
  broken.deps.run = async (_file, args) => {
    if (args.includes('new-session')) throw new Error('tmux: unknown option');
    return '';
  };
  await assert.rejects(
    new TmuxResume(broken.deps).start(session, async () => true),
    {
      message: m().tmux.failed,
    },
  );
  // Started and still running: no error at all.
  const fine = fixture();
  assert.equal((await fine.manager.start(session, async () => true)).running, true);
});
test("own panes: the running session's server socket and live panes, for matching a verified terminal", async () => {
  const f = fixture();
  assert.equal(await f.manager.ownPanes(session), null, 'not running: no own session');
  await f.manager.start(session, async () => true);
  const run = f.deps.run;
  f.deps.run = async (file, args) =>
    args.includes('#{socket_path}\t#{pane_id}\t#{pane_dead}')
      ? '/tmp/tmux-501/test-office\t%1\t0\n/tmp/tmux-501/test-office\t%2\t1'
      : run(file, args);
  assert.deepEqual(await new TmuxResume(f.deps).ownPanes(session), {
    at: { socket: '/tmp/tmux-501/test-office', panes: ['%1'] },
  });
  // Panes that cannot be listed: alive, but nothing to match a terminal to.
  f.deps.run = async (file, args) => {
    if (args.includes('#{socket_path}\t#{pane_id}\t#{pane_dead}')) throw new Error('no server');
    return run(file, args);
  };
  assert.deepEqual(await new TmuxResume(f.deps).ownPanes(session), { at: null });
});
