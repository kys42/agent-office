// The bookmark reader's own window in the real app, on a temp profile and data: bookmark a
// message → "read" opens a window beside the big office → the same bookmark again brings it
// forward (one window), another bookmark opens a second one stepped aside → the reader reads
// only through its own narrow IPC → "open in office" shows the big office at that message →
// removing the bookmark empties the reader → hiding the screen content closes the readers.
// `npm run build && npm run test:reader:desktop`
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { quietEnv } from './quiet-smoke.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'agent-office-reader-'));
const claude = path.join(temp, 'claude');
const data = path.join(temp, 'data');
const shots = process.env.AGENT_OFFICE_SMOKE_SHOTS;
const now = Date.now();
const at = (s) => new Date(now - 60_000 + s * 1000).toISOString();
await mkdir(path.join(claude, 'projects', 'demo'), { recursive: true });
await writeFile(
  path.join(claude, 'projects', 'demo', 'reader.jsonl'),
  [
    {
      type: 'user',
      sessionId: 'reader-smoke',
      timestamp: at(0),
      cwd: temp,
      message: { role: 'user', content: '캐시 정책을 정해 줘' },
    },
    {
      type: 'assistant',
      sessionId: 'reader-smoke',
      timestamp: at(1),
      message: {
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'text', text: '결정: 캐시는 5분으로 둡니다.' }],
        stop_reason: 'end_turn',
      },
    },
    {
      type: 'user',
      sessionId: 'reader-smoke',
      timestamp: at(2),
      message: { role: 'user', content: '배포도 확인해 줘' },
    },
    {
      type: 'assistant',
      sessionId: 'reader-smoke',
      timestamp: at(3),
      message: {
        id: 'm2',
        role: 'assistant',
        content: [{ type: 'text', text: '배포 확인했어요.' }],
        stop_reason: 'end_turn',
      },
    },
  ]
    .map((x) => JSON.stringify(x))
    .join('\n') + '\n',
);
const isReader = (p) => p.url().endsWith('#reader');
const readers = (app) =>
  app.evaluate(({ BrowserWindow, screen }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed())
      .map((w) => ({
        url: w.webContents.getURL(),
        bounds: w.getBounds(),
        visible: w.isVisible(),
        area: screen.getDisplayMatching(w.getBounds()).workArea,
      })),
  );
