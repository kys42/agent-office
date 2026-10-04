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
    args: ['.'],
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
  const [mini] = await Promise.all([
    app.waitForEvent('window'),
    page.getByRole('button', { name: '미니 오피스', exact: true }).click(),
  ]);
  await mini.waitForSelector('.mini-station');
  assert.equal(await mini.locator('.mini-station').count(), 3);
  await mini.screenshot({ path: '.local/native-mini.png' });
  await mini.getByRole('button', { name: '사무실 펼치기' }).click();
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
      mini: true,
      ipcPersistence: true,
      rendererIsolation: true,
    }),
  );
} finally {
  if (app) await app.close();
  await rm(temp, { recursive: true, force: true });
}
