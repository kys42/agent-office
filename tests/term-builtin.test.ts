import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TermBuiltin, builtinSupported } from '../desktop/term-builtin.js';
import { TermHostClient, TermHostError, type ConnectOptions } from '../desktop/term-host/client.js';
import { FAKE_TOKEN, connectionPair, fakeTermHost } from '../desktop/term-host/fakes.js';
import {
  builtinDestination,
  builtinEnv,
  builtinPlan,
  type BuiltinDestinationDeps,
} from '../desktop/launch/destinations.js';
import { LaunchCore, type LaunchTarget } from '../desktop/launch/core.js';
import { PendingLaunches } from '../desktop/pending-launch.js';
import { LaunchQueue } from '../desktop/launch/pipeline.js';
import { TERM_HOST_PROTOCOL } from '../desktop/term-host/protocol.js';
import { setLocale } from '../src/shared/i18n/index.js';

/** The built-in terminal (#401): the app's side of the daemon, and its launch destination. */
process.env.AGENT_OFFICE_LOCALE = 'ko';
setLocale('ko');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A TermBuiltin over an in-memory daemon; `connects` counts connections made. */
function wired(options: Partial<ConstructorParameters<typeof TermBuiltin>[0]> = {}) {
  const t = fakeTermHost({ exitRetentionMs: 60_000 });
  let connects = 0;
  let spawned = 0;
  const builtin = new TermBuiltin({
    dataDir: '/nonexistent/agent-office-test',
    platform: 'darwin',
    socketExists: () => true,
    async connect(o: ConnectOptions) {
      connects++;
      if (o.daemon) spawned++;
      const [server, client] = connectionPair();
      t.host.handleConnection(server);
      const c = new TermHostClient(client);
      await c.hello(FAKE_TOKEN);
      return c;
    },
    ...options,
  });
  return {
    t,
    builtin,
    get connects() {
      return connects;
    },
    get spawned() {
      return spawned;
    },
  };
}

test('only macOS and Linux have a built-in terminal', () => {
  assert.equal(builtinSupported('darwin'), true);
  assert.equal(builtinSupported('linux'), true);
  assert.equal(builtinSupported('win32'), false);
});

test('with no socket a lookup answers "none" at once, connects nowhere, and is remembered', async () => {
  let now = 1000;
  let stats = 0;
  let connects = 0;
  const builtin = new TermBuiltin({
    dataDir: '/nonexistent/agent-office-test',
    platform: 'darwin',
    now: () => now,
    socketExists: () => (stats++, false),
    connect: async () => {
      connects++;
      throw new Error('never');
    },
  });
  const started = Date.now();
  assert.equal(await builtin.sessions(), null);
  assert.equal(await builtin.sessions(), null);
  assert.ok(Date.now() - started < 50);
  assert.equal(stats, 1, 'the second lookup within a second is the remembered answer');
  now += 1001;
  assert.equal(await builtin.sessions(), null);
  assert.equal(stats, 2);
  assert.equal(await builtin.sessions(true), null);
  assert.equal(stats, 3, 'a fresh lookup asks again');
  assert.equal(connects, 0);
  await assert.rejects(builtin.screen('x'), (e: unknown) => (e as TermHostError).absent);
  builtin.close();
});

test('a daemon that fails a lookup is remembered as failing for a second too', async () => {
  let now = 1000;
  let connects = 0;
  const builtin = new TermBuiltin({
    dataDir: '/nonexistent/agent-office-test',
    platform: 'darwin',
    now: () => now,
    socketExists: () => true,
    connect: async () => {
      connects++;
      throw new TermHostError('unavailable', 'terminal host did not answer');
    },
  });
  await assert.rejects(builtin.sessions(), /did not answer/);
  await assert.rejects(builtin.sessions(), /did not answer/);
  assert.equal(connects, 1);
  now += 1001;
  await assert.rejects(builtin.sessions(), /did not answer/);
  assert.equal(connects, 2);
  // A stale socket (refused): nothing runs, said as "none".
  const stale = new TermBuiltin({
    dataDir: '/nonexistent/agent-office-test',
    platform: 'darwin',
    socketExists: () => true,
    connect: async () => {
      throw new TermHostError('unavailable', 'no terminal host is running', true);
    },
  });
  assert.equal(await stale.sessions(), null);
  builtin.close();
  stale.close();
});

