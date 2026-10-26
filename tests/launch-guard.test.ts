import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDuplicate,
  confirmLaunch,
  decideDuplicate,
  duplicateNote,
  livenessFor,
  DuplicateLaunchError,
  type LaunchEvidence,
} from '../desktop/launch-guard.js';
import { OrcaLaunch, type OrcaLaunchDeps } from '../desktop/orca-launch.js';
import { TmuxResume, type ResumeDeps } from '../desktop/tmux-resume.js';
import { lookupOrcaTab } from '../desktop/orca-tabs.js';
import type { TerminalHostDeps } from '../desktop/terminal-host.js';
import { m } from '../src/shared/i18n/index.js';
import type { DuplicateCheck } from '../src/shared/types.js';

delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

const none = { kind: 'none' } as const;
const unknown = { kind: 'unknown' } as const;
const found = (where: 'orca' | 'tmux' | 'other' = 'orca') =>
  ({ kind: 'found', terminal: { where } }) as const;
const evidence = (over: Partial<LaunchEvidence> = {}): LaunchEvidence => ({
  agent: none,
  orcaTab: none,
  ownTmux: none,
  ...over,
});

test('the decision: running beats open beats unknown beats none', () => {
  assert.deepEqual(decideDuplicate(evidence()), { state: 'none' });
  assert.deepEqual(decideDuplicate(evidence({ agent: found('other') })), {
    state: 'running',
    where: 'other',
  });
  // A verified live agent wins even when everything else is unknown or open.
  assert.deepEqual(
    decideDuplicate(
      evidence({
        agent: found('orca'),
        orcaTab: { kind: 'found', terminal: {} },
        ownTmux: unknown,
      }),
    ),
    { state: 'running', where: 'orca' },
  );
  assert.deepEqual(decideDuplicate(evidence({ ownTmux: { kind: 'found', terminal: null } })), {
    state: 'running',
    where: 'tmux',
  });
  // A tab (connected or not) without a verified agent: open, even when the agent is unknown.
  assert.deepEqual(
    decideDuplicate(evidence({ agent: unknown, orcaTab: { kind: 'found', terminal: {} } })),
    { state: 'open', where: 'orca' },
  );
  for (const part of ['agent', 'orcaTab', 'ownTmux'] as const)
    assert.deepEqual(decideDuplicate(evidence({ [part]: unknown })), { state: 'unknown' });
});

test('a part of the check that fails counts as unknown, never as none', async () => {
  const check = await checkDuplicate({
    agent: async () => none,
    orcaTab: async () => {
      throw new Error('orca broke');
    },
    ownTmux: async () => none,
  });
  assert.deepEqual(check, { state: 'unknown' });
  const fresh: boolean[] = [];
  await checkDuplicate(
    {
      agent: async (f) => (fresh.push(f), none),
      orcaTab: async (f) => (fresh.push(f), none),
      ownTmux: async (f) => (fresh.push(f), none),
    },
    true,
  );
  assert.deepEqual(fresh, [true, true, true]);
});

test('an agent without a liveness adapter is never shown absent', async () => {
  assert.deepEqual(await livenessFor('cursor' as never).lookup('x', true), unknown);
});

test('the confirmation warns about an open tab and an unverifiable check', () => {
  assert.equal(duplicateNote({ state: 'none' }), '');
  assert.match(duplicateNote({ state: 'open', where: 'orca' }), /Orca/);
  assert.equal(duplicateNote({ state: 'unknown' }), '\n\n' + m().tmux.unknownConfirm);
});

