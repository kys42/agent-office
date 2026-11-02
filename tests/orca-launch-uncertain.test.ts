import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADOPT_LOOKS,
  OrcaLaunch,
  classifyOrcaCreate,
  orcaCreateArgs,
  type OrcaLaunchDeps,
} from '../desktop/orca-launch.js';
import { checkDuplicate } from '../desktop/launch-guard.js';
import { PendingLaunches } from '../desktop/pending-launch.js';
import { m } from '../src/shared/i18n/index.js';

/**
 * Orca made the tab but did not confirm its terminal in time (#317): never a refusal, looked
 * for after Orca comes forward, and kept pending so the same conversation is not started twice.
 * Every Orca call is a fake: nothing here creates, switches or types into a real terminal.
 */

delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
const CL = "'/usr/bin/env' '-u' 'CLAUDE_CONFIG_DIR' ";
const CX = "'/usr/bin/env' '-u' 'CODEX_HOME' ";
const claude = {
  provider: 'claude' as const,
  nativeId: '4f1c2a3b-0000-4000-8000-000000000001',
  cwd: "/projects/a 'quoted' folder",
  title: '기능 담당',
  alias: '',
};
const codex = { ...claude, provider: 'codex' as const, nativeId: '01a15d10-2a38-75b3-af5d-e7e6b' };
const command = (args: string[]) => args.find((a) => a.startsWith('--command='))!.slice(10);

const answer = (code: string, message = code) =>
  JSON.stringify({ ok: false, error: { code, message } });
const HANDLE_TIMEOUT = answer(
  'runtime_error',
  'Timed out waiting for terminal handle after creation',
);
const term = (handle: string, title = '', worktreePath = claude.cwd) => ({
  handle,
  title,
  worktreePath,
});
const listed = (...terminals: object[]) => ({ ok: true, result: { terminals } });

interface Call {
  file: string;
  args: string[];
  timeout?: number;
}

function fixture(
  options: {
    create?: () => string;
    /** `terminal list` answers, one per call (the last one repeats). */
    lists?: unknown[];
    /** `worktree show` for the folder; `worktree list` answers `worktrees`. */
    shown?: () => unknown;
    worktrees?: () => unknown[];
    binary?: (name: string) => Promise<string>;
    pending?: PendingLaunches;
    wait?: (ms: number) => Promise<void>;
  } = {},
) {
  const calls: Call[] = [];
  const lists = [...(options.lists ?? [listed()])];
  const deps: OrcaLaunchDeps = {
    platform: 'darwin',
    orca: () => '/bin/orca',
    directory: async () => true,
    binary: options.binary,
    pending: options.pending,
    wait: options.wait ?? (async () => {}),
    run: async (file, args, runOptions) => {
      calls.push({ file, args, timeout: runOptions?.timeout });
      if (file === '/usr/bin/open') return '';
      if (args[0] === 'status')
        return JSON.stringify({ ok: true, result: { runtime: { reachable: true } } });
      if (args[0] === 'worktree' && args[1] === 'show') {
        const shown = options.shown?.() ?? {
          ok: true,
          result: { worktree: { path: args[2].slice('--worktree=path:'.length), hostId: 'local' } },
        };
        if ((shown as { ok?: unknown }).ok === true) return JSON.stringify(shown);
        throw Object.assign(new Error('exit 1'), { stdout: JSON.stringify(shown) });
      }
      if (args[0] === 'worktree' && args[1] === 'list')
        return JSON.stringify({ ok: true, result: { worktrees: options.worktrees?.() ?? [] } });
      if (args[1] === 'list') return JSON.stringify(lists.length > 1 ? lists.shift() : lists[0]);
      if (args[1] === 'switch') return JSON.stringify({ ok: true });
      if (args[1] === 'create')
        return options.create?.() ?? JSON.stringify({ ok: true, result: {} });
      throw new Error('unexpected');
    },
  };
  return { calls, launcher: new OrcaLaunch(deps) };
}

