import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TermBuiltin } from '../desktop/term-builtin.js';
import { TermHostClient, type ConnectOptions } from '../desktop/term-host/client.js';
import { FAKE_TOKEN, connectionPair, fakeTermHost } from '../desktop/term-host/fakes.js';
import type { ListResult, SessionStats } from '../desktop/term-host/protocol.js';
import {
  builtinAction,
  builtinListing,
  officeAgentsIn,
  parseRss,
  psRss,
  type TermListDeps,
} from '../desktop/term-list.js';
import { formatBytes, parseBuiltinAction } from '../src/shared/term-list.js';

/** Settings › 내장 터미널: the list main builds for the page, and the actions on one session. */

const stats = (over: Partial<SessionStats>): SessionStats => ({
  id: 'ao-1',
  pid: 100,
  argv: ['/usr/local/bin/claude', '--resume', 'x'],
  cwd: '/work/app',
  cols: 200,
  rows: 50,
  createdAt: 1_000,
  scrollbackLines: 0,
  approxBytes: 0,
  bytesIn: 0,
  bytesOut: 0,
  bytesWritten: 0,
  droppedBytes: 0,
  attached: 0,
  ...over,
});

const list = (sessions: SessionStats[]): ListResult => ({
  daemon: { pid: 9, protocol: 2, startedAt: 500 },
  sessions,
  total: {
    sessions: sessions.length,
    live: sessions.filter((s) => !s.exit).length,
    clients: 1,
    scrollbackLines: 0,
    approxBytes: 0,
    bytesIn: 0,
    bytesOut: 0,
    rss: 72 * 1024 * 1024,
    heapUsed: 0,
    arrayBuffers: 0,
  },
});

const deps = (over: Partial<TermListDeps> = {}): TermListDeps => ({
  supported: true,
  listing: async () =>
    list([
      stats({ id: 'old', pid: 100, createdAt: 1_000 }),
      stats({ id: 'new', pid: 200, createdAt: 2_000, argv: ['/bin/codex'], cwd: '/work/b' }),
      stats({ id: 'gone', pid: 300, exit: { code: 0, signal: null, at: 3_000 } }),
    ]),
  hidden: () => false,
  windowOpen: (id) => id === 'new',
  agents: async () => new Map([['old', [{ id: 's1', name: '버터', provider: 'claude' }]]]),
  memory: async (pids) => new Map(pids.map((p) => [p, p * 1024])),
  ...over,
});

test('the list joins the daemon with windows, conversations and memory', async () => {
  let asked: number[] = [];
  const listing = await builtinListing(
    deps({
      memory: async (pids) => {
        asked = pids;
        return new Map(pids.map((p) => [p, p * 1024]));
      },
    }),
  );
  assert.equal(listing.supported, true);
  assert.equal(listing.hidden, false);
  assert.deepEqual(listing.daemon, {
    pid: 9,
    startedAt: 500,
    rss: 72 * 1024 * 1024,
    live: 2,
    sessions: 3,
  });
  // Running first (newest first), then ended ones.
  assert.deepEqual(
    listing.sessions.map((s) => s.id),
    ['new', 'old', 'gone'],
  );
  const [fresh, old, gone] = listing.sessions;
  assert.equal(fresh.program, 'codex');
  assert.equal(fresh.windowOpen, true);
  assert.equal(fresh.rss, 200 * 1024);
  assert.deepEqual(fresh.agents, []);
  assert.equal(old.program, 'claude', 'the program, never its arguments');
  assert.deepEqual(old.agents, [{ id: 's1', name: '버터', provider: 'claude' }]);
  assert.equal(old.windowOpen, false);
  assert.deepEqual(gone.exit, { code: 0, signal: null, at: 3_000 });
  assert.equal(gone.rss, undefined, 'an ended session holds no process');
  assert.deepEqual(asked, [100, 200], 'memory is read for live processes only');
});

test('hidden screen content keeps folders, programs and names out of the list', async () => {
  let located = false;
  const listing = await builtinListing(
    deps({
      hidden: () => true,
      agents: async () => {
        located = true;
        return new Map();
      },
    }),
  );
  assert.equal(listing.hidden, true);
  assert.equal(located, false, 'not even looked up');
  for (const row of listing.sessions) {
    assert.equal(row.cwd, '');
    assert.equal(row.program, '');
    assert.deepEqual(row.agents, []);
  }
  assert.equal(listing.sessions.length, 3, 'the sessions themselves still show');
});