test('confirmLaunch: running refuses without asking; a worse re-check refuses after asking', async () => {
  const sequence = (...checks: DuplicateCheck[]) => {
    const fresh: boolean[] = [];
    return {
      fresh,
      check: async (f: boolean) => (fresh.push(f), checks.length > 1 ? checks.shift()! : checks[0]),
    };
  };
  let asked = 0;
  const yes = async () => (asked++, true);
  const running = sequence({ state: 'running', where: 'orca' });
  await assert.rejects(confirmLaunch(running.check, yes), DuplicateLaunchError);
  assert.equal(asked, 0);
  // Both checks are fresh reads, never a cached or renderer-provided status.
  const same = sequence({ state: 'open', where: 'orca' }, { state: 'open', where: 'orca' });
  assert.equal(await confirmLaunch(same.check, yes), true);
  assert.deepEqual(same.fresh, [true, true]);
  // Opened in Orca while the dialog was up: the person accepted 'none', not this.
  const opened = sequence({ state: 'none' }, { state: 'open', where: 'orca' });
  await assert.rejects(confirmLaunch(opened.check, yes), { message: m().tmux.changedRefused });
  // A check that got better (unknown -> none) still launches.
  assert.equal(
    await confirmLaunch(sequence({ state: 'unknown' }, { state: 'none' }).check, yes),
    true,
  );
  // Cancelled: no second check.
  const cancelled = sequence({ state: 'none' });
  assert.equal(await confirmLaunch(cancelled.check, async () => false), false);
  assert.equal(cancelled.fresh.length, 1);
});

// ---- Orca launcher ---------------------------------------------------------------------------

const claude = {
  provider: 'claude' as const,
  nativeId: '4f1c2a3b-0000-4000-8000-000000000001',
  cwd: '/projects/office',
  title: '기능 담당',
};

function orcaFixture() {
  const created: string[][] = [];
  const deps: OrcaLaunchDeps = {
    platform: 'darwin',
    orca: () => '/bin/orca',
    directory: async () => true,
    run: async (_file, args) => {
      if (args[0] === 'status')
        return JSON.stringify({ ok: true, result: { runtime: { reachable: true } } });
      if (args[1] === 'create') {
        created.push(args);
        return JSON.stringify({ ok: true, result: {} });
      }
      throw new Error('unexpected');
    },
  };
  return { created, launcher: new OrcaLaunch(deps) };
}

/** A fake duplicate check answering from a list, one answer per call (the last one repeats). */
const answers = (...checks: DuplicateCheck[]) => {
  const calls: boolean[] = [];
  return {
    calls,
    check: async (fresh: boolean) => (
      calls.push(fresh),
      checks.length > 1 ? checks.shift()! : checks[0]
    ),
  };
};

for (const outcome of [
  { state: 'none' },
  { state: 'unknown' },
  { state: 'open', where: 'orca' },
] as DuplicateCheck[])
  test(`Orca launch with ${outcome.state}: the confirmation sees it, then the tab opens`, async () => {
    const f = orcaFixture();
    const seen: DuplicateCheck[] = [];
    const result = await f.launcher.start(
      claude,
      async (_info, check) => (seen.push(check), true),
      undefined,
      answers(outcome).check,
    );
    assert.equal(result.launched, true);
    assert.deepEqual(seen, [outcome]);
    assert.equal(f.created.length, 1);
  });

test('Orca launch of a running conversation: refused before asking, nothing created', async () => {
  const f = orcaFixture();
  let asked = false;
  await assert.rejects(
    f.launcher.start(
      claude,
      async () => (asked = true),
      undefined,
      answers({ state: 'running', where: 'orca' }).check,
    ),
    { message: m().tmux.runningRefused('Orca') },
  );
  assert.equal(asked, false);
  assert.equal(f.created.length, 0);
});

test('Orca launch: the fresh re-check after the dialog refuses a conversation that started meanwhile', async () => {
  const f = orcaFixture();
  const fake = answers({ state: 'none' }, { state: 'running', where: 'tmux' });
  let authorized = false;
  await assert.rejects(
    f.launcher.start(
      claude,
      async () => true,
      () => (authorized = true),
      fake.check,
    ),
    { message: m().tmux.runningRefused('tmux') },
  );
  assert.deepEqual(fake.calls, [true, true]);
  assert.equal(authorized, false);
  assert.equal(f.created.length, 0);
});

test('Orca launch: cancelled from a duplicate warning creates nothing', async () => {
  const f = orcaFixture();
  const result = await f.launcher.start(
    claude,
    async () => false,
    undefined,
    answers({ state: 'open', where: 'orca' }).check,
  );
  assert.equal(result.launched, false);
  assert.equal(f.created.length, 0);
});