test('create answers: launched, uncertain (Orca or our own time limit), refused with a reason', () => {
  assert.deepEqual(classifyOrcaCreate(JSON.stringify({ ok: true, result: {} })), {
    kind: 'launched',
  });
  const exit1 = Object.assign(new Error('exit 1'), { code: 1 });
  for (const out of [
    HANDLE_TIMEOUT,
    answer('runtime_error', 'Terminal creation timed out'),
    answer('runtime_timeout', 'The Orca runtime did not answer in time.'),
  ]) {
    assert.deepEqual(classifyOrcaCreate(out, exit1), { kind: 'uncertain' }, out);
    assert.deepEqual(classifyOrcaCreate(out), { kind: 'uncertain' }, out);
  }
  // Our time limit ended the CLI before it printed anything.
  const killed = Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' });
  assert.deepEqual(classifyOrcaCreate('', killed), { kind: 'uncertain' });
  assert.deepEqual(classifyOrcaCreate(undefined, killed), { kind: 'uncertain' });
  // Only a reason naming the folder carries the workspace hint.
  assert.deepEqual(classifyOrcaCreate(answer('selector_not_found', 'No worktree'), exit1), {
    kind: 'refused',
    reason: 'No worktree',
    workspace: true,
  });
  assert.deepEqual(classifyOrcaCreate(answer('invalid_argument', 'bad flag'), exit1), {
    kind: 'refused',
    reason: 'bad flag',
    workspace: false,
  });
  // A plain failure with nothing to read: a refusal without a guessed reason.
  assert.deepEqual(classifyOrcaCreate('', exit1), {
    kind: 'refused',
    reason: '',
    workspace: false,
  });
  const t = m().tmux;
  assert.notEqual(t.orcaRefused('bad flag'), t.orcaRefused('bad flag', true));
  assert.ok(t.orcaRefused('x', true).startsWith(t.orcaRefused('x').split(' ')[0]));
});

test('a refusal names the folder only for a workspace reason', async () => {
  const general = fixture({ create: () => answer('invalid_argument', 'bad flag') });
  const workspace = fixture({ create: () => answer('selector_not_found', 'No worktree') });
  await assert.rejects(
    general.launcher.start(claude, async () => true),
    {
      message: m().tmux.orcaRefused('bad flag', false),
    },
  );
  await assert.rejects(
    workspace.launcher.start(claude, async () => true),
    {
      message: m().tmux.orcaRefused('No worktree', true),
    },
  );
  // A refusal made nothing to wait for.
  assert.equal(general.launcher.pending.has(claude), false);
});

test('the Orca create waits up to 35 s, past Orca’s own 10 s + 10 s', async () => {
  const f = fixture();
  assert.equal((await f.launcher.start(claude, async () => true)).launched, true);
  assert.equal(f.calls.find((c) => c.args[1] === 'create')?.timeout, 35_000);
  // Confirmed at once: Orca is not brought forward again and nothing is looked for.
  assert.equal(
    f.calls.some((c) => c.file === '/usr/bin/open'),
    false,
  );
});

test('an unconfirmed start is found by its title, adopted and switched to', async () => {
  const f = fixture({
    create: () => {
      throw Object.assign(new Error('exit 1'), { stdout: HANDLE_TIMEOUT });
    },
    // Before: one tab already there. Then nothing yet; then ours beside another new one.
    lists: [
      listed(term('term_old', '기능 담당')),
      listed(term('term_old', '기능 담당')),
      listed(
        term('term_old', '기능 담당'),
        term('term_other', 'zsh'),
        term('term_new', '기능 담당'),
      ),
    ],
  });
  const result = await f.launcher.start(claude, async () => true);
  assert.equal(result.launched, true);
  assert.equal(result.uncertain, undefined);
  assert.equal(result.message, m().tmux.orcaLaunched);
  // Orca came forward first (it mounts the tab), then the found terminal was switched to.
  const open = f.calls.findIndex((c) => c.file === '/usr/bin/open');
  const switched = f.calls.findIndex((c) => c.args[1] === 'switch');
  assert.ok(open > 0 && switched > open);
  assert.deepEqual(f.calls[open].args, ['-a', 'Orca']);
  assert.deepEqual(f.calls[switched].args, ['terminal', 'switch', '--terminal=term_new', '--json']);
  // The list before creating is taken for the same worktree.
  const lists = f.calls.filter((c) => c.args[1] === 'list');
  // Asked for every row: Orca's default limit could cut a busy worktree's list short.
  assert.deepEqual(lists[0].args, [
    'terminal',
    'list',
    `--worktree=path:${claude.cwd}`,
    '--limit=10000',
    '--json',
  ]);
  assert.ok(
    f.calls.findIndex((c) => c.args[1] === 'list') <
      f.calls.findIndex((c) => c.args[1] === 'create'),
  );
  // Adopted: no longer unconfirmed, only reserved while the agent starts in that tab.
  assert.deepEqual(f.launcher.pending.state(claude), { where: 'orca', starting: true });
});

test('an unconfirmed start is not tied to a new terminal of another title', async () => {
  // The only new one may be a tab the person opened meanwhile: it stays unconfirmed.
  const f = fixture({
    create: () => HANDLE_TIMEOUT,
    lists: [listed(term('term_old')), listed(term('term_old'), term('term_new', '✳ Claude'))],
  });
  const result = await f.launcher.start(claude, async () => true);
  assert.equal(result.launched, false);
  assert.equal(result.uncertain, true);
  assert.equal(
    f.calls.some((c) => c.args[1] === 'switch'),
    false,
  );
});

