import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TermBuiltin } from '../desktop/term-builtin.js';
import { TermHostClient, type ConnectOptions } from '../desktop/term-host/client.js';
import { FAKE_TOKEN, connectionPair, fakeTermHost } from '../desktop/term-host/fakes.js';
import type { ListResult, SessionStats } from '../desktop/term-host/protocol.js';
import {
  builtinAction,
  builtinListing,
  managerPreviews,
  managerSelect,
  officeAgentsIn,
  parseRss,
  psRss,
  rowActions,
  type TermListDeps,
  type TermManagerDeps,
} from '../desktop/term-list.js';
import {
  BUILTIN_OPEN_IN,
  formatBytes,
  managerKey,
  managerRows,
  outputMoved,
  parseBuiltinAction,
  parseManagerSession,
  parsePreviewRequest,
  previewLines,
  previewTargets,
  stepSelection,
  TERM_MANAGER_ENDED_MAX,
  TERM_MANAGER_PREVIEW_COLS,
  TERM_MANAGER_PREVIEW_MAX,
  type BuiltinSessionRow,
} from '../src/shared/term-list.js';

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
  assert.deepEqual(found.get('ao-1'), [
    {
      id: 's1',
      name: '버터',
      provider: 'claude',
      alias: '버터',
      title: 'T1',
      project: { key: '/work/app', name: 'app' },
      updatedAt: 3,
    },
  ]);
  assert.deepEqual(found.get('ao-2'), [
    {
      id: 's2',
      name: 'T2',
      provider: 'codex',
      title: 'T2',
      project: { key: '/work/b/', name: 'b' },
      updatedAt: 2,
    },
  ]);
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

// ─── The terminal manager (터미널 관리 창) ──────────────────────────────────────────────────

const row = (over: Partial<BuiltinSessionRow>): BuiltinSessionRow => ({
  id: 'ao-1',
  program: 'claude',
  cwd: '/work/app',
  agents: [],
  startedAt: 1_000,
  pid: 100,
  windowOpen: false,
  attached: 0,
  ...over,
});

const managerDeps = (over: Partial<TermManagerDeps> = {}): TermManagerDeps => ({
  hidden: () => false,
  listing: async () =>
    list([
      stats({ id: 'ao-1', cwd: '/work/app' }),
      stats({ id: 'ao-2', argv: ['/bin/codex'], cwd: '/work/b' }),
      stats({ id: 'done', exit: { code: 0, signal: null, at: 3_000 } }),
    ]),
  screen: async (id) => ({ lines: [`${id} top`, '', `${id} prompt ❯`, ''], cursor: { y: 2 } }),
  messages: { hidden: 'HIDDEN', gone: 'GONE' },
  ...over,
});

test('the list carries each session output count for the busy hint', async () => {
  const listing = await builtinListing(
    deps({ listing: async () => list([stats({ id: 'a', bytesIn: 512 })]) }),
  );
  assert.equal(listing.sessions[0].output, 512);
  assert.equal(outputMoved(undefined, row({ output: 10 })), false, 'unknown before: quiet');
  assert.equal(outputMoved(row({ output: 10 }), row({ output: 10 })), false);
  assert.equal(outputMoved(row({ output: 10 }), row({ output: 11 })), true);
  assert.equal(
    outputMoved(row({ output: 10 }), row({ output: 99, exit: { code: 0, signal: null, at: 1 } })),
    false,
    'an ended session is never busy',
  );
});

test('the manager lists every running session and only the latest few ended ones', () => {
  const ended = Array.from({ length: 6 }, (_, i) =>
    row({ id: `e${i}`, exit: { code: 0, signal: null, at: 100 - i } }),
  );
  const listing = {
    supported: true,
    hidden: false,
    daemon: null,
    sessions: [row({ id: 'r1' }), row({ id: 'r2' }), ...ended],
  };
  assert.deepEqual(
    managerRows(listing).map((r) => r.id),
    ['r1', 'r2', 'e0', 'e1', 'e2'],
  );
  assert.equal(TERM_MANAGER_ENDED_MAX, 3);
  assert.deepEqual(managerRows(null), []);
});

