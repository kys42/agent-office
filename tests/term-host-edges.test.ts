// Boundaries of restore and delivery: half-written sequences, cursor modes, answer/output order,
// falling behind mid-snapshot, exits that race a view, and endpoint races.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import headless from '@xterm/headless';
import { EscapeTail } from '../desktop/term-host/escape-tail';
import { HeadlessScreen } from '../desktop/term-host/screen';
import { ModeTracker } from '../desktop/term-host/modes';
import {
  FrameDecoder,
  encodeData,
  encodeJson,
  restoreSequence,
} from '../desktop/term-host/protocol';
import { connectionPair, fakeTermHost } from '../desktop/term-host/fakes';
import { TermHostClient, TermHostError, connectTermHost } from '../desktop/term-host/client';
import { ensurePrivateDir, privateBindPath, publishSocket } from '../desktop/term-host/endpoint';

const { Terminal } = headless;
type View = InstanceType<typeof Terminal>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, what: string, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(5);
  }
}
const feed = (view: View, data: string | Uint8Array) =>
  new Promise<void>((r) => view.write(data, r));
const row = (view: View, y: number) =>
  view.buffer.active.getLine(view.buffer.active.viewportY + y)!.translateToString(true);
const bytes = (...b: number[]) => Uint8Array.from(b);

test('escape tail: keeps exactly the unfinished sequence or character', () => {
  const tail = (chunks: (string | Uint8Array)[]) => {
    const t = new EscapeTail();
    for (const c of chunks) t.push(typeof c === 'string' ? Buffer.from(c, 'latin1') : c);
    return t.pending().toString('latin1');
  };
  assert.equal(tail(['abc']), '');
  assert.equal(tail(['ab\x1b[3']), '\x1b[3');
  assert.equal(tail(['ab\x1b', '[3']), '\x1b[3');
  assert.equal(tail(['\x1b[31mX']), '');
  assert.equal(tail(['\x1b]0;tit', 'le']), '\x1b]0;title');
  assert.equal(tail(['\x1b]0;title\x07after']), '');
  assert.equal(tail(['\x1b]0;title\x1b', '\\']), '');
  // ESC inside a string ends it and starts a new escape.
  assert.equal(tail(['\x1b]0;t\x1b', '[1']), '\x1b[1');
  assert.equal(tail(['\x1b]0;t\x1b', '[1m']), '');
  assert.equal(tail(['\x1b[12\x18x']), '');
  assert.equal(tail([bytes(0x41, 0xed, 0x95)]), '\xed\x95');
  assert.equal(tail([bytes(0xed, 0x95), bytes(0x9c, 0x41)]), '');
  assert.equal(tail([bytes(0xed, 0x41)]), '');
  assert.equal(tail(['\x1b]52;c;' + 'A'.repeat(70_000)]), '', 'too long to keep');
});

test('a snapshot taken mid-sequence restores it: the next live bytes complete it', async () => {
  const fake = fakeTermHost();
  const { client } = await fake.connect();
  const output = new Map<string, Buffer[]>();
  client.onOutput((id, data) => output.set(id, [...(output.get(id) ?? []), data]));
  // One program stops inside an escape sequence, the other inside a UTF-8 character.
  const cases = [
    {
      id: 'esc',
      before: Buffer.from('plain \x1b[3'),
      after: Buffer.from('1mRED'),
      shown: 'plain RED',
    },
    { id: 'utf8', before: bytes(0x61, 0xed, 0x95), after: bytes(0x9c, 0x62), shown: 'a한b' },
  ];
  for (const [i, c] of cases.entries()) {
    await client.create({ id: c.id, argv: ['/bin/sh'], cwd: '/', cols: 40, rows: 5 });
    fake.ptys[i].output(c.before);
    const view = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
    await feed(view, restoreSequence(await client.attach(c.id)));
    fake.ptys[i].output(c.after);
    await waitFor(
      () => Buffer.concat(output.get(c.id) ?? []).includes(Buffer.from(c.after)),
      `${c.id} live output`,
    );
    for (const chunk of output.get(c.id)!) await feed(view, chunk);
    assert.equal(row(view, 0).trimEnd(), c.shown, c.id);
    if (c.id === 'esc') {
      const cell = view.buffer.active.getLine(view.buffer.active.viewportY)!.getCell(6)!;
      assert.equal(cell.getChars(), 'R');
      assert.equal(cell.isFgPalette() && cell.getFgColor(), 1);
    }
    view.dispose();
  }
});

test('origin mode and scroll margins restore with the cursor where it was', async () => {
  const screen = new HeadlessScreen(40, 10, 10);
  screen.write(Buffer.from('\x1b[3;8r\x1b[?6h\x1b[2;5HX'), 1);
  await new Promise<void>((r) => screen.whenParsed(r));
  const modes = screen.modes();
  assert.deepEqual(modes.scrollRegion, { top: 2, bottom: 7 });
  assert.deepEqual(modes.cursor, { x: 5, y: 3 });
  const view = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
  const tracker = new ModeTracker(view);
  await feed(view, restoreSequence(screen.snapshot()));
  assert.deepEqual(tracker.read(), modes);
  // Origin-relative addressing keeps working against the restored margins.
  await feed(view, 'Y\x1b[1;1HZ');
  assert.equal(row(view, 3).trimEnd(), '    XY');
  assert.equal(row(view, 2).trimEnd(), 'Z');
  view.dispose();
  screen.dispose();
});

