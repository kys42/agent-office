import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LaunchCore, launchResult, pendingKey, type LaunchTarget } from '../desktop/launch/core.js';
import { LaunchQueue, type DestinationProbe } from '../desktop/launch/pipeline.js';
import {
  terminalAppDestination,
  terminalAppFailure,
  tmuxDestination,
} from '../desktop/launch/destinations.js';
import { checkDuplicate } from '../desktop/launch-guard.js';
import { PendingLaunches } from '../desktop/pending-launch.js';
import { TmuxResume, type ResumeDeps } from '../desktop/tmux-resume.js';
import { pendingNotice } from '../src/shared/launch.js';
import { m } from '../src/shared/i18n/index.js';
import type { DuplicateCheck } from '../src/shared/types.js';

/**
 * A destination cut off after it may have taken the command (#322 review): Terminal accepted
 * `do script` before our time limit killed osascript, or tmux made the session before its call
 * timed out. Killing the caller undoes nothing, so it is `uncertain` and held pending: a retry
 * before the agent shows up is cautioned, never a silent second start. Every command is a fake.
 */

delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

const CWD = '/projects/office';
const ID = '4f1c2a3b-0000-4000-8000-000000000001';
const resume: LaunchTarget = { kind: 'resume', provider: 'claude', cwd: CWD, nativeId: ID };
const fresh: LaunchTarget = {
  kind: 'new',
  provider: 'codex',
  cwd: CWD,
  name: '리뷰 봇',
  initialMessage: '이 PR 리뷰해줘',
};
/** How `execFile` reports our own time limit ending a call. */
const killed = () =>
  Object.assign(new Error('Command failed: /usr/bin/osascript'), {
    killed: true,
    signal: 'SIGTERM',
    code: null,
  });

/** A Terminal.app whose `do script` is taken, then osascript is killed before it answers. */
function slowTerminal(fail: () => unknown = killed) {
  const typed: string[] = [];
  const destination = terminalAppDestination({
    platform: 'darwin',
    directory: async () => true,
    env: {},
    run: async (file, args) => {
      assert.equal(file, '/usr/bin/osascript');
      typed.push(args.at(-1)!);
      throw fail();
    },
  });
  return { typed, destination };
}

/** The main process's check of a saved conversation, here with nothing else running. */
const conversationCheck = (pending: PendingLaunches) => () => (fresh: boolean) =>
  checkDuplicate(
    {
      agent: async () => ({ kind: 'none' }),
      orcaTab: async () => ({ kind: 'none' }),
      ownTmux: async () => ({ kind: 'none' }),
      pending: () => pending.where(pendingKey(resume)),
    },
    fresh,
  );

for (const target of [resume, fresh])
  test(`Terminal took the ${target.kind} command before osascript timed out: a retry is cautioned, not started again`, async () => {
    const pending = new PendingLaunches();
    const terminal = slowTerminal();
    const core = new LaunchCore({
      destinations: { terminalApp: terminal.destination },
      pending,
      queue: new LaunchQueue(),
      conversationCheck: conversationCheck(pending),
    });
    const first = await core.start(target, 'terminalApp', { confirm: async () => true });
    assert.equal(first.state, 'uncertain');
    assert.deepEqual(launchResult('terminalApp', first), {
      state: 'uncertain',
      destination: 'terminalApp',
      message: m().launch.terminalAppUncertain,
      command: terminal.typed[0],
    });
    // Not a failure to retry elsewhere: it may be running in that Terminal window.
    assert.equal(m().launch.terminalAppUncertain.includes('tmux'), false);
    assert.equal(pending.where(pendingKey(target)), 'other');
    // A second start before the agent is visible: the confirmation warns it is already open in
    // another terminal; the person who reads that and stops starts nothing.
    const seen: DuplicateCheck[] = [];
    const again = await core.start(target, 'terminalApp', {
      confirm: async (_p: DestinationProbe, check) => (seen.push(check), false),
    });
    assert.equal(again.state, 'cancelled');
    assert.deepEqual(seen, [{ state: 'open', where: 'other', pending: true }]);
    assert.equal(terminal.typed.length, 1);
    assert.equal(pendingNotice('other'), m().launch.terminalAppUncertain);
    // Opened at another destination meanwhile: refused after the confirmation as changed.
    const meanwhile = new PendingLaunches();
    const raced = new LaunchCore({
      destinations: { terminalApp: slowTerminal().destination },
      pending: meanwhile,
      queue: new LaunchQueue(),
      conversationCheck: conversationCheck(meanwhile),
    });
    const changed = await raced.start(target, 'terminalApp', {
      confirm: async () => {
        meanwhile.add(pendingKey(target), 'other');
        return true;
      },
    });
    assert.equal(changed.state === 'refused' && changed.reason, m().tmux.changedRefused);
  });