test('previews: the running others only, a few at most, none while hidden', () => {
  const rows = [
    ...Array.from({ length: 12 }, (_, i) => row({ id: `r${i}` })),
    row({ id: 'x', exit: { code: 0, signal: null, at: 1 } }),
  ];
  const targets = previewTargets(rows, 'r0', false);
  assert.equal(targets.length, TERM_MANAGER_PREVIEW_MAX);
  assert.ok(!targets.includes('r0'), 'the selected one has a live view instead');
  assert.ok(!targets.includes('x'), 'an ended one has no screen to read');
  assert.deepEqual(previewTargets(rows, 'r0', true), []);
});

test('a preview is the last non-blank rows up to the cursor, cleaned and cut', () => {
  assert.deepEqual(
    previewLines({
      lines: ['one', '   ', 'two\x07', 'three  ', 'four', 'below the cursor'],
      cursor: { y: 4 },
    }),
    ['two', 'three', 'four'],
  );
  assert.deepEqual(previewLines({ lines: ['x'.repeat(500)], cursor: { y: 0 } }), [
    'x'.repeat(TERM_MANAGER_PREVIEW_COLS),
  ]);
  assert.deepEqual(previewLines({ lines: ['', ''], cursor: { y: 1 } }), []);
});

test('the manager selects only a session the daemon lists, never while hidden', async () => {
  assert.deepEqual(await managerSelect(managerDeps(), 'ao-2'), {
    session: 'ao-2',
    title: 'codex · b',
    cwd: '/work/b',
  });
  // An ended one still shows its last screen.
  assert.equal((await managerSelect(managerDeps(), 'done')).session, 'done');
  await assert.rejects(managerSelect(managerDeps(), 'nope'), /GONE/);
  await assert.rejects(managerSelect(managerDeps(), '../etc'), /bad session/);
  await assert.rejects(managerSelect(managerDeps(), 42), /bad session/);
  await assert.rejects(managerSelect(managerDeps({ hidden: () => true }), 'ao-1'), /HIDDEN/);
  // Hidden while the list was read: nothing about it is answered.
  let hidden = false;
  const late = managerDeps({
    hidden: () => hidden,
    listing: async () => {
      hidden = true;
      return list([stats({ id: 'ao-1' })]);
    },
  });
  await assert.rejects(managerSelect(late, 'ao-1'), /HIDDEN/);
  await assert.rejects(managerSelect(managerDeps({ listing: async () => null }), 'ao-1'), /GONE/);
});

test('previews read running sessions only, and nothing while hidden', async () => {
  const read: string[] = [];
  const deps = managerDeps({
    screen: async (id) => {
      read.push(id);
      if (id === 'ao-2') throw new Error('timeout');
      return { lines: ['$ ls', 'a  b'], cursor: { y: 1 } };
    },
  });
  assert.deepEqual(await managerPreviews(deps, ['ao-1', 'ao-2', 'done', 'gone', 'ao-1']), {
    'ao-1': { lines: ['$ ls', 'a  b'] },
  });
  assert.deepEqual(read.sort(), ['ao-1', 'ao-2'], 'ended or unknown sessions are never read');
  read.length = 0;
  assert.deepEqual(await managerPreviews(managerDeps({ hidden: () => true }), ['ao-1']), {});
  // Hidden while the screens were read: dropped.
  let hidden = false;
  const late = managerDeps({
    hidden: () => hidden,
    screen: async () => {
      hidden = true;
      return { lines: ['secret'], cursor: { y: 0 } };
    },
  });
  assert.deepEqual(await managerPreviews(late, ['ao-1']), {});
  assert.deepEqual(await managerPreviews(managerDeps(), []), {});
  await assert.rejects(managerPreviews(managerDeps(), 'ao-1'));
  await assert.rejects(managerPreviews(managerDeps(), ['ok', '../x']));
  await assert.rejects(
    managerPreviews(
      managerDeps(),
      Array.from({ length: TERM_MANAGER_PREVIEW_MAX + 1 }, (_, i) => `s${i}`),
    ),
  );
});