test('a background (remote) unconfirmed start answers at once, without looking or switching', async () => {
  const f = fixture({
    create: () => HANDLE_TIMEOUT,
    lists: [listed(), listed(term('term_new', '기능 담당'))],
  });
  const result = await f.launcher.start({ ...claude, background: true }, async () => true);
  assert.equal(result.uncertain, true);
  assert.equal(
    f.calls.some((c) => c.args[1] === 'switch'),
    false,
  );
});

test('title mismatch: several new terminals, a partial list before, or another worktree adopt nothing', async () => {
  for (const lists of [
    // Two new terminals, neither titled as the launch: never guessed between.
    [listed(), listed(term('term_a', 'zsh'), term('term_b', 'node'))],
    // A partial list before creating: a single "new" one may have been there all along.
    [{ ok: true, result: { terminals: [], truncated: true } }, listed(term('term_a', 'zsh'))],
    // Another worktree's terminal is never ours.
    [listed(), listed(term('term_a', '기능 담당', '/projects/elsewhere'))],
  ]) {
    const f = fixture({ create: () => HANDLE_TIMEOUT, lists });
    const result = await f.launcher.start(claude, async () => true);
    assert.equal(result.launched, false);
    assert.equal(result.uncertain, true);
    assert.equal(
      f.calls.some((c) => c.args[1] === 'switch'),
      false,
    );
  }
  // Nor is the one titled as the launch after a partial list: titles repeat (an older tab of the
  // same conversation may be the one the list left out), so it stays unconfirmed.
  const titled = fixture({
    create: () => HANDLE_TIMEOUT,
    lists: [
      { ok: true, result: { terminals: [], truncated: true } },
      listed(term('term_a', 'zsh'), term('term_b', '기능 담당')),
    ],
  });
  const kept = await titled.launcher.start(claude, async () => true);
  assert.equal(kept.launched, false);
  assert.equal(kept.uncertain, true);
  assert.equal(
    titled.calls.some((c) => c.args[1] === 'switch'),
    false,
  );
});

test('never found: uncertain (no tmux hint), looked for about 30 s, kept pending for 2 min', async () => {
  let now = 0;
  const pending = new PendingLaunches(120_000, () => now);
  const waits: number[] = [];
  const f = fixture({
    create: () => HANDLE_TIMEOUT,
    pending,
    wait: async (ms) => void waits.push(ms),
  });
  const result = await f.launcher.start(claude, async () => true);
  assert.deepEqual(result, {
    available: true,
    command: `${CL}'claude' '--resume' '${claude.nativeId}'`,
    launched: false,
    uncertain: true,
    message: m().tmux.orcaUncertain,
  });
  assert.equal(result.message!.includes('tmux'), false);
  assert.equal(waits.length, ADOPT_LOOKS);
  assert.equal(
    waits.reduce((a, b) => a + b, 0),
    30_000,
  );
  assert.equal(f.calls.filter((c) => c.file === '/usr/bin/open').length, 1);
  assert.equal(f.launcher.pending, pending);
  assert.equal(pending.has(claude), true);
  // The duplicate check reads it as open in Orca, so launching it again is cautioned.
  const check = () =>
    checkDuplicate({
      agent: async () => ({ kind: 'none' }),
      orcaTab: async () => ({ kind: 'none' }),
      ownTmux: async () => ({ kind: 'none' }),
      pending: () => pending.has(claude),
    });
  const seen: string[] = [];
  await f.launcher.start(claude, async (_info, c) => (seen.push(c.state), false), undefined, check);
  assert.deepEqual(seen, ['open']);
  now += 120_000;
  assert.deepEqual(await check(), { state: 'none' });
});

test('a later confirmed launch turns its unconfirmed record into a startup reservation', async () => {
  const pending = new PendingLaunches();
  pending.add(claude);
  const f = fixture({ pending });
  assert.equal((await f.launcher.start(claude, async () => true)).launched, true);
  // The tab exists, but the agent in it may not show yet: still cautioned, now as "starting".
  assert.deepEqual(pending.state(claude), { where: 'orca', starting: true });
});

test('a fresh summon is kept pending by agent, folder and name', async () => {
  const f = fixture({ create: () => HANDLE_TIMEOUT });
  const summon = { ...codex, nativeId: 'new', fresh: true, alias: '새 동료' };
  assert.equal((await f.launcher.start(summon, async () => true)).uncertain, true);
  const target = { provider: 'codex', nativeId: 'new', cwd: claude.cwd, fresh: true };
  assert.equal(f.launcher.pending.has({ ...target, name: '새 동료' }), true);
  assert.equal(f.launcher.pending.has({ ...target, name: '다른 동료' }), false);
  assert.equal(f.launcher.pending.has(codex), false);
});

