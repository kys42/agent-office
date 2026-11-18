import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import headless from '@xterm/headless';
import {
  FrameDecoder,
  FrameError,
  TERM_HOST_PROTOCOL,
  encodeData,
  encodeJson,
  restoreSequence,
  type Frame,
} from '../desktop/term-host/protocol';
import { HeadlessScreen } from '../desktop/term-host/screen';
import { ModeTracker, modeSequences } from '../desktop/term-host/modes';
import { FAKE_TOKEN, fakeTermHost, type FakeConnection } from '../desktop/term-host/fakes';
import { TermHostError, connectTermHost } from '../desktop/term-host/client';
import {
  ensurePrivateDir,
  privateBindPath,
  publishSocket,
  readOrCreateToken,
  termHostPaths,
} from '../desktop/term-host/endpoint';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, what: string, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(5);
  }
}
const { Terminal } = headless;
const write = (t: InstanceType<typeof Terminal>, data: string) =>
  new Promise<void>((r) => t.write(data, r));
const screenText = async (restore: { snapshot: string; modes: string }) => {
  const t = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
  await write(t, restoreSequence(restore));
  const lines: string[] = [];
  const buffer = t.buffer.active;
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)!.translateToString(true));
  t.dispose();
  return lines.join('\n');
};

test('frames survive any chunking and carry arbitrary bytes', () => {
  const bytes = Buffer.from([0, 0xff, 0x1b, 0x0a, 0xc3, 0x28, 0x80]);
  const wire = Buffer.concat([
    encodeJson({ t: 'req', id: 1, op: 'list', text: '한글 \x1b[0m' }),
    encodeData('s-1', bytes),
    encodeData('s-2', ''),
    encodeJson({ t: 'ev', ev: 'exit' }),
  ]);
  for (const step of [1, 2, 5, 7, wire.length]) {
    const decoder = new FrameDecoder();
    const frames: Frame[] = [];
    for (let i = 0; i < wire.length; i += step)
      frames.push(...decoder.push(wire.subarray(i, i + step)));
    assert.equal(frames.length, 4, `step ${step}`);
    assert.deepEqual(frames[0], {
      kind: 'json',
      message: { t: 'req', id: 1, op: 'list', text: '한글 \x1b[0m' },
    });
    assert.equal(frames[1].kind, 'data');
    assert.deepEqual(frames[1].kind === 'data' && [frames[1].sessionId, [...frames[1].data]], [
      's-1',
      [...bytes],
    ]);
    assert.equal(frames[2].kind === 'data' && frames[2].data.length, 0);
    assert.equal(decoder.buffered, 0);
  }
});

test('the frame reader refuses bad kinds, oversized lengths and malformed bodies', () => {
  const header = (kind: number, length: number) => {
    const b = Buffer.alloc(5);
    b[0] = kind;
    b.writeUInt32BE(length, 1);
    return b;
  };
  // Refused from the header alone: the body is never buffered.
  assert.throws(() => new FrameDecoder(100).push(header(1, 101)), FrameError);
  assert.throws(() => new FrameDecoder().push(header(9, 1)), FrameError);
  assert.throws(() => new FrameDecoder().push(Buffer.concat([header(1, 3), Buffer.from('{x}')])));
  assert.throws(() => new FrameDecoder().push(Buffer.concat([header(2, 1), Buffer.from([0])])));
  assert.throws(() => new FrameDecoder().push(Buffer.concat([header(2, 2), Buffer.from([5, 1])])));
});

/** Speaks raw frames to the host and collects what comes back. */
function rawPeer(client: FakeConnection) {
  const decoder = new FrameDecoder();
  const frames: Frame[] = [];
  let closed = false;
  client.on('data', (chunk: Buffer) => frames.push(...decoder.push(chunk)));
  client.on('close', () => (closed = true));
  return {
    frames,
    get closed() {
      return closed;
    },
    send: (message: unknown) => client.write(encodeJson(message)),
  };
}

