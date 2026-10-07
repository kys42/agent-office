import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const temp = await mkdtemp(path.join(os.tmpdir(), 'agent-office-native-'));
const now = new Date().toISOString();
const sources = {
  claude: path.join(temp, 'claude'),
  codex: path.join(temp, 'codex'),
  openclaw: path.join(temp, 'openclaw'),
};
const jsonl = async (file, rows) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
};
await jsonl(path.join(sources.claude, 'projects', 'demo', 'claude.jsonl'), [
  {
    type: 'user',
    sessionId: 'claude-test',
    timestamp: now,
    cwd: '/tmp/native-test',
    message: { role: 'user', content: '네이티브 연결 검증' },
  },
  {
    type: 'assistant',
    sessionId: 'claude-test',
    timestamp: now,
    message: {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'text', text: '기록을 연결했습니다.' }],
      stop_reason: 'end_turn',
    },
  },
]);
await jsonl(path.join(sources.codex, 'sessions', 'codex.jsonl'), [
  { type: 'session_meta', timestamp: now, payload: { id: 'codex-test', cwd: '/tmp/native-test' } },
  { type: 'event_msg', timestamp: now, payload: { type: 'task_started' } },
  {
    type: 'response_item',
    timestamp: now,
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '작은 사무실 만들기' }],
    },
  },
]);
await jsonl(path.join(sources.openclaw, 'agents', 'butler', 'sessions', 'claw.jsonl'), [
  { type: 'session', id: 'claw-test', timestamp: now, cwd: '/tmp/native-test' },
  {
    type: 'message',
    id: 'm',
    timestamp: now,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '안녕하세요. 오늘도 함께해요.' }],
      stopReason: 'stop',
    },
  },
]);
let app;
try {
  app = await electron.launch({
    // Own profile: a running Agent Office holds the single-instance lock on the default one.
    args: ['.', `--user-data-dir=${path.join(temp, 'profile')}`],
    env: {
      ...process.env,
      AGENT_OFFICE_DATA_DIR: path.join(temp, 'data'),
      CLAUDE_CONFIG_DIR: sources.claude,
      CODEX_HOME: sources.codex,
      OPENCLAW_STATE_DIR: sources.openclaw,
    },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.office-pet');
  const s = await page.evaluate(() => window.office.snapshot());
  assert.equal(s.sessions.length, 3);
  assert.deepEqual(
    s.connectors.map((c) => c.state),
    ['connected', 'connected', 'connected'],
  );
  const firstNotice = s.notices?.[0];
  assert.ok(firstNotice, 'Native collector emits normalized news');
  const read = await page.evaluate(
    async (n) => window.office.notices([{ id: n.id, version: n.version }], 'read'),
    firstNotice,
  );
  assert.ok(read.notices.find((n) => n.id === firstNotice.id)?.seenAt);
  const dismissed = await page.evaluate(
    async (n) => window.office.notices([{ id: n.id, version: n.version }], 'dismiss'),
    firstNotice,
  );
  assert.ok(dismissed.notices.find((n) => n.id === firstNotice.id)?.dismissedAt);
  await page.evaluate(() =>
    window.office.patch('codex:codex-test', { alias: '네이티브 네모', notes: 'IPC 영속성 확인' }),
  );
  const d = await page.evaluate(() => window.office.detail('codex:codex-test'));
  assert.equal(d.alias, '네이티브 네모');
  assert.equal(d.notes, 'IPC 영속성 확인');
  // Pinning a persona is one IPC step for all of its runs.
  const ids = s.sessions.map((x) => x.id);
  const pinned = await page.evaluate((ids) => window.office.pin(ids, true), ids);
  assert.ok(ids.every((id) => pinned.sessions.find((x) => x.id === id)?.pinned));
  const unpinned = await page.evaluate((ids) => window.office.pin(ids, false), ids);
  assert.ok(unpinned.sessions.every((x) => !x.pinned));
  // Terminal lookups name every colleague asked for, from one light identity read.
  const targets = await page.evaluate(
    (ids) => window.office.terminals(ids),
    [...ids, 'codex:missing'],
  );
  assert.deepEqual(Object.keys(targets).sort(), [...ids, 'codex:missing'].sort());
  assert.equal(targets['codex:missing'], null);
  // The collector re-localizes its own copy with the renderer: switch to English and check, then
  // pin Korean so the rest of the run doesn't depend on the machine's language.
  const english = await page.evaluate(() => window.office.preferences({ locale: 'en' }));
  assert.equal(english.preferences.locale, 'en');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.ok(english.connectors.every((c) => !/[가-힣]/.test(c.message)));
  const korean = await page.evaluate(() => window.office.preferences({ locale: 'ko' }));
  assert.ok(korean.connectors.every((c) => /[가-힣]/.test(c.message)));
  await page.waitForFunction(() => document.documentElement.lang === 'ko');
  const [dock] = await Promise.all([
    app.waitForEvent('window'),
    page.getByRole('button', { name: '데스크 펫', exact: true }).click(),
  ]);
  await dock.waitForSelector('.desk-pet');
  const dockBounds = () =>
    app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.isAlwaysOnTop());
      const b = w.getBounds();
      return { ...b, area: screen.getDisplayMatching(b).workArea, visible: w.isVisible() };
    });
  const pet = await dockBounds();
  assert.ok(pet.visible && pet.width <= 320 && pet.height <= 360, 'collapsed pet is small');
  await dock.waitForTimeout(400); // entrance fade
  await dock.screenshot({ path: '.local/native-pet.png' });
  await dock.getByRole('button', { name: /^데스크 펫 ·/ }).click();
  await dock.waitForSelector('.desk-row [data-station-id]');
  assert.equal(await dock.locator('.desk-row [data-station-id]').count(), 3);
  const row = await dockBounds();
  assert.equal(row.width, row.area.width, 'row spans the whole work area');
  assert.equal(row.x, row.area.x);
  assert.equal(row.y + row.height, row.area.y + row.area.height, 'row rests on the bottom edge');
  await dock.waitForTimeout(400);
  await dock.screenshot({ path: '.local/native-row.png' });
  // The floor version: same width and bottom edge, a shorter strip.
  await dock.getByRole('button', { name: '바닥 책상으로 보기' }).click();
  await dock.waitForSelector('.desk-row.desk-floor');
  const floor = await dockBounds();
  assert.equal(floor.width, floor.area.width, 'floor desks span the work area');
  assert.equal(floor.y + floor.height, floor.area.y + floor.area.height, 'standing on the bottom');
  assert.ok(floor.height < row.height, 'no rugs: a shorter strip than the office row');
  await dock.waitForTimeout(400);
  await dock.screenshot({ path: '.local/native-floor.png' });
  await dock.getByRole('button', { name: '책상 줄 접기' }).click();
  await dock.waitForSelector('.desk-pet');
  const back = await dockBounds();
  assert.deepEqual([back.x, back.y, back.width], [pet.x, pet.y, pet.width], 'pet returns home');
  await dock.getByRole('button', { name: '사무실 펼치기' }).click();
  const native = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      transparent: w.getBackgroundColor(),
      alwaysOnTop: w.isAlwaysOnTop(),
      visible: w.isVisible(),
      webPreferences: w.webContents.getLastWebPreferences(),
    })),
  );
  assert.ok(native.some((w) => w.alwaysOnTop && !w.visible));
  assert.equal(native.filter((w) => w.visible).length, 1);
  assert.ok(
    native.every(
      (w) =>
        w.webPreferences.contextIsolation &&
        w.webPreferences.sandbox &&
        !w.webPreferences.nodeIntegration,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      sessions: 3,
      providers: 3,
      deskPet: true,
      deskRow: true,
      deskFloor: true,
      ipcPersistence: true,
      rendererIsolation: true,
    }),
  );
} finally {
  if (app) await app.close();
  await rm(temp, { recursive: true, force: true });
}