test('Windows looks nothing up', async () => {
  const builtin = new TermBuiltin({
    dataDir: '/nonexistent',
    platform: 'win32',
    socketExists: () => {
      throw new Error('never asked');
    },
  });
  assert.equal(await builtin.sessions(), null);
  await assert.rejects(builtin.create({ argv: ['/bin/sh'], cwd: '/', cols: 10, rows: 5 }));
});

test('a launch starts the daemon; lookups share one connection and see live sessions only', async () => {
  const w = wired();
  const created = await w.builtin.create({
    id: 'ao-1',
    argv: ['/bin/sh'],
    cwd: '/tmp',
    cols: 40,
    rows: 5,
  });
  assert.equal(created.id, 'ao-1');
  assert.equal(w.spawned, 1);
  await w.builtin.create({ id: 'ao-2', argv: ['/bin/sh'], cwd: '/tmp', cols: 40, rows: 5 });
  w.t.ptys[0].output('hello \x1b[2mhint\x1b[0m');
  const inventory = await w.builtin.sessions(true);
  assert.equal(inventory?.daemonPid, process.pid);
  assert.deepEqual(
    inventory?.sessions.map((s) => s.id),
    ['ao-1', 'ao-2'],
  );
  const screen = await w.builtin.screen('ao-1');
  assert.equal(screen.lines[0], 'hello hint');
  assert.deepEqual(screen.faint[0], [[6, 10]]);
  await w.builtin.write('ao-1', 'typed\r');
  await sleep(5);
  assert.equal(w.t.ptys[0].input, 'typed\r');
  w.t.ptys[1].exit(0);
  await sleep(40);
  assert.deepEqual(
    (await w.builtin.sessions(true))?.sessions.map((s) => s.id),
    ['ao-1'],
  );
  assert.equal(w.connects, 1, 'one control connection for all of it');
  w.t.ptys[0].exit(0);
  w.builtin.close();
  await w.t.host.shutdown();
});

test('the control connection closes when unused, so the daemon may exit; the next use reconnects', async () => {
  const w = wired({ idleMs: 20 });
  await w.builtin.create({ id: 'ao-1', argv: ['/bin/sh'], cwd: '/tmp', cols: 40, rows: 5 });
  await sleep(60);
  assert.equal(w.t.host.clients.size, 0);
  assert.equal((await w.builtin.sessions(true))?.sessions.length, 1);
  assert.equal(w.connects, 2);
  w.t.ptys[0].exit(0);
  w.builtin.close();
  await w.t.host.shutdown();
});

test('a daemon that stops answering makes a lookup fail in time, not hang', async () => {
  const [, end] = connectionPair();
  const silent = new TermHostClient(end);
  const builtin = new TermBuiltin({
    dataDir: '/nonexistent',
    platform: 'linux',
    socketExists: () => true,
    requestMs: 30,
    connect: async () => silent,
  });
  const started = Date.now();
  await assert.rejects(builtin.sessions(true), /did not answer/);
  assert.ok(Date.now() - started < 500);
  assert.equal(silent.closed, true, 'the stuck connection is dropped');
  builtin.close();
});

// The destination.

const NEW: LaunchTarget = {
  kind: 'new',
  provider: 'claude',
  cwd: '/work/proj',
  name: 'helper',
  initialMessage: 'hello\nthere',
  sessionId: '11111111-2222-4333-8444-555555555555',
};
const RESUME: LaunchTarget = {
  kind: 'resume',
  provider: 'claude',
  cwd: '/work/proj',
  nativeId: '6dfc48fb-f723-4025-aab6-eaa73f743e5b',
};

function destinationDeps(over: Partial<BuiltinDestinationDeps> = {}) {
  const created: unknown[] = [];
  let live = new Set<string>();
  const deps: BuiltinDestinationDeps = {
    platform: 'darwin',
    enabled: () => true,
    binary: async (name) => `/opt/bin/${name}`,
    version: async () => '2.1.300',
    directory: async () => true,
    env: { PATH: '/usr/bin', HOME: '/Users/me', CLAUDE_CONFIG_DIR: '/Users/me/.claude-alt' },
    newId: () => 'ao-test',
    wait: async () => {},
    terminals: {
      async create(spec) {
        created.push(spec);
        live.add(spec.id!);
        return { id: spec.id! } as never;
      },
      async sessions() {
        return { daemonPid: 1, sessions: [...live].map((id) => ({ id }) as never) };
      },
    },
    ...over,
  };
  return {
    deps,
    created,
    end: (id: string) => {
      live = new Set([...live].filter((x) => x !== id));
    },
  };
}