test('hello: a wrong token, a wrong protocol or anything else first is refused and closed', async () => {
  const fake = fakeTermHost({ helloTimeoutMs: 30 });
  const cases = [
    { op: 'hello', protocol: TERM_HOST_PROTOCOL, token: 'nope', code: 'auth' },
    { op: 'hello', protocol: TERM_HOST_PROTOCOL + 1, token: FAKE_TOKEN, code: 'version' },
    { op: 'list', code: 'auth' },
  ];
  for (const { code, ...request } of cases) {
    const peer = rawPeer(fake.open().client);
    peer.send({ t: 'req', id: 7, ...request });
    await waitFor(() => peer.closed, `closed after ${request.op}`);
    const reply = peer.frames[0];
    assert.equal(reply.kind === 'json' && (reply.message as any).error.code, code);
  }
  // Output for a session id before hello: dropped without an answer.
  const early = fake.open();
  const peer = rawPeer(early.client);
  early.client.write(encodeData('x', 'ls\r'));
  await waitFor(() => peer.closed, 'closed after data');
  // A large frame before hello is refused from its header.
  const big = fake.open();
  const bigPeer = rawPeer(big.client);
  big.client.write(encodeJson({ t: 'req', id: 1, op: 'hello', pad: 'x'.repeat(10_000) }));
  await waitFor(() => bigPeer.closed, 'closed after a large frame');
  // Silence: dropped after the hello timeout.
  const silent = rawPeer(fake.open().client);
  await waitFor(() => silent.closed, 'closed after the hello timeout');
  // The right token works.
  const { client } = await fake.connect();
  assert.equal((await client.list()).sessions.length, 0);
  assert.equal(fake.host.clients.size, 1);
});