test('only a failure before Terminal could take the command is a refusal (nothing pending)', async () => {
  assert.equal(terminalAppFailure(killed()), 'uncertain');
  assert.equal(terminalAppFailure({ code: 'ETIMEDOUT' }), 'uncertain');
  // An error we cannot place may come after the window opened.
  assert.equal(
    terminalAppFailure(new Error('Command failed: osascript\nsomething odd')),
    'uncertain',
  );
  assert.equal(terminalAppFailure(Object.assign(new Error('spawn'), { code: 'ENOENT' })), 'failed');
  const appleScript = (n: number) =>
    Object.assign(new Error(`Command failed: osascript\nexecution error: … (${n})`), { code: 1 });
  assert.equal(terminalAppFailure(appleScript(-1743)), 'denied');
  assert.equal(terminalAppFailure(appleScript(-10814)), 'failed');
  for (const [error, reason] of [
    [appleScript(-1743), m().launch.terminalAppDenied],
    [Object.assign(new Error('spawn'), { code: 'ENOENT' }), m().launch.terminalAppFailed],
  ] as const) {
    const pending = new PendingLaunches();
    const core = new LaunchCore({
      destinations: { terminalApp: slowTerminal(() => error).destination },
      pending,
      queue: new LaunchQueue(),
    });
    const outcome = await core.start(resume, 'terminalApp', { confirm: async () => true });
    assert.equal(outcome.state === 'refused' && outcome.reason, reason);
    assert.equal(pending.has(pendingKey(resume)), false);
  }
});

/** A fake dedicated tmux server whose `new-session` call is cut off by our time limit. */
function slowTmux(created: boolean) {
  const launches: string[][] = [];
  let rows = '';
  const deps: ResumeDeps = {
    platform: 'darwin',
    server: 'aotest-launch-uncertain',
    binary: async (name) => '/bin/' + name,
    directory: async () => true,
    run: async (_file, args) => {
      if (args.includes('list-sessions')) return rows;
      if (args.includes('list-panes')) return '%1\t0';
      if (args.includes('new-session')) {
        launches.push(args);
        // tmux made it before the call was killed (or not yet, when `created` is false).
        if (created) rows = `${args[args.indexOf('-s') + 1]}\t${args.at(-1)}\t\t\t`;
        throw killed();
      }
      return '';
    },
  };
  return { launches, tmux: new TmuxResume(deps) };
}

test('tmux made the session before its call timed out: launched, and a retry finds it running', async () => {
  const f = slowTmux(true);
  const pending = new PendingLaunches();
  const core = new LaunchCore({
    destinations: { tmux: tmuxDestination(f.tmux) },
    pending,
    queue: new LaunchQueue(),
  });
  assert.equal((await core.start(fresh, 'tmux', { confirm: async () => true })).state, 'launched');
  const retry = await core.start(fresh, 'tmux', {
    confirm: async () => assert.fail('a running session is not asked about again'),
  });
  assert.equal(retry.state, 'running');
  assert.equal(f.launches.length, 1);
  assert.equal(pending.has(pendingKey(fresh)), false);
});

test('tmux cut off with no session yet: uncertain and held, never "check your install"', async () => {
  const f = slowTmux(false);
  const pending = new PendingLaunches();
  const core = new LaunchCore({
    destinations: { tmux: tmuxDestination(f.tmux) },
    pending,
    queue: new LaunchQueue(),
  });
  const first = await core.start(fresh, 'tmux', { confirm: async () => true });
  assert.equal(first.state, 'uncertain');
  assert.equal(first.state === 'uncertain' && first.message, m().launch.tmuxUncertain);
  assert.equal(pending.where(pendingKey(fresh)), 'tmux');
  const seen: DuplicateCheck[] = [];
  await core.start(fresh, 'tmux', { confirm: async (_p, check) => (seen.push(check), false) });
  assert.deepEqual(seen, [{ state: 'open', where: 'tmux', pending: true }]);
  assert.equal(f.launches.length, 1);
  // The older channel tells it the same way, as a notice and not as a start that worked.
  await assert.rejects(
    slowTmux(false).tmux.start({ provider: 'claude', nativeId: ID, cwd: CWD }, async () => true),
    {
      message: m().launch.tmuxUncertain,
    },
  );
});