test('our own time limit with nothing printed is uncertain too, never a refusal', async () => {
  const f = fixture({
    create: () => {
      throw Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM', stdout: '' });
    },
  });
  assert.equal((await f.launcher.start(claude, async () => true)).uncertain, true);
});

test('a resume checks the workspace too, telling a subfolder from no workspace', async () => {
  let shown: unknown = { ok: false, error: { code: 'selector_not_found' } };
  let worktrees: unknown[] = [{ path: '/projects', hostId: 'local' }];
  const f = fixture({ shown: () => shown, worktrees: () => worktrees });
  const t = m().tmux;
  // Inside /projects: a subfolder of a workspace.
  assert.deepEqual(await f.launcher.status(claude), {
    available: false,
    reason: t.orcaSubfolder('/projects'),
  });
  await assert.rejects(
    f.launcher.start(claude, async () => true),
    {
      message: t.orcaSubfolder('/projects'),
    },
  );
  assert.deepEqual(f.calls.find((c) => c.args[1] === 'list' && c.args[0] === 'worktree')?.args, [
    'worktree',
    'list',
    '--limit=10000',
    '--json',
  ]);
  // The deepest enclosing workspace is named; a name that only starts the same, or a remote
  // workspace, never counts.
  worktrees = [
    { path: '/projects', hostId: 'local' },
    { path: "/projects/a 'quoted'", hostId: 'local' },
    { path: claude.cwd, hostId: 'remote' },
  ];
  assert.equal((await f.launcher.status(claude)).reason, t.orcaSubfolder('/projects'));
  worktrees = [
    { path: '/projects', hostId: 'local' },
    { path: claude.cwd, hostId: 'local' },
  ];
  assert.equal(
    (await f.launcher.status({ ...claude, cwd: `${claude.cwd}/packages/web` })).reason,
    t.orcaSubfolder(claude.cwd),
  );
  // In no workspace at all.
  worktrees = [{ path: '/elsewhere', hostId: 'local' }];
  assert.deepEqual(await f.launcher.status(claude), {
    available: false,
    reason: t.orcaNotWorkspace,
  });
  await assert.rejects(
    f.launcher.start(claude, async () => true),
    {
      message: t.orcaNotWorkspace,
    },
  );
  // Listed but not shown: Orca could not tell, so unavailable without a guessed reason.
  worktrees = [{ path: claude.cwd, hostId: 'local' }];
  assert.deepEqual(await f.launcher.status(claude), { available: false });
  // Its own registered workspace: offered and launched.
  shown = { ok: true, result: { worktree: { path: claude.cwd, hostId: 'local' } } };
  assert.equal((await f.launcher.status(claude)).available, true);
  assert.equal((await f.launcher.start(claude, async () => true)).launched, true);
  assert.equal(f.calls.filter((c) => c.args[1] === 'create').length, 1);
});

test('the agent CLI resolved as for tmux goes with the Orca command, else its bare name', async () => {
  const resolved = async (binary: (name: string) => Promise<string>) =>
    (await fixture({ binary }).launcher.status(claude)).command;
  assert.equal(
    await resolved(async () => '/Users/me/.local/bin/claude'),
    `${CL}'/Users/me/.local/bin/claude' '--resume' '${claude.nativeId}'`,
  );
  // Orca tells an interactive agent by the program's file name: another name stays bare.
  assert.equal(
    await resolved(async () => '/opt/bin/claude-wrapper'),
    `${CL}'claude' '--resume' '${claude.nativeId}'`,
  );
  // Not found here (nvm and the like): the tab's login shell finds it, as before.
  assert.equal(
    await resolved(async () => {
      throw new Error('missing');
    }),
    `${CL}'claude' '--resume' '${claude.nativeId}'`,
  );
  // Fresh summons too, and the confirmation shows the command that is typed.
  const f = fixture({ binary: async (name) => `/opt/homebrew/bin/${name}` });
  let asked = '';
  await f.launcher.start(
    { ...codex, nativeId: 'new', fresh: true, initialMessage: 'hi' },
    async (info) => ((asked = info.command), true),
  );
  const typed = command(f.calls.find((c) => c.args[1] === 'create')!.args);
  assert.equal(typed, `${CX}'/opt/homebrew/bin/codex' '--' 'hi'`);
  assert.equal(asked, typed);
  // An explicit (remote launcher's) path is kept as given.
  assert.equal(
    command(orcaCreateArgs({ ...claude, executable: '/x/claude' })),
    `${CL}'/x/claude' '--resume' '${claude.nativeId}'`,
  );
});