test('mode tracking follows split sequences and a fresh view restores the same modes', async () => {
  const screen = new HeadlessScreen(80, 10, 100);
  const chunks = [
    'prompt$ \x1b[?20',
    '04h\x1b[?1004h\x1b[?1h\x1b[?1002;10',
    '06h\x1b[?25l\x1b[>1u\x1b[>5u',
    '\x1b[?1049h\x1b[>3u\x1b[=1;2u',
    'full screen app',
  ];
  chunks.forEach((chunk, i) => screen.write(chunk, i + 1));
  await new Promise<void>((r) => screen.whenParsed(r));
  const modes = screen.modes();
  assert.equal(modes.bracketedPaste, true);
  assert.equal(modes.focusEvents, true);
  assert.equal(modes.applicationCursorKeys, true);
  assert.equal(modes.mouseTracking, 'drag');
  assert.equal(modes.mouseEncoding, 'sgr');
  assert.equal(modes.cursorVisible, false);
  assert.equal(modes.alternateScreen, true);
  // The alternate screen has its own kitty stack: 3, then OR 1.
  assert.equal(modes.kittyKeyboardFlags, 3);

  const restore = screen.snapshot();
  assert.match(restore.modes, /\x1b\[\?1;1004;2004;1002;1006h/);
  assert.match(restore.modes, /\x1b\[\?25l/);
  assert.deepEqual(modes.kittyStacks, { normal: [1, 5], alternate: [3] });
  assert.match(restore.modes, /\x1b\[>3u$/);
  // The normal screen's stack is rebuilt before the snapshot switches to the alternate screen.
  assert.match(restore.snapshot, /\x1b\[>1u\x1b\[>5u\x1b\[\?1049h/);
  const view = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
  const tracker = new ModeTracker(view);
  await write(view, restoreSequence(restore));
  assert.deepEqual(tracker.read(), modes);
  assert.equal(view.buffer.active.type, 'alternate');
  assert.match(view.buffer.active.getLine(0)!.translateToString(true), /full screen app/);
  view.dispose();

  // Leaving the alternate screen returns to the normal screen's kitty flags (5); RIS resets all.
  screen.write('\x1b[?1049l', 10);
  await new Promise<void>((r) => screen.whenParsed(r));
  assert.equal(screen.modes().kittyKeyboardFlags, 5);
  screen.write('\x1b[<2u', 11);
  await new Promise<void>((r) => screen.whenParsed(r));
  assert.equal(screen.modes().kittyKeyboardFlags, 0);
  screen.write('\x1b[?2004h\x1b[?1006h\x1b[?25l\x1bc', 12);
  await new Promise<void>((r) => screen.whenParsed(r));
  assert.equal(modeSequences(screen.modes()), '');
  screen.dispose();
  assert.equal(screen.approxBytes, 0);
});

test('attach sends the screen, then only output that came after it', async () => {
  const fake = fakeTermHost();
  const { client } = await fake.connect();
  const output: string[] = [];
  client.onOutput((_, data) => output.push(data.toString()));
  const created = await client.create({
    id: 'one',
    argv: ['/bin/sh'],
    cwd: '/',
    cols: 80,
    rows: 10,
  });
  assert.equal(created.id, 'one');
  const pty = fake.ptys[0];
  assert.deepEqual([pty.file, pty.options.cols], ['/bin/sh', 80]);
  pty.output('before attach\r\n');
  // Output that arrives while the snapshot is being taken is forwarded, not lost or doubled.
  const session = fake.host.sessions.get('one')!;
  const capture = session.capture.bind(session);
  session.capture = (attachment, scrollback, done) => {
    capture(attachment, scrollback, done);
    pty.output('racing\r\n');
  };
  const attached = await client.attach('one');
  session.capture = capture;
  pty.output('after\r\n');
  await waitFor(() => output.join('').includes('after'), 'live output');
  const restored = await screenText(attached);
  assert.match(restored, /before attach/);
  assert.doesNotMatch(restored, /racing/);
  assert.match(output.join(''), /^racing\r\nafter/);
  assert.equal(attached.session.attached, 1);

  client.write('one', 'echo hi\r');
  await client.resize('one', 100, 20);
  await waitFor(() => pty.written.length > 0, 'input');
  assert.equal(pty.input, 'echo hi\r');
  assert.deepEqual(pty.sizes, [[100, 20]]);
  const listed = (await client.list()).sessions[0];
  assert.equal(listed.cols, 100);
  assert.equal(listed.bytesWritten, 8);
});

test('attach waits (briefly) for a synchronized update to finish its frame', async () => {
  const fake = fakeTermHost({ syncWaitMs: 500 });
  const { client } = await fake.connect();
  const output: string[] = [];
  client.onOutput((_, data) => output.push(data.toString()));
  await client.create({ id: 'tui', argv: ['/bin/sh'], cwd: '/', cols: 80, rows: 10 });
  const pty = fake.ptys[0];
  pty.output('\x1b[?2026h\x1b[2J\x1b[Hhalf of a frame');
  const attaching = client.attach('tui');
  await sleep(30);
  pty.output(' and the rest\x1b[?2026l');
  const attached = await attaching;
  assert.match(await screenText(attached), /half of a frame and the rest/);
  await sleep(20);
  assert.equal(output.join(''), '');
});

test('nothing is forwarded to a client that is not attached', async () => {
  const fake = fakeTermHost();
  const { client } = await fake.connect();
  const output: Buffer[] = [];
  client.onOutput((_, data) => output.push(data));
  await client.create({ id: 'bg', argv: ['/bin/sh'], cwd: '/', cols: 80, rows: 10 });
  fake.ptys[0].output('working in the background\r\n');
  await sleep(20);
  assert.equal(output.length, 0);
  const first = await client.attach('bg');
  assert.match(await screenText(first), /working in the background/);
  await client.detach('bg');
  fake.ptys[0].output('still working\r\n');
  await sleep(20);
  assert.equal(output.length, 0);
  const stats = (await client.list()).sessions[0];
  assert.equal(stats.bytesOut, 0);
  assert.ok(stats.bytesIn > 40);
  assert.equal(stats.attached, 0);
  assert.match(await screenText(await client.attach('bg')), /still working/);
});

test('a client that falls too far behind gets a fresh snapshot instead of the backlog', async () => {
  const fake = fakeTermHost({ highWaterBytes: 256, maxLagBytes: 2048 });
  const { client, server } = await fake.connect();
  await client.create({ id: 'flood', argv: ['/bin/sh'], cwd: '/', cols: 80, rows: 10 });
  await client.attach('flood');
  const output: string[] = [];
  const resyncs: string[] = [];
  let resumed = false;
  client.onOutput((_, data) => output.push(data.toString()));
  client.onResync((_, restore) => {
    assert.ok(resumed, 'the snapshot waits for the socket to drain');
    resyncs.push(restore.snapshot);
  });
  server.stall();
  const pty = fake.ptys[0];
  for (let batch = 0; batch < 20; batch++) {
    for (let i = 0; i < 10; i++) pty.output(`line ${batch}-${i} ${'x'.repeat(40)}\r\n`);
    await sleep(2);
  }
  pty.output('last line\r\n');
  await sleep(20);
  assert.ok(server.writableLength < 2048, 'output stopped at the high-water mark');
  resumed = true;
  server.resume();
  await waitFor(() => resyncs.length === 1, 'resync snapshot');
  assert.match(resyncs[0], /last line/);
  pty.output('live again\r\n');
  await waitFor(() => output.join('').includes('live again'), 'output after the resync');
  const stats = (await client.list()).sessions[0];
  assert.ok(stats.bytesOut < stats.bytesIn / 4, `${stats.bytesOut} of ${stats.bytesIn} forwarded`);
});

test('idle: exits only with no session and no client, after retained exits expire', async () => {
  const fake = fakeTermHost({ idleMs: 30, exitRetentionMs: 60 });
  await waitFor(() => fake.idleExits === 1, 'idle exit with nothing at all');

  const busy = fakeTermHost({ idleMs: 30, exitRetentionMs: 60 });
  const { client } = await busy.connect();
  await client.create({ id: 's', argv: ['/bin/sh'], cwd: '/', cols: 80, rows: 10 });
  client.close();
  await sleep(80);
  assert.equal(busy.idleExits, 0, 'a live session keeps the daemon');
  busy.ptys[0].exit(0);
  await sleep(50);
  assert.equal(busy.idleExits, 0, 'a retained exit keeps it a little longer');
  await waitFor(() => busy.idleExits === 1, 'idle exit after the retention');
  assert.equal(busy.host.sessions.size, 0);
});

test('kill ends the process group, frees the screen, and a late attach still learns the exit', async () => {
  const fake = fakeTermHost({ killGraceMs: 40 });
  const { client } = await fake.connect();
  const other = (await fake.connect()).client;
  const exits: [string, number | null][] = [];
  other.onExit((id, exit) => exits.push([id, exit.code]));
  await client.create({ id: 'k', argv: ['/bin/sh'], cwd: '/', cols: 80, rows: 10 });
  const pty = fake.ptys[0];
  pty.output('last words\r\n');
  assert.deepEqual(await client.kill('k'), { killed: true });
  assert.deepEqual(fake.groupSignals, [[pty.pid, 'SIGHUP']]);
  // The program ignores the hangup: SIGKILL to the group after the grace period.
  await waitFor(() => fake.groupSignals.length === 2, 'escalation');
  assert.deepEqual(fake.groupSignals[1], [pty.pid, 'SIGKILL']);
  pty.exit(0, 9);
  await waitFor(() => exits.length === 1, 'exit event');
  assert.deepEqual(exits, [['k', null]]);
  // Swept once more after the leader died, for anything it left in the group.
  assert.deepEqual(fake.groupSignals.at(-1), [pty.pid, 'SIGKILL']);
  const late = await client.attach('k');
  assert.equal(late.exit?.signal, 9);
  assert.match(await screenText(late), /last words/);
  const stats = (await client.list()).sessions[0];
  assert.equal(stats.approxBytes, 0);
  assert.deepEqual(await client.kill('k'), { killed: false });
  await assert.rejects(client.resize('k', 10, 10), (e: TermHostError) => e.code === 'exited');
});

test('shutdown ends every live session and every client', async () => {
  const fake = fakeTermHost({ killGraceMs: 30 });
  const { client } = await fake.connect();
  await client.create({ id: 'a', argv: ['/bin/sh'], cwd: '/', cols: 80, rows: 10 });
  await client.create({ id: 'b', argv: ['/bin/sh'], cwd: '/', cols: 80, rows: 10 });
  const closed = new Promise<void>((r) => client.onClose(r));
  setTimeout(() => fake.ptys.forEach((p) => p.exit(0, 1)), 10);
  await client.shutdown();
  await closed;
  assert.deepEqual(
    fake.groupSignals.filter(([, s]) => s === 'SIGHUP').map(([pid]) => pid),
    fake.ptys.map((p) => p.pid),
  );
  assert.equal(fake.idleExits, 1);
});

test('create validates its input and refuses duplicates', async () => {
  const fake = fakeTermHost();
  const { client } = await fake.connect();
  const base = { argv: ['/bin/sh'], cwd: '/', cols: 80, rows: 10 };
  for (const spec of [
    { ...base, argv: [] },
    { ...base, cwd: 'relative' },
    { ...base, cols: 0 },
    { ...base, id: 'bad id' },
    { ...base, env: { A: 1 } },
    { ...base, scrollback: 1e9 },
  ]) {
    await assert.rejects(
      client.create(spec as never),
      (e: TermHostError) => e.code === 'bad-request',
    );
  }
  await client.create({ ...base, id: 'dup', env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' } });
  await assert.rejects(
    client.create({ ...base, id: 'dup' }),
    (e: TermHostError) => e.code === 'exists',
  );
  assert.deepEqual(fake.ptys[0].options.env, { PATH: '/bin' });
});

test('connect-or-spawn starts one daemon and retries until it answers', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'th-connect-'));
  try {
    const dir = path.join(dataDir, 'term-host');
    ensurePrivateDir(dir);
    await writeFile(path.join(dir, 'token'), FAKE_TOKEN, { mode: 0o600 });
    const fake = fakeTermHost();
    let attempts = 0;
    const spawned: string[][] = [];
    let now = 0;
    const client = await connectTermHost({
      dataDir,
      daemon: { execPath: '/app', args: ['term-host.cjs'] },
      daemonOptions: { idleMs: 5 },
      deps: {
        // Nothing listens for the first attempts: the daemon is still starting.
        connect: async () => {
          if (++attempts < 6) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
          return fake.open().client;
        },
        spawnDaemon: (command, flags) => void spawned.push([command.execPath, ...flags]),
        sleep: async (ms) => void (now += ms),
        now: () => now,
      },
    });
    assert.equal(attempts, 6);
    assert.deepEqual(spawned, [['/app', '--idle-ms', '5']]);
    assert.equal((await client.list()).total.clients, 1);
    client.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('connect creates a private directory and token, and refuses a wrong token', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'th-connect-'));
  try {
    const fake = fakeTermHost();
    await assert.rejects(
      connectTermHost({ dataDir, deps: { connect: async () => fake.open().client } }),
      (e: TermHostError) => e.code === 'auth',
    );
    const dir = path.join(dataDir, 'term-host');
    if (process.platform !== 'win32') {
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(dir, 'token'))).mode & 0o777, 0o600);
    }
    assert.match(readOrCreateToken(path.join(dir, 'token')), /^[0-9a-f]{64}$/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('connect without a daemon command does not start one', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'th-connect-'));
  try {
    await assert.rejects(
      connectTermHost({
        dataDir,
        deps: {
          connect: async () => {
            throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
          },
        },
      }),
      (e: TermHostError) => e.code === 'unavailable',
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('paths: versioned socket, short fallback for long data dirs, per-user pipe on Windows', () => {
  const short = termHostPaths('/Users/me/Library/Application Support/Agent Office', 'darwin', 501);
  assert.equal(
    short.socket,
    `/Users/me/Library/Application Support/Agent Office/term-host/v${TERM_HOST_PROTOCOL}.sock`,
  );
  const long = termHostPaths(`/Users/${'x'.repeat(120)}`, 'darwin', 501);
  assert.match(
    long.socket,
    new RegExp(`^/tmp/agent-office-term-host-501/[0-9a-f]{12}/v${TERM_HOST_PROTOCOL}\\.sock$`),
  );
  assert.equal(long.token, `/Users/${'x'.repeat(120)}/term-host/token`);
  const win = termHostPaths('C:\\Users\\me\\AppData\\Roaming\\Agent Office', 'win32');
  assert.match(win.socket, /^\\\\\.\\pipe\\agent-office-term-host-v1-[0-9a-f]{16}$/);
});

test('token: created once with 0600 and shared by every caller', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'th-token-'));
  try {
    const file = path.join(dir, 'token');
    const tokens = Array.from({ length: 5 }, () => readOrCreateToken(file));
    assert.equal(new Set(tokens).size, 1);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await writeFile(file, 'short');
    assert.notEqual(readOrCreateToken(file), tokens[0], 'a malformed token is not trusted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const listen = (p: string) =>
  new Promise<Server>((resolve, reject) => {
    const server = createServer((s) => s.end());
    server.once('error', reject);
    server.listen(p, () => resolve(server));
  });

test(
  'publication: one of two racing daemons wins; a dead socket is replaced; unclear evidence leaves it',
  { skip: process.platform === 'win32' && 'named pipes need no publication' },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'th-pub-'));
    const servers: Server[] = [];
    try {
      ensurePrivateDir(dir);
      const socket = path.join(dir, 'v1.sock');
      const binds = [privateBindPath(socket), privateBindPath(socket)];
      for (const bind of binds) servers.push(await listen(bind));
      const outcomes = await Promise.all(binds.map((bind) => publishSocket(bind, socket)));
      assert.deepEqual(outcomes.map((o) => o.status).sort(), ['occupied', 'published']);

      // The winner goes away; close() only unlinks its private bind name, so the public name
      // stays behind as a dead entry, and the next daemon replaces it.
      const winner = servers[outcomes.findIndex((o) => o.status === 'published')];
      await new Promise((r) => winner.close(r));
      await stat(socket);
      const next = privateBindPath(socket);
      servers.push(await listen(next));
      assert.equal((await publishSocket(next, socket)).status, 'published');
      const live = (await stat(socket, { bigint: true })).ino;

      // A probe that proves nothing never replaces anything.
      const third = privateBindPath(socket);
      servers.push(await listen(third));
      assert.equal(
        (await publishSocket(third, socket, async () => 'unknown')).status,
        'inconclusive',
      );
      assert.equal((await stat(socket, { bigint: true })).ino, live);
      assert.equal((await publishSocket(third, socket)).status, 'occupied');
    } finally {
      for (const server of servers) server.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('a client turns a closed connection into failed requests', async () => {
  const fake = fakeTermHost();
  const { client, server } = await fake.connect();
  const pending = client.list();
  server.destroy();
  await assert.rejects(pending, (e: TermHostError) => e.code === 'closed');
  assert.throws(() => client.write('x', 'y'), TermHostError);
});