test('the environment: the app own, no inherited terminal, the agent home as read, the marker', () => {
  const env = builtinEnv(
    {
      PATH: '/usr/bin',
      TMUX: '/tmp/x,1,0',
      TMUX_PANE: '%1',
      CLAUDECODE: '1',
      ELECTRON_RUN_AS_NODE: '1',
      ORCA_TERMINAL_HANDLE: 'term_x',
      ORCA_TAB_ID: 'tab',
      CODEX_HOME: '/Users/me/.codex-alt',
      KEEP: 'yes',
    },
    '/opt/homebrew/bin/claude',
    'claude',
    'ao-1',
  );
  for (const gone of [
    'TMUX',
    'TMUX_PANE',
    'CLAUDECODE',
    'ELECTRON_RUN_AS_NODE',
    'ORCA_TERMINAL_HANDLE',
    'ORCA_TAB_ID',
    'CLAUDE_CONFIG_DIR',
  ])
    assert.equal(env[gone], undefined, gone);
  assert.equal(env.KEEP, 'yes');
  assert.equal(env.CODEX_HOME, '/Users/me/.codex-alt');
  assert.equal(env.PATH, '/opt/homebrew/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.AGENT_OFFICE_TERM_SESSION, 'ao-1');
  assert.equal(env.AGENT_OFFICE_TERM_HOST, String(TERM_HOST_PROTOCOL));
  assert.equal(
    builtinEnv({ CLAUDE_CONFIG_DIR: '/x/.claude' }, '/b/claude', 'claude', 'a').CLAUDE_CONFIG_DIR,
    '/x/.claude',
  );
  assert.throws(() => builtinEnv({ CLAUDE_CONFIG_DIR: 'relative' }, '/b/claude', 'claude', 'a'));
});

test('a plan runs the agent directly: its words, teammates in the same screen, the prompt after --', () => {
  const plan = builtinPlan(NEW, '/opt/bin/claude', '2.1.16', {}, 'ao-1');
  assert.deepEqual(plan.spec.argv, [
    '/opt/bin/claude',
    '--teammate-mode',
    'in-process',
    '--session-id',
    '11111111-2222-4333-8444-555555555555',
    '--',
    'hello\nthere',
  ]);
  assert.deepEqual(
    [plan.spec.id, plan.spec.cwd, plan.spec.cols, plan.spec.rows, plan.spec.scrollback],
    ['ao-1', '/work/proj', 200, 50, 200],
  );
  // An older CLI, or one of unknown version, never gets the option it would refuse.
  assert.deepEqual(builtinPlan(RESUME, '/opt/bin/claude', '2.1.15', {}, 'a').spec.argv, [
    '/opt/bin/claude',
    '--resume',
    RESUME.nativeId,
  ]);
  assert.deepEqual(
    builtinPlan({ ...RESUME, skipPermissions: true }, '/b/claude', undefined, {}, 'a').spec.argv,
    ['/b/claude', '--dangerously-skip-permissions', '--resume', RESUME.nativeId],
  );
  assert.deepEqual(
    builtinPlan(
      { ...RESUME, provider: 'codex', nativeId: '019a0000-0000-7000-8000-000000000000' },
      '/b/codex',
      '0.170.0',
      {},
      'a',
    ).spec.argv,
    ['/b/codex', 'resume', '019a0000-0000-7000-8000-000000000000'],
  );
  assert.equal(
    plan.command,
    `'/opt/bin/claude' '--teammate-mode' 'in-process' '--session-id' '11111111-2222-4333-8444-555555555555' '--' 'hello\nthere'`,
  );
});

test('the destination says why it cannot start: off, another platform, no CLI, no folder', async () => {
  const off = builtinDestination(destinationDeps({ enabled: () => false }).deps);
  assert.equal(off.offered?.(), false);
  assert.deepEqual(await off.probe(NEW, true), {
    available: false,
    reason: '설정에서 ‘내장 터미널(실험)’을 먼저 켜 주세요.',
  });
  const windows = builtinDestination(destinationDeps({ platform: 'win32' }).deps);
  assert.equal(windows.offered?.(), false);
  assert.equal((await windows.probe(NEW, true)).available, false);
  const noCli = builtinDestination(
    destinationDeps({
      binary: async () => {
        throw new Error('claude가 없어요');
      },
    }).deps,
  );
  assert.deepEqual(await noCli.probe(NEW, true), { available: false, reason: 'claude가 없어요' });
  const noFolder = builtinDestination(destinationDeps({ directory: async () => false }).deps);
  assert.equal((await noFolder.probe(NEW, true)).available, false);
});

test('a start creates the session from the probe; one gone at once never started', async () => {
  const { deps, created, end } = destinationDeps();
  const d = builtinDestination(deps);
  assert.equal(d.offered?.(), true);
  assert.equal(d.reserves, true);
  assert.equal(d.place, 'builtin');
  const probe = await d.probe(NEW, true);
  assert.equal(probe.available, true);
  const started = await d.start(NEW, { probe, hold: () => {} });
  assert.equal(started.state, 'launched');
  assert.equal(started.message, '내장 터미널에서 시작했어요.');
  const spec = created[0] as { id: string; argv: string[]; env: Record<string, string> };
  assert.equal(spec.id, 'ao-test');
  assert.equal(spec.env.AGENT_OFFICE_TERM_SESSION, 'ao-test');
  assert.equal(spec.env.CLAUDE_CONFIG_DIR, '/Users/me/.claude-alt');
  assert.ok(spec.argv.includes('--teammate-mode'));
  // It exited before the check.
  const gone = destinationDeps({ newId: () => 'ao-gone' });
  const original = gone.deps.terminals.create;
  gone.deps.terminals.create = async (s) => {
    const made = await original(s);
    gone.end(s.id!);
    return made;
  };
  const g = builtinDestination(gone.deps);
  await assert.rejects(
    g.start(NEW, { probe: await g.probe(NEW, true), hold: () => {} }),
    /시작하자마자 끝났어요/,
  );
});

test('a create cut off by a closed connection may have started: uncertain and held, never retried', async () => {
  let held = 0;
  const { deps } = destinationDeps({
    terminals: {
      create: async () => {
        throw new TermHostError('closed', 'terminal host connection closed');
      },
      sessions: async () => null,
    },
  });
  const d = builtinDestination(deps);
  const started = await d.start(NEW, { probe: await d.probe(NEW, true), hold: () => held++ });
  assert.equal(started.state, 'uncertain');
  assert.equal(held, 1);
  const refused = destinationDeps({
    terminals: {
      create: async () => {
        throw new TermHostError('spawn-failed', 'no such file');
      },
      sessions: async () => null,
    },
  });
  const r = builtinDestination(refused.deps);
  await assert.rejects(
    r.start(NEW, { probe: await r.probe(NEW, true), hold: () => {} }),
    /내장 터미널에서 시작하지 못했어요: no such file/,
  );
});

test('the core offers the built-in terminal only while it is on', async () => {
  let on = false;
  const { deps } = destinationDeps({ enabled: () => on });
  const core = new LaunchCore({
    destinations: { builtin: builtinDestination(deps) },
    pending: new PendingLaunches(),
    queue: new LaunchQueue(),
  });
  assert.deepEqual(
    (await core.options(NEW)).destinations.map((d) => d.id),
    [],
  );
  assert.deepEqual(core.support('darwin').opens, []);
  assert.equal(core.support('darwin').supported, false);
  on = true;
  const options = await core.options(NEW);
  assert.deepEqual(
    options.destinations.map((d) => [d.id, d.probe.available]),
    [['builtin', true]],
  );
  assert.equal(options.default, 'builtin');
  assert.equal(core.support('darwin').supported, true);
  assert.equal(core.support('win32').supported, false);
  const outcome = await core.start(NEW, 'builtin', { confirm: async () => true });
  assert.equal(outcome.state, 'launched');
  // Reserved like a Terminal window: a second start right away is cautioned.
  assert.equal((await core.guard(NEW)(true)).state, 'open');
});