test('hiding turned on while the lookups run still hides that answer', async () => {
  let hide = false;
  const listing = await builtinListing(
    deps({
      hidden: () => hide,
      agents: async () => {
        hide = true; // the person turns hiding on mid-request
        return new Map([['old', [{ id: 's1', name: '버터', provider: 'claude' }]]]);
      },
    }),
  );
  assert.equal(listing.hidden, true);
  for (const row of listing.sessions) {
    assert.equal(row.cwd, '');
    assert.equal(row.program, '');
    assert.deepEqual(row.agents, []);
  }
});

test('no daemon, an unanswering daemon and an unsupported platform each say so', async () => {
  assert.deepEqual(await builtinListing(deps({ listing: async () => null })), {
    supported: true,
    daemon: null,
    sessions: [],
    hidden: false,
  });
  const failed = await builtinListing(
    deps({
      listing: async () => {
        throw new Error('terminal host did not answer');
      },
    }),
  );
  assert.equal(failed.daemon, null);
  assert.equal(failed.error, 'terminal host did not answer');
  let asked = false;
  const windows = await builtinListing(
    deps({
      supported: false,
      listing: async () => {
        asked = true;
        return null;
      },
    }),
  );
  assert.equal(windows.supported, false);
  assert.equal(asked, false);
});

test('a failing name or memory lookup still lists the sessions', async () => {
  const listing = await builtinListing(
    deps({
      agents: async () => {
        throw new Error('ps failed');
      },
      memory: async () => {
        throw new Error('ps failed');
      },
    }),
  );
  assert.equal(listing.sessions.length, 3);
  assert.ok(listing.sessions.every((s) => s.rss === undefined && s.agents.length === 0));
});

test('conversations are matched to sessions through each provider lookup only', async () => {
  const calls: string[] = [];
  const found = await officeAgentsIn(
    [
      { id: 'ao-1', cwd: '/work/app' },
      { id: 'ao-2', cwd: '/work/b' },
    ],
    [
      {
        id: 's1',
        provider: 'claude',
        nativeId: 'c1',
        cwd: '/work/app',
        title: 'T1',
        alias: '버터',
        updatedAt: 3,
      },
      { id: 's2', provider: 'codex', nativeId: 'x1', cwd: '/work/b/', title: 'T2', updatedAt: 2 },
      // Elsewhere, remote, or a provider without a lookup: never asked.
      { id: 's3', provider: 'claude', nativeId: 'c3', cwd: '/other', title: 'T3', updatedAt: 9 },
      {
        id: 's4',
        provider: 'claude',
        nativeId: 'c4',
        cwd: '/work/app',
        remote: { peer: 'p' },
        title: 'T4',
        updatedAt: 9,
      },
      {
        id: 's5',
        provider: 'openclaw',
        nativeId: 'o5',
        cwd: '/work/app',
        title: 'T5',
        updatedAt: 9,
      },
      // In the folder but in tmux.
      { id: 's6', provider: 'claude', nativeId: 'c6', cwd: '/work/app', title: 'T6', updatedAt: 1 },
    ],
    {
      claude: async (id) => {
        calls.push(id);
        return id === 'c1'
          ? { host: { kind: 'builtin', session: 'ao-1' } }
          : { host: { kind: 'tmux' } };
      },
      codex: async (id) => {
        calls.push(id);
        return { host: { kind: 'builtin', session: 'ao-2' } };
      },
    },
  );
  assert.deepEqual(calls, ['c1', 'x1', 'c6']);
  assert.deepEqual(found.get('ao-1'), [{ id: 's1', name: '버터', provider: 'claude' }]);
  assert.deepEqual(found.get('ao-2'), [{ id: 's2', name: 'T2', provider: 'codex' }]);
});

test('a session outside the list or a failing lookup is never matched', async () => {
  const found = await officeAgentsIn(
    [{ id: 'ao-1', cwd: '/w' }],
    [
      { id: 'a', provider: 'claude', nativeId: 'a', cwd: '/w', title: 'A', updatedAt: 2 },
      { id: 'b', provider: 'claude', nativeId: 'b', cwd: '/w', title: 'B', updatedAt: 1 },
    ],
    {
      claude: async (id) => {
        if (id === 'a') throw new Error('gone');
        return { host: { kind: 'builtin', session: 'other' } };
      },
    },
  );
  assert.equal(found.size, 0);
});