let app;
try {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(temp, 'profile')}`],
    env: {
      ...process.env,
      ...quietEnv,
      AGENT_OFFICE_DATA_DIR: data,
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: path.join(temp, 'codex'),
      OPENCLAW_STATE_DIR: path.join(temp, 'openclaw'),
    },
  });
  const page = await app.firstWindow();
  const guide = page.getByRole('button', { name: /^(Explore on my own|직접 둘러볼게요)$/ });
  await guide.click({ timeout: 5000 }).catch(() => {});
  // Two bookmarks of the colleague's replies.
  const marks = await page.evaluate(async () => {
    let s;
    for (let i = 0; i < 100 && !s; i++) {
      s = (await window.office.snapshot()).sessions.find((x) => x.nativeId === 'reader-smoke');
      if (!s) await new Promise((r) => setTimeout(r, 100));
    }
    if (!s) throw new Error('session not collected');
    const detail = await window.office.detail(s.id);
    const replies = detail.events.filter((e) => e.kind === 'assistant');
    const one = await window.office.bookmark(s.id, replies[0].id, '메모 하나');
    const two = await window.office.bookmark(s.id, replies[1].id);
    return { session: s.id, one: one.bookmark, two: two.bookmark };
  });
  const open = async (id) => {
    const opened = app.waitForEvent('window', { predicate: isReader, timeout: 15000 });
    await page.evaluate((id) => window.office.bookmarkWindow('open', { id }), id);
    return opened;
  };
  const reader = await open(marks.one.id);
  await reader.locator('.bookmark-reader').waitFor({ timeout: 15000 });
  assert.match(await reader.locator('.bookmark-reader').innerText(), /캐시는 5분으로/);
  assert.match(await reader.locator('.bookmark-reader').innerText(), /메모 하나/);
  // Only the id went to the window.
  assert.ok(!reader.url().includes('캐시'));
  let all = await readers(app);
  const main = all.find((w) => !w.url.includes('#'));
  const [first] = all.filter((w) => w.url.endsWith('#reader'));
  assert.ok(first.visible, 'the reader is shown');
  const { bounds: r, area } = first;
  assert.ok(
    r.x >= area.x &&
      r.y >= area.y &&
      r.x + r.width <= area.x + area.width &&
      r.y + r.height <= area.y + area.height,
    'inside the work area',
  );
  const m = main.bounds;
  const edge = Math.abs(r.x + r.width - (Math.min(m.x + m.width, area.x + area.width) - 8)) <= 1;
  assert.ok(r.x >= m.x + m.width || r.x + r.width <= m.x || edge, 'beside the big office');
  if (shots) await reader.screenshot({ path: path.join(shots, 'reader-window.png') });
  // The same bookmark again: the same window. Another one: a second, stepped aside.
  await page.evaluate((id) => window.office.bookmarkWindow('open', { id }), marks.one.id);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await readers(app)).filter((w) => w.url.endsWith('#reader')).length, 1);
  const second = await open(marks.two.id);
  await second.locator('.bookmark-reader').waitFor({ timeout: 15000 });
  all = (await readers(app)).filter((w) => w.url.endsWith('#reader'));
  assert.equal(all.length, 2);
  assert.ok(
    Math.abs(all[0].bounds.x - all[1].bounds.x) >= 24 ||
      Math.abs(all[0].bounds.y - all[1].bounds.y) >= 24,
    'the second reader steps aside',
  );
  // A reader asks the service only for the office and its bookmark.
  assert.equal(
    await reader.evaluate((id) => window.office.bookmarkById(id).then((b) => b.id), marks.one.id),
    marks.one.id,
  );
  await assert.rejects(reader.evaluate(() => window.office.bookmarks()));
  await assert.rejects(
    reader.evaluate((id) => window.office.patch(id, { pinned: true }), marks.session),
  );
  await assert.rejects(reader.evaluate(() => window.office.preferences({ privacy: false })));
  // The big office is not a reader: it cannot read a reader's target or "go" for it.
  await assert.rejects(page.evaluate(() => window.office.bookmarkWindow('target')));
  await assert.rejects(page.evaluate(() => window.office.bookmarkWindow('go')));
  // Its own on-top toggle: opened from the big office it is an ordinary window; the header sets
  // it on top and back. Only a reader sets its own.
  await assert.rejects(page.evaluate(() => window.office.bookmarkWindow('top-on')));
  const readerWindow = await app.browserWindow(reader);
  const toggle = reader.locator('.reader-window-bar .on-top-toggle');
  const pressed = (v) =>
    reader.waitForFunction(
      (v) =>
        document
          .querySelector('.reader-window-bar .on-top-toggle')
          ?.getAttribute('aria-pressed') === v,
      v,
    );
  await pressed('false');
  assert.equal(await reader.evaluate(() => window.office.bookmarkWindow('top')), false);
  await toggle.click();
  await pressed('true');
  assert.equal(await reader.evaluate(() => window.office.bookmarkWindow('top')), true);
  assert.equal(await readerWindow.evaluate((w) => w.isAlwaysOnTop()), true);
  // The other reader is left alone.
  assert.equal(await second.evaluate(() => window.office.bookmarkWindow('top')), false);
  await toggle.click();
  await pressed('false');
  assert.equal(await readerWindow.evaluate((w) => w.isAlwaysOnTop()), false);
  // Open in office: the big office selects that colleague.
  await reader
    .getByRole('button', { name: /^(Open original conversation|원문 대화로 이동)$/ })
    .click();
  await page.locator('.inspector-card').waitFor({ timeout: 10000 });
  // A resize is remembered for the next reader (its own file).
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('#reader'));
    w.setSize(600, 500);
  });
  let saved;
  for (let i = 0; i < 30 && !saved; i++) {
    await new Promise((r) => setTimeout(r, 100));
    saved = await readFile(path.join(data, 'reader-window-size.json'), 'utf8').catch(() => null);
  }
  assert.deepEqual(JSON.parse(saved), { width: 600, height: 500 });
  // Removed elsewhere: the reader says it is gone.
  await page.evaluate((id) => window.office.unbookmark(id), marks.two.id);
  await second.locator('.reader-window-body .empty-state').waitFor({ timeout: 10000 });
  // Hiding the screen content closes the readers and opens none.
  const closed = Promise.all([reader.waitForEvent('close'), second.waitForEvent('close')]);
  await page.evaluate(() => window.office.preferences({ privacy: true }));
  await closed;
  await assert.rejects(
    page.evaluate((id) => window.office.bookmarkWindow('open', { id }), marks.one.id),
  );
  await page.evaluate(() => window.office.preferences({ privacy: false }));
  console.log(JSON.stringify({ ok: true, placed: r }));
} finally {
  await app?.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
