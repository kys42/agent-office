import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeadlessScreen } from '../desktop/term-host/screen';
import { fakeTermHost } from '../desktop/term-host/fakes';
import { TermHostError } from '../desktop/term-host/client';
import { TERM_HOST_PROTOCOL } from '../desktop/term-host/protocol';

/** The `screen` request (#401): what the app's composer reads of a built-in terminal. */

const parsed = (screen: HeadlessScreen) => new Promise<void>((r) => screen.whenParsed(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('protocol 2 knows the screen read', () => {
  assert.equal(TERM_HOST_PROTOCOL, 2);
});

test('a screen read gives the visible rows, trimmed, with faint ranges, cursor and title', async () => {
  const screen = new HeadlessScreen(20, 4, 10);
  screen.write(
    Buffer.from(
      '\x1b]0;✳ ao-io\x07' +
        'first   \r\n' +
        '❯ \x1b[2mtry this\x1b[0m  \r\n' +
        '한글\x1b[2m 끝\x1b[22m x\r\n' +
        '\x1b[2m   \x1b[0m',
    ),
    1,
  );
  await parsed(screen);
  const read = screen.read();
  assert.deepEqual(read.lines, ['first', '❯ try this', '한글 끝 x', '']);
  // Wide characters take one UTF-16 unit and two cells: the second cell adds nothing.
  assert.deepEqual(read.faint, [[], [[2, 10]], [[2, 4]], []]);
  assert.deepEqual(read.cursor, { x: 3, y: 3 });
  assert.equal(read.title, '✳ ao-io');
  assert.equal(read.alternate, false);
  assert.deepEqual([read.cols, read.rows], [20, 4]);
  screen.dispose();
});

test('a screen read shows the bottom of a scrolled screen and the alternate screen', async () => {
  const screen = new HeadlessScreen(10, 2, 10);
  screen.write(Buffer.from('a\r\nb\r\nc\r\nd'), 1);
  await parsed(screen);
  assert.deepEqual(screen.read().lines, ['c', 'd']);
  screen.write(Buffer.from('\x1b[?1049h\x1b[Hfull'), 2);
  await parsed(screen);
  const read = screen.read();
  assert.deepEqual(read.lines, ['full', '']);
  assert.equal(read.alternate, true);
  screen.dispose();
});

test('the screen request answers once earlier output is parsed; an ended session refuses', async () => {
  const t = fakeTermHost({ exitRetentionMs: 60_000 });
  const { client } = await t.connect();
  await client.create({ id: 's1', argv: ['/bin/sh'], cwd: '/', cols: 20, rows: 3 });
  t.ptys[0].output('\x1b]2;title\x07hello \x1b[2mhint');
  const read = await client.screen('s1');
  assert.deepEqual(read.lines, ['hello hint', '', '']);
  assert.deepEqual(read.faint[0], [[6, 10]]);
  assert.equal(read.title, 'title');
  await assert.rejects(
    client.screen('nope'),
    (e: unknown) => e instanceof TermHostError && e.code === 'unknown-session',
  );
  t.ptys[0].exit(0);
  await sleep(40);
  await assert.rejects(
    client.screen('s1'),
    (e: unknown) => e instanceof TermHostError && e.code === 'exited',
  );
  client.close();
  await t.host.shutdown();
});

test('a screen read waits for a synchronized frame to finish, up to the limit', async () => {
  const t = fakeTermHost({ syncWaitMs: 200 });
  const { client } = await t.connect();
  await client.create({ id: 's2', argv: ['/bin/sh'], cwd: '/', cols: 20, rows: 2 });
  t.ptys[0].output('\x1b[?2026hhalf');
  const pending = client.screen('s2');
  await sleep(20);
  t.ptys[0].output(' done\x1b[?2026l');
  assert.deepEqual((await pending).lines, ['half done', '']);
  t.ptys[0].exit(0);
  client.close();
  await t.host.shutdown();
});
