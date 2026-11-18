import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TermViews, type TermViewSink } from '../desktop/term-views.js';
import { TermHostClient } from '../desktop/term-host/client.js';
import { FAKE_TOKEN, connectionPair, fakeTermHost } from '../desktop/term-host/fakes.js';
import {
  nudgeSizes,
  parseTermCommand,
  validTermInput,
  wantsAttach,
} from '../src/shared/term-view.js';

/** The built-in terminal's views (#401): attach, nudge, stream, detach, one connection each. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VIEW = '00000000-0000-4000-8000-000000000001';

function setup() {
  const t = fakeTermHost({ exitRetentionMs: 60_000 });
  let n = 0;
  const servers: ReturnType<typeof connectionPair>[0][] = [];
  const views = new TermViews({
    async connect() {
      const [server, client] = connectionPair();
      servers.push(server);
      t.host.handleConnection(server);
      const c = new TermHostClient(client);
      await c.hello(FAKE_TOKEN);
      return c;
    },
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  const seen: { data: string[]; resync: string[]; exits: number; lost: string[] } = {
    data: [],
    resync: [],
    exits: 0,
    lost: [],
  };
  const sink: TermViewSink = {
    data: (_id, d) => void seen.data.push(Buffer.from(d).toString('utf8')),
    resync: (_id, r) => void seen.resync.push(r),
    exit: () => void seen.exits++,
    lost: (id) => void seen.lost.push(id),
  };
  return { t, views, seen, sink, servers };
}

async function session(t: ReturnType<typeof fakeTermHost>, id: string, cols = 80, rows = 24) {
  const { client } = await t.connect();
  await client.create({ id, argv: ['/bin/sh'], cwd: '/', cols, rows });
  client.close();
  return t.ptys.at(-1)!;
}

test('the commands a terminal window may send, and nothing else', () => {
  assert.deepEqual(parseTermCommand({ type: 'attach', cols: 9999, rows: 1 }), {
    type: 'attach',
    cols: 400,
    rows: 3,
  });
  assert.deepEqual(parseTermCommand({ type: 'detach', viewId: VIEW }), {
    type: 'detach',
    viewId: VIEW,
  });
  assert.deepEqual(parseTermCommand({ type: 'flow', viewId: VIEW, paused: true }), {
    type: 'flow',
    viewId: VIEW,
    paused: true,
  });
  assert.deepEqual(parseTermCommand({ type: 'kill', session: 'other' }), { type: 'kill' });
  for (const bad of [
    null,
    [],
    { type: 'attach', session: 'x' }, // a size is required; a session is never read from it
    { type: 'detach', viewId: 'nope' },
    { type: 'flow', viewId: VIEW, paused: 'yes' },
    { type: 'create', argv: ['/bin/sh'] },
  ])
    assert.throws(() => parseTermCommand(bad));
  assert.equal(validTermInput(VIEW, 'ls\r'), true);
  assert.equal(validTermInput(VIEW, ''), false);
  assert.equal(validTermInput('x', 'a'), false);
  assert.equal(validTermInput(VIEW, 'a'.repeat(64 * 1024 + 1)), false);
});

test('the size is nudged once so the program draws again', () => {
  assert.deepEqual(nudgeSizes({ cols: 80, rows: 24 }, { cols: 100, rows: 30 }), [
    { cols: 100, rows: 30 },
  ]);
  assert.deepEqual(nudgeSizes({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }), [
    { cols: 80, rows: 23 },
    { cols: 80, rows: 24 },
  ]);
  assert.deepEqual(nudgeSizes({ cols: 80, rows: 1 }, { cols: 80, rows: 1 })[0].rows, 1);
});

test('a view attaches only while mounted, shown and not ended', () => {
  assert.equal(wantsAttach({ mounted: true, visible: true, ended: false }), true);
  assert.equal(wantsAttach({ mounted: true, visible: false, ended: false }), false);
  assert.equal(wantsAttach({ mounted: false, visible: true, ended: false }), false);
  assert.equal(wantsAttach({ mounted: true, visible: true, ended: true }), false);
});

test('attach: the screen as it is, a nudge, then live output and keys', async () => {
  const { t, views, seen, sink } = setup();
  const pty = await session(t, 'ao-1');
  pty.output('before\r\n');
  const a = await views.attach(7, 'ao-1', { cols: 80, rows: 24 }, sink);
  assert.match(a.restore, /before/);
  assert.deepEqual([a.cols, a.rows, a.exited], [80, 24, undefined]);
  await sleep(10);
  // Same size: one row smaller and back, so the program repaints.
  assert.deepEqual(pty.sizes, [
    [80, 23],
    [80, 24],
  ]);
  pty.output('live');
  await sleep(10);
  assert.deepEqual(seen.data, ['live']);
  views.write(7, a.viewId, 'typed\r');
  views.write(8, a.viewId, 'not yours');
  await sleep(5);
  assert.equal(pty.input, 'typed\r');
  views.resize(7, a.viewId, 100, 30);
  await sleep(5);
  assert.deepEqual(pty.sizes.at(-1), [100, 30]);
  assert.equal(t.host.sessions.get('ao-1')!.attachments.size, 1);
  views.detach(7, a.viewId);
  await sleep(5);
  // Detached: the daemon sends it nothing more; the session runs on.
  assert.equal(t.host.sessions.get('ao-1')!.attachments.size, 0);
  pty.output('unseen');
  await sleep(10);
  assert.deepEqual(seen.data, ['live']);
  assert.equal(t.host.sessions.get('ao-1')!.live, true);
  pty.exit(0);
  await t.host.shutdown();
});

test('a view of another size resizes the session once; two views keep their own streams', async () => {
  const { t, views, sink } = setup();
  const pty = await session(t, 'ao-2');
  const other: string[] = [];
  const a = await views.attach(1, 'ao-2', { cols: 120, rows: 40 }, sink);
  const b = await views.attach(
    2,
    'ao-2',
    { cols: 120, rows: 40 },
    {
      data: (_i, d) => void other.push(Buffer.from(d).toString()),
      resync() {},
      exit() {},
      lost() {},
    },
  );
  assert.notEqual(a.viewId, b.viewId);
  await sleep(10);
  assert.deepEqual(pty.sizes[0], [120, 40]);
  assert.equal(t.host.sessions.get('ao-2')!.attachments.size, 2);
  pty.output('both');
  await sleep(10);
  assert.deepEqual(other, ['both']);
  // A window that closes or reloads leaves: its views end, the others stay.
  views.detachOwner(1);
  await sleep(5);
  assert.equal(t.host.sessions.get('ao-2')!.attachments.size, 1);
  assert.equal(views.count, 1);
  pty.exit(0);
  await t.host.shutdown();
});

test('an ended session shows its last screen; an exit while attached ends the view', async () => {
  const { t, views, seen, sink } = setup();
  const pty = await session(t, 'ao-3');
  const a = await views.attach(1, 'ao-3', { cols: 80, rows: 24 }, sink);
  pty.output('bye\r\n');
  pty.exit(3);
  await sleep(60);
  assert.equal(seen.exits, 1);
  assert.equal(views.count, 0);
  const late = await views.attach(1, 'ao-3', { cols: 80, rows: 24 }, sink);
  assert.deepEqual(late.exited, { code: 3, signal: null });
  assert.match(late.restore, /bye/);
  assert.equal(views.count, 0);
  assert.notEqual(a.viewId, late.viewId);
  await t.host.shutdown();
});

test('a window that left while attaching gets nothing attached', async () => {
  const { t, views, sink } = setup();
  const pty = await session(t, 'ao-4');
  const since = views.epoch(5);
  views.detachOwner(5);
  await assert.rejects(views.attach(5, 'ao-4', { cols: 80, rows: 24 }, sink, since));
  await sleep(5);
  assert.equal(t.host.sessions.get('ao-4')!.attachments.size, 0);
  await assert.rejects(views.attach(5, 'nope', { cols: 80, rows: 24 }, sink), /no session/);
  views.dispose();
  pty.exit(0);
  await t.host.shutdown();
});

test('a view behind its screen pauses reading its own connection only', async () => {
  const paused: boolean[] = [];
  const [, end] = connectionPair();
  const fake = Object.assign(end, {
    pause: () => void paused.push(true),
    resume: () => void paused.push(false),
  });
  const client = new TermHostClient(fake);
  client.pauseReading(true);
  client.pauseReading(false);
  assert.deepEqual(paused, [true, false]);
  // A connection that cannot pause (the in-memory fake) is left alone.
  const [, plain] = connectionPair();
  new TermHostClient(plain).pauseReading(true);
});

test('a view whose connection drops (the daemon stopped) is told; its own end is not', async () => {
  const { t, views, seen, sink, servers } = setup();
  const pty = await session(t, 'ao-5');
  const a = await views.attach(1, 'ao-5', { cols: 80, rows: 24 }, sink);
  const b = await views.attach(1, 'ao-5', { cols: 80, rows: 24 }, sink);
  views.detach(1, b.viewId);
  await sleep(10);
  assert.deepEqual(seen.lost, []);
  servers[0].destroy();
  await sleep(10);
  assert.deepEqual(seen.lost, [a.viewId]);
  assert.equal(views.count, 0);
  // Gone: keys to it go nowhere, nothing throws.
  views.write(1, a.viewId, 'x');
  pty.exit(0);
  await t.host.shutdown();
});

test('a view is destroyed, not ended, when it goes: a paused one never keeps the daemon waiting', async () => {
  const t = fakeTermHost({ exitRetentionMs: 60_000 });
  const pty = await session(t, 'ao-6');
  const calls: string[] = [];
  const views = new TermViews({
    async connect() {
      const [server, client] = connectionPair();
      t.host.handleConnection(server);
      const end = Object.assign(client, {
        pause: () => void calls.push('pause'),
        resume: () => void calls.push('resume'),
      });
      const destroy = end.destroy.bind(end);
      end.destroy = () => (calls.push('destroy'), destroy());
      const c = new TermHostClient(end);
      await c.hello(FAKE_TOKEN);
      return c;
    },
  });
  const a = await views.attach(
    1,
    'ao-6',
    { cols: 80, rows: 24 },
    {
      data() {},
      resync() {},
      exit() {},
      lost() {},
    },
  );
  views.flow(1, a.viewId, true);
  views.detach(1, a.viewId);
  await sleep(10);
  assert.deepEqual(calls, ['pause', 'destroy']);
  assert.equal(t.host.sessions.get('ao-6')!.attachments.size, 0);
  pty.exit(0);
  await t.host.shutdown();
});