test('the client hands over an attach answer before output that arrived with it', async () => {
  const [server, end] = connectionPair();
  const decoder = new FrameDecoder();
  server.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      const id = (frame as { message: { id: number } }).message.id;
      const answer = { snapshot: 'S', modes: '', cols: 80, rows: 24, session: {} };
      // One write: the answer, then output and an exit right behind it.
      server.write(
        Buffer.concat([
          encodeJson({ t: 'res', id, ok: true, result: answer }),
          encodeData('s', 'live'),
          encodeJson({
            t: 'ev',
            ev: 'exit',
            sessionId: 's',
            exit: { code: 0, signal: null, at: 0 },
          }),
        ]),
      );
    }
  });
  const client = new TermHostClient(end);
  const order: string[] = [];
  client.onOutput((_, data) => order.push(`output ${data}`));
  client.onExit(() => order.push('exit'));
  const result = await client.attach('s');
  order.push(`drew ${result.snapshot}`);
  await sleep(10);
  assert.deepEqual(order, ['drew S', 'output live', 'exit']);
});

test('falling behind while the snapshot is taken leads to a newer snapshot, not lost output', async () => {
  const fake = fakeTermHost({ maxLagBytes: 1024 });
  const { client } = await fake.connect();
  await client.create({ id: 'f', argv: ['/bin/sh'], cwd: '/', cols: 80, rows: 10 });
  const pty = fake.ptys[0];
  const session = fake.host.sessions.get('f')!;
  const capture = session.capture.bind(session);
  // More than the lag limit arrives after the snapshot point, before the snapshot is taken.
  session.capture = (attachment, scrollback, done) => {
    session.capture = capture;
    capture(attachment, scrollback, done);
    for (let i = 0; i < 40; i++) pty.output(`flood ${i} ${'x'.repeat(40)}\r\n`);
    pty.output('after the flood\r\n');
  };
  const resyncs: string[] = [];
  client.onResync((_, restore) => resyncs.push(restore.snapshot));
  const attached = await client.attach('f');
  assert.doesNotMatch(attached.snapshot, /after the flood/);
  await waitFor(() => resyncs.length === 1, 'a newer snapshot');
  assert.match(resyncs[0], /after the flood/);
});

test('a view that fell behind gets the last screen before the exit', async () => {
  const fake = fakeTermHost({ highWaterBytes: 256, maxLagBytes: 2048 });
  const { client, server } = await fake.connect();
  await client.create({ id: 'x', argv: ['/bin/sh'], cwd: '/', cols: 80, rows: 10 });
  await client.attach('x');
  const events: string[] = [];
  client.onResync((_, restore) => events.push(`snapshot:${/final words/.test(restore.snapshot)}`));
  client.onExit(() => events.push('exit'));
  server.stall();
  const pty = fake.ptys[0];
  for (let batch = 0; batch < 10; batch++) {
    for (let i = 0; i < 10; i++) pty.output(`line ${batch}-${i} ${'x'.repeat(40)}\r\n`);
    await sleep(2);
  }
  pty.output('final words\r\n');
  pty.exit(0);
  await sleep(60);
  server.resume();
  await waitFor(() => events.includes('exit'), 'exit');
  assert.deepEqual(events, ['snapshot:true', 'exit']);
});

test('attaching just after an exit waits for the last screen', async () => {
  const fake = fakeTermHost();
  const { client } = await fake.connect();
  await client.create({ id: 'e', argv: ['/bin/sh'], cwd: '/', cols: 80, rows: 10 });
  fake.ptys[0].output('goodbye\r\n');
  fake.ptys[0].exit(3);
  const late = await client.attach('e');
  assert.equal(late.exit?.code, 3);
  assert.match(late.snapshot, /goodbye/);
});

test('connect gives up on a listener that never answers hello', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'th-hello-'));
  try {
    const started = Date.now();
    await assert.rejects(
      connectTermHost({
        dataDir,
        timeoutMs: 300,
        deps: { connect: async () => connectionPair()[1] },
      }),
      (e: TermHostError) => e.code === 'unavailable',
    );
    assert.ok(Date.now() - started < 2_000);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

const listen = (p: string) =>
  new Promise<Server>((resolve, reject) => {
    const server = createServer((s) => s.end());
    server.once('error', reject);
    server.listen(p, () => resolve(server));
  });

test(
  'publication: two daemons replacing the same dead socket leave exactly one owner',
  { skip: process.platform === 'win32' && 'named pipes need no publication' },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'th-reclaim-'));
    const servers: Server[] = [];
    try {
      ensurePrivateDir(dir);
      const socket = path.join(dir, 'v1.sock');
      // A dead daemon's entry: published, then gone without removing it.
      const old = privateBindPath(socket);
      const dead = await listen(old);
      assert.equal((await publishSocket(old, socket)).status, 'published');
      await new Promise((r) => dead.close(r));
      // Both see it dead on both probes before either replaces it.
      let waiting: (() => void)[] = [];
      let calls = 0;
      const probe = async () => {
        if (++calls > 2) {
          await new Promise<void>((r) => {
            waiting.push(r);
            if (waiting.length === 2) {
              waiting.forEach((w) => w());
              waiting = [];
            }
          });
        }
        return 'refused' as const;
      };
      const binds = [privateBindPath(socket), privateBindPath(socket)];
      for (const bind of binds) servers.push(await listen(bind));
      const outcomes = await Promise.all(binds.map((b) => publishSocket(b, socket, probe, 50)));
      assert.deepEqual(outcomes.map((o) => o.status).sort(), ['lost', 'published']);
      const winner = outcomes.find((o) => o.status === 'published')!;
      const now = await stat(socket, { bigint: true });
      assert.equal(winner.status === 'published' && winner.identity?.ino, now.ino);
    } finally {
      for (const server of servers) server.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