test('a Terminal window that opened is only a startup reservation: a second resume before the agent shows is cautioned', async () => {
  const pending = new PendingLaunches();
  const typed: string[] = [];
  // Terminal takes `do script` at once; the agent in it takes a while to show as a process.
  let agentRunning = false;
  const core = new LaunchCore({
    destinations: {
      terminalApp: terminalAppDestination({
        platform: 'darwin',
        directory: async () => true,
        env: {},
        run: async (_file, args) => (typed.push(args.at(-1)!), ''),
      }),
    },
    pending,
    queue: new LaunchQueue(),
    // As main checks a saved conversation: its process first, then what is held pending.
    conversationCheck: () => (fresh) =>
      checkDuplicate(
        {
          agent: async () =>
            agentRunning ? { kind: 'found', terminal: { where: 'other' } } : { kind: 'none' },
          orcaTab: async () => ({ kind: 'none' }),
          ownTmux: async () => ({ kind: 'none' }),
          pending: () => pending.state(pendingKey(resume)),
        },
        fresh,
      ),
  });
  const first = await core.start(resume, 'terminalApp', { confirm: async () => true });
  assert.equal(first.state, 'launched');
  assert.deepEqual(pending.state(pendingKey(resume)), { where: 'other', starting: true });
  // Again before the agent shows up: warned that it was just started there, and stopped.
  const seen: DuplicateCheck[] = [];
  const again = await core.start(resume, 'terminalApp', {
    confirm: async (_p: DestinationProbe, check) => (seen.push(check), false),
  });
  assert.equal(again.state, 'cancelled');
  assert.deepEqual(seen, [{ state: 'open', where: 'other', pending: true, starting: true }]);
  assert.equal(typed.length, 1);
  assert.equal(pendingNotice('other', true), m().launch.starting(m().tmux.place.other));
  // Once the agent runs, that beats the reservation: refused without asking.
  agentRunning = true;
  const running = await core.start(resume, 'terminalApp', {
    confirm: async () => assert.fail('a running conversation is not asked about'),
  });
  assert.equal(running.state, 'refused');
  assert.deepEqual(running.state === 'refused' && running.duplicate, {
    state: 'running',
    where: 'other',
  });
  assert.equal(typed.length, 1);
});

test('a tmux start seen running reserves nothing: its own session already answers a retry', async () => {
  const launches: string[][] = [];
  let rows = '';
  const tmux = new TmuxResume({
    platform: 'darwin',
    server: 'aotest-launch-reserve',
    binary: async (name) => '/bin/' + name,
    directory: async () => true,
    run: async (_file, args) => {
      if (args.includes('list-sessions')) return rows;
      if (args.includes('list-panes')) return '%1\t0';
      if (args.includes('new-session')) {
        launches.push(args);
        rows = `${args[args.indexOf('-s') + 1]}\t${args.at(-1)}\t\t\t`;
      }
      return '';
    },
  });
  const pending = new PendingLaunches();
  const core = new LaunchCore({
    destinations: { tmux: tmuxDestination(tmux) },
    pending,
    queue: new LaunchQueue(),
  });
  assert.equal((await core.start(resume, 'tmux', { confirm: async () => true })).state, 'launched');
  assert.equal(pending.has(pendingKey(resume)), false);
  assert.equal((await core.start(resume, 'tmux', { confirm: async () => true })).state, 'running');
  assert.equal(launches.length, 1);
});

for (const target of [fresh, { ...fresh, kind: 'fork', provider: 'claude', nativeId: ID }] as const)
  test(`tmux took the ${target.kind} command but its session could not be read after: uncertain, and Terminal is cautioned`, async () => {
    const launches: string[][] = [];
    let accepted = false;
    const tmux = new TmuxResume({
      platform: 'darwin',
      server: 'aotest-launch-unreadable',
      binary: async (name) => '/bin/' + name,
      directory: async () => true,
      run: async (_file, args) => {
        if (args.includes('list-sessions')) {
          // Readable before the launch; after it, the server does not answer the look.
          if (accepted) throw Object.assign(new Error('timeout'), { killed: true });
          return '';
        }
        if (args.includes('new-session')) {
          launches.push(args);
          accepted = true;
        }
        return '';
      },
    });
    const pending = new PendingLaunches();
    const terminal = slowTerminal(() =>
      assert.fail('a cautioned start that is cancelled types nothing'),
    );
    const core = new LaunchCore({
      destinations: { tmux: tmuxDestination(tmux), terminalApp: terminal.destination },
      pending,
      queue: new LaunchQueue(),
    });
    const first = await core.start(target, 'tmux', { confirm: async () => true });
    assert.equal(first.state, 'uncertain');
    assert.equal(first.state === 'uncertain' && first.message, m().launch.tmuxUncertain);
    assert.equal(pending.where(pendingKey(target)), 'tmux');
    // The same new agent (or fork) somewhere else: only the pending record guards it.
    const seen: DuplicateCheck[] = [];
    const elsewhere = await core.start(target, 'terminalApp', {
      confirm: async (_p, check) => (seen.push(check), false),
    });
    assert.equal(elsewhere.state, 'cancelled');
    assert.deepEqual(seen, [{ state: 'open', where: 'tmux', pending: true }]);
    assert.equal(terminal.typed.length, 0);
    assert.equal(launches.length, 1);
  });