// ---- tmux launcher ---------------------------------------------------------------------------

function tmuxFixture() {
  let row = '';
  const created: string[][] = [];
  const deps: ResumeDeps = {
    platform: 'darwin',
    server: 'test-office',
    binary: async (name) => '/bin/' + name,
    directory: async () => true,
    run: async (_file, args) => {
      if (args.includes('list-sessions')) return row;
      if (args.includes('list-panes')) return '%1\t0';
      if (args.includes('new-session')) {
        created.push(args);
        row = args[args.indexOf('-s') + 1] + '\t' + args.at(-1);
      }
      return '';
    },
  };
  return { created, manager: new TmuxResume(deps) };
}

for (const outcome of [
  { state: 'none' },
  { state: 'unknown' },
  { state: 'open', where: 'orca' },
] as DuplicateCheck[])
  test(`tmux resume with ${outcome.state}: the confirmation sees it, then the session starts`, async () => {
    const f = tmuxFixture();
    const seen: DuplicateCheck[] = [];
    const info = await f.manager.start(
      claude,
      async (_info, check) => (seen.push(check), true),
      undefined,
      answers(outcome).check,
    );
    assert.equal(info.running, true);
    assert.deepEqual(seen, [outcome]);
    assert.equal(f.created.length, 1);
  });

test('tmux resume of a conversation running in Orca: refused before asking, no tmux session', async () => {
  const f = tmuxFixture();
  let asked = false;
  await assert.rejects(
    f.manager.start(
      claude,
      async () => (asked = true),
      undefined,
      answers({ state: 'running', where: 'orca' }).check,
    ),
    { message: m().tmux.runningRefused('Orca') },
  );
  assert.equal(asked, false);
  assert.equal(f.created.length, 0);
});

test('tmux resume: the fresh re-check after the dialog refuses a conversation that started meanwhile', async () => {
  const f = tmuxFixture();
  const fake = answers({ state: 'unknown' }, { state: 'running', where: 'other' });
  await assert.rejects(
    f.manager.start(claude, async () => true, undefined, fake.check),
    {
      message: m().tmux.runningRefused(m().tmux.place.other),
    },
  );
  assert.deepEqual(fake.calls, [true, true]);
  assert.equal(f.created.length, 0);
});

test('tmux summon (a new conversation) keeps working without a duplicate check', async () => {
  const f = tmuxFixture();
  const seen: DuplicateCheck[] = [];
  const info = await f.manager.start(claude, async (_i, check) => (seen.push(check), true));
  assert.equal(info.running, true);
  assert.deepEqual(seen, [{ state: 'none' }]);
});

// ---- Orca tab evidence -----------------------------------------------------------------------

const tabRow = (over: Record<string, unknown> = {}) => ({
  handle: 'term_11111111-1111-4111-8111-111111111111',
  orphaned: false,
  worktreePath: '/projects/office',
  tabId: 'tab-1',
  title: '✳ 기능 담당',
  connected: false,
  executionHostId: 'local',
  ...over,
});
const orcaList = (result: unknown): TerminalHostDeps => ({
  bin: () => '/bin/orca',
  run: async () => JSON.stringify({ ok: true, result }),
});

test('Orca tab evidence: a sleeping tab is found; a partial list or two fitting tabs are unknown', async () => {
  const session = { ...claude, nativeTitle: true };
  const tab = await lookupOrcaTab(session, orcaList({ terminals: [tabRow()] }), true);
  assert.equal(tab.kind, 'found');
  assert.deepEqual(
    await lookupOrcaTab(session, orcaList({ terminals: [tabRow()], truncated: true }), true),
    unknown,
  );
  assert.deepEqual(
    await lookupOrcaTab(
      session,
      orcaList({ terminals: [tabRow(), tabRow({ handle: 'term_2', tabId: 'tab-2' })] }),
      true,
    ),
    unknown,
  );
  assert.deepEqual(
    await lookupOrcaTab(session, orcaList({ terminals: [tabRow({ title: '✳ other' })] }), true),
    none,
  );
});
