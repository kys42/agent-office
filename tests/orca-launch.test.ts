import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OrcaLaunch,
  orcaCreateArgs,
  orcaRefusal,
  shellWord,
  type OrcaLaunchDeps,
} from '../desktop/orca-launch.js';

const claude = {
  provider: 'claude' as const,
  nativeId: '4f1c2a3b-0000-4000-8000-000000000001',
  cwd: "/projects/a 'quoted' folder",
  title: '기능 담당',
  alias: '',
};
const codex = { ...claude, provider: 'codex' as const, nativeId: '01a15d10-2a38-75b3-af5d-e7e6b' };
const command = (args: string[]) => args.find((a) => a.startsWith('--command='))!.slice(10);

test('the Orca command resumes the conversation with single-quoted words', () => {
  const args = orcaCreateArgs(claude);
  assert.deepEqual(args, [
    'terminal',
    'create',
    "--worktree=path:/projects/a 'quoted' folder",
    '--title=기능 담당',
    `--command='claude' '--resume' '${claude.nativeId}'`,
    '--focus',
    '--json',
  ]);
  assert.equal(command(orcaCreateArgs(codex)), `'codex' 'resume' '${codex.nativeId}'`);
});

test('the skip-permissions setting adds each agent’s own flag (same as tmux)', () => {
  assert.equal(
    command(orcaCreateArgs({ ...claude, skipPermissions: true })),
    `'claude' '--dangerously-skip-permissions' '--resume' '${claude.nativeId}'`,
  );
  assert.equal(
    command(orcaCreateArgs({ ...codex, skipPermissions: true })),
    `'codex' 'resume' '--dangerously-bypass-approvals-and-sandbox' '${codex.nativeId}'`,
  );
});

test('the tab title prefers the personal alias and drops control characters', () => {
  const title = (s: object) =>
    orcaCreateArgs({ ...claude, ...s })
      .find((a) => a.startsWith('--title='))!
      .slice(8);
  assert.equal(title({ alias: '내 동료' }), '내 동료');
  assert.equal(title({ title: 'a\nb\u001b[31m' }), 'a b [31m');
  assert.equal(title({ title: '' }), 'claude 4f1c2a3b');
  assert.equal(title({ title: 'x'.repeat(200) }).length, 60);
});

test('anything that could change the shell command is refused, not escaped', () => {
  for (const word of ["it's", 'a b', '$(id)', '`id`', 'a;b', 'a|b', '', 'x\ny', '~', '*'])
    assert.throws(() => shellWord(word), word);
  assert.equal(shellWord('--resume'), "'--resume'");
  for (const nativeId of ["x'; rm -rf ~; '", '$(id)', '-rf', 'a b', 'a\nb', ''])
    assert.throws(() => orcaCreateArgs({ ...claude, nativeId }), nativeId);
  assert.throws(() => orcaCreateArgs({ ...claude, cwd: 'relative/path' }));
  assert.throws(() => orcaCreateArgs({ ...claude, cwd: '/a\nb' }));
  assert.throws(() => orcaCreateArgs({ ...claude, cwd: null }));
  assert.throws(() => orcaCreateArgs({ ...claude, provider: 'openclaw' }));
  assert.throws(() => orcaCreateArgs({ ...claude, remote: { label: 'x' } as never }));
  assert.throws(() => orcaCreateArgs(claude, 'linux'));
});

function fixture(options: { status?: unknown; create?: () => string; dir?: boolean } = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const deps: OrcaLaunchDeps = {
    platform: 'darwin',
    orca: () => '/bin/orca',
    directory: async () => options.dir ?? true,
    run: async (file, args) => {
      calls.push({ file, args });
      if (args[0] === 'status')
        return JSON.stringify(
          options.status ?? { ok: true, result: { runtime: { reachable: true } } },
        );
      if (args[1] === 'create')
        return options.create?.() ?? JSON.stringify({ ok: true, result: {} });
      throw new Error('unexpected');
    },
  };
  return { calls, launcher: new OrcaLaunch(deps) };
}

test('offered only when Orca answers and the folder exists; status never creates', async () => {
  const f = fixture();
  assert.deepEqual(await f.launcher.status(claude), {
    available: true,
    command: `'claude' '--resume' '${claude.nativeId}'`,
  });
  assert.equal(
    f.calls.some((c) => c.args.includes('create')),
    false,
  );
  assert.equal(
    (
      await fixture({
        status: { ok: true, result: { runtime: { reachable: false } } },
      }).launcher.status(claude)
    ).available,
    false,
  );
  assert.equal((await fixture({ dir: false }).launcher.status(claude)).available, false);
  assert.equal(
    (await fixture().launcher.status({ ...claude, provider: 'openclaw' })).available,
    false,
  );
  const missing = new OrcaLaunch({ ...fixtureDeps(), orca: () => 'orca' });
  assert.equal((await missing.status(claude)).available, false);
});
const fixtureDeps = (): OrcaLaunchDeps => ({
  platform: 'darwin',
  orca: () => '/bin/orca',
  directory: async () => true,
  run: async () => {
    throw new Error('should not run');
  },
});

test('cancelling the confirmation creates nothing; confirming creates one tab', async () => {
  const f = fixture();
  const cancelled = await f.launcher.start(claude, async () => false);
  assert.equal(cancelled.launched, false);
  assert.equal(
    f.calls.some((c) => c.args.includes('create')),
    false,
  );
  let asked: unknown;
  const done = await f.launcher.start(claude, async (info) => {
    asked = info;
    return true;
  });
  assert.equal(done.launched, true);
  assert.deepEqual(asked, {
    cwd: claude.cwd,
    command: `'claude' '--resume' '${claude.nativeId}'`,
    name: '기능 담당',
  });
  const creates = f.calls.filter((c) => c.args.includes('create'));
  assert.equal(creates.length, 1);
  assert.equal(creates[0].file, '/bin/orca');
});

test('an Orca refusal shows its reason and suggests tmux', async () => {
  const refusal = JSON.stringify({
    ok: false,
    error: {
      code: 'selector_not_found',
      message: 'selector_not_found',
      data: { nextSteps: ['No Orca workspace matched the worktree selector.'] },
    },
  });
  assert.equal(orcaRefusal(refusal), 'No Orca workspace matched the worktree selector.');
  assert.equal(orcaRefusal('not json'), '');
  const f = fixture({
    create: () => {
      throw Object.assign(new Error('exit 1'), { stdout: refusal });
    },
  });
  await assert.rejects(
    f.launcher.start(claude, async () => true),
    (e: Error) => e.message.includes('No Orca workspace matched') && e.message.includes('tmux'),
  );
  const g = fixture({ create: () => refusal });
  await assert.rejects(
    g.launcher.start(claude, async () => true),
    /tmux/,
  );
});

test('Orca not reachable at start: refused before asking', async () => {
  const f = fixture({ status: { ok: false } });
  let asked = false;
  await assert.rejects(
    f.launcher.start(claude, async () => (asked = true)),
    /Orca/,
  );
  assert.equal(asked, false);
});