test('memory comes from one ps call, even when some process just ended', async () => {
  assert.deepEqual(
    parseRss('  100  2048\n 200 10\njunk\n'),
    new Map([
      [100, 2048 * 1024],
      [200, 10 * 1024],
    ]),
  );
  const runs: [string, string[]][] = [];
  const read = psRss(async (file, args) => {
    runs.push([file, args]);
    // ps exits 1 when a pid is gone, with what it printed for the others.
    throw Object.assign(new Error('exit 1'), { stdout: '100 4\n' });
  });
  assert.deepEqual(await read([100, 0, -1, 200]), new Map([[100, 4096]]));
  assert.deepEqual(runs, [['/bin/ps', ['-o', 'pid=,rss=', '-p', '100,200']]]);
  assert.deepEqual(await read([]), new Map());
  assert.equal(runs.length, 1, 'nothing to read: no call');
});

test('actions: open shows, hide closes only the window, kill asks first', async () => {
  const done: string[] = [];
  const app = {
    show: async (id: string) => done.push(`show:${id}`),
    hide: (id: string) => (done.push(`hide:${id}`), id === 'open'),
    kill: async (id: string) => (done.push(`kill:${id}`), false),
  };
  assert.equal(await builtinAction(app, 'ao-1', 'open'), true);
  assert.equal(await builtinAction(app, 'open', 'hide'), true);
  assert.equal(await builtinAction(app, 'shut', 'hide'), false);
  assert.equal(await builtinAction(app, 'ao-1', 'kill'), false, 'cancelled in the dialog');
  assert.deepEqual(done, ['show:ao-1', 'hide:open', 'hide:shut', 'kill:ao-1']);
  await assert.rejects(
    builtinAction({ ...app, show: async () => Promise.reject(new Error('gone')) }, 'x', 'open'),
    /gone/,
  );
});

test('an action request names a valid session and a known action, nothing else', () => {
  assert.deepEqual(parseBuiltinAction('ao-1', 'kill'), { session: 'ao-1', action: 'kill' });
  assert.deepEqual(parseBuiltinAction('a.b_c-1', 'open'), { session: 'a.b_c-1', action: 'open' });
  assert.throws(() => parseBuiltinAction('../x', 'open'), /bad session/);
  assert.throws(() => parseBuiltinAction('', 'open'), /bad session/);
  assert.throws(() => parseBuiltinAction(42, 'open'), /bad session/);
  assert.throws(() => parseBuiltinAction('x'.repeat(65), 'open'), /bad session/);
  assert.throws(() => parseBuiltinAction('ao-1', 'shutdown'), /bad action/);
  assert.throws(() => parseBuiltinAction('ao-1', undefined), /bad action/);
});

test('sizes read like a list of processes', () => {
  assert.equal(formatBytes(undefined), '');
  assert.equal(formatBytes(512), '1 KB');
  assert.equal(formatBytes(300 * 1024), '300 KB');
  assert.equal(formatBytes(5.25 * 1024 * 1024), '5.3 MB');
  assert.equal(formatBytes(214 * 1024 * 1024), '214 MB');
  assert.equal(formatBytes(1.5 * 1024 * 1024 * 1024), '1.5 GB');
});

test('the daemon list keeps ended sessions; the lookups still see live ones only', async () => {
  const t = fakeTermHost({ exitRetentionMs: 60_000 });
  const builtin = new TermBuiltin({
    dataDir: '/nonexistent/agent-office-test',
    platform: 'darwin',
    socketExists: () => true,
    cacheMs: 0,
    async connect(_o: ConnectOptions) {
      const [server, client] = connectionPair();
      t.host.handleConnection(server);
      const c = new TermHostClient(client);
      await c.hello(FAKE_TOKEN);
      return c;
    },
  });
  await builtin.create({ id: 'one', argv: ['/bin/sh'], cwd: '/tmp', cols: 80, rows: 24 });
  await builtin.create({ id: 'two', argv: ['/bin/sh'], cwd: '/tmp', cols: 80, rows: 24 });
  t.ptys[0].exit(0);
  await new Promise((r) => setTimeout(r, 20));
  const all = await builtin.listing(true);
  assert.deepEqual(all?.sessions.map((s) => [s.id, !!s.exit]).sort(), [
    ['one', true],
    ['two', false],
  ]);
  assert.ok(all!.total.rss > 0);
  const live = await builtin.sessions(true);
  assert.deepEqual(
    live?.sessions.map((s) => s.id),
    ['two'],
  );
  builtin.close();
  await t.host.shutdown();
});