test('the manager keys: ⌘1…⌘9, ⌘⇧[ ], ⌃Tab, ⌘W; everything else is the terminal’s', () => {
  const key = (over: Partial<Parameters<typeof managerKey>[0]>) =>
    managerKey({
      type: 'keydown',
      key: '',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...over,
    });
  assert.deepEqual(key({ metaKey: true, key: '1', code: 'Digit1' }), { select: 0 });
  assert.deepEqual(key({ metaKey: true, key: '9', code: 'Digit9' }), { select: 8 });
  assert.equal(key({ metaKey: true, key: '0', code: 'Digit0' }), null, '⌘0 is the font reset');
  assert.deepEqual(key({ metaKey: true, shiftKey: true, key: '{', code: 'BracketLeft' }), {
    step: -1,
  });
  assert.deepEqual(key({ metaKey: true, shiftKey: true, key: '}', code: 'BracketRight' }), {
    step: 1,
  });
  assert.deepEqual(key({ ctrlKey: true, key: 'Tab' }), { step: 1 });
  assert.deepEqual(key({ ctrlKey: true, shiftKey: true, key: 'Tab' }), { step: -1 });
  assert.deepEqual(key({ metaKey: true, key: 'w', code: 'KeyW' }), { close: true });
  assert.equal(key({ key: '1', code: 'Digit1' }), null);
  assert.equal(key({ ctrlKey: true, key: 'c', code: 'KeyC' }), null);
  assert.equal(key({ metaKey: true, key: 'c', code: 'KeyC' }), null);
  assert.equal(key({ metaKey: true, altKey: true, key: '1', code: 'Digit1' }), null);
  assert.equal(key({ metaKey: true, key: '1', code: 'Digit1', isComposing: true }), null);
  assert.equal(key({ type: 'keyup', metaKey: true, key: '1', code: 'Digit1' }), null);
});

test('stepping wraps around the rows; with none selected it starts at the first', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(stepSelection(rows, 'a', 1), 'b');
  assert.equal(stepSelection(rows, 'c', 1), 'a');
  assert.equal(stepSelection(rows, 'a', -1), 'c');
  assert.equal(stepSelection(rows, null, 1), 'a');
  assert.equal(stepSelection([], 'a', 1), null);
});

test('manager sessions and the open-in choice are checked', () => {
  assert.equal(parseManagerSession('ao-1'), 'ao-1');
  for (const bad of ['', '../x', 'a b', 1, null, 'x'.repeat(65)])
    assert.throws(() => parseManagerSession(bad));
  assert.deepEqual([...BUILTIN_OPEN_IN], ['manager', 'window']);
  assert.deepEqual(parsePreviewRequest(['a', 'a', 'b']), ['a', 'b']);
});

test('a row opens, hides and reports the same window: its own, not the manager', async () => {
  const open = new Set<string>();
  const calls: string[] = [];
  const windows = {
    open: async (id: string) => {
      calls.push(`open:${id}`);
      open.add(id);
    },
    close: (id: string) => open.delete(id),
    has: (id: string) => open.has(id),
  };
  const actions = rowActions(windows, async (id) => {
    calls.push(`kill:${id}`);
    return true;
  });
  const listing = () =>
    builtinListing(deps({ windowOpen: windows.has, listing: async () => list([stats({})]) }));
  assert.equal((await listing()).sessions[0].windowOpen, false);
  assert.equal(await builtinAction(actions, 'ao-1', 'open'), true);
  assert.equal((await listing()).sessions[0].windowOpen, true, 'opened shows as open');
  assert.equal(await builtinAction(actions, 'ao-1', 'hide'), true, 'and can be hidden again');
  assert.equal((await listing()).sessions[0].windowOpen, false);
  assert.equal(await builtinAction(actions, 'ao-1', 'hide'), false);
  assert.equal(await builtinAction(actions, 'ao-1', 'kill'), true);
  assert.deepEqual(calls, ['open:ao-1', 'kill:ao-1']);
});
