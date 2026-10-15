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
  ...Array.from({ length: 120 }, (_, i) => ({
    type: i % 2 ? 'assistant' : 'user',
    sessionId: 'claude-test',
    timestamp: new Date(Date.parse(now) - (120 - i) * 60_000).toISOString(),
    cwd: '/tmp/native-test',
    message: {
      id: `history-${i}`,
      role: i % 2 ? 'assistant' : 'user',
      content: `합성 지난 대화 ${i} · ${'스크롤 위치를 확인합니다. '.repeat(8)}`,
      ...(i % 2 ? { stop_reason: 'end_turn' } : {}),
    },
  })),
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
    executablePath: process.env.AGENT_OFFICE_EXECUTABLE,
    args: [
      ...(process.env.AGENT_OFFICE_EXECUTABLE ? [] : ['.']),
      `--user-data-dir=${path.join(temp, 'profile')}`,
    ],
    env: {
      ...process.env,
      AGENT_OFFICE_DATA_DIR: path.join(temp, 'data'),
      CLAUDE_CONFIG_DIR: sources.claude,
      CODEX_HOME: sources.codex,
      OPENCLAW_STATE_DIR: sources.openclaw,
    },
  });
  const page = await app.firstWindow();
  await page.locator('.office-guide').waitFor();
  await page.getByRole('button', { name: /^(Explore on my own|직접 둘러볼게요)$/ }).click();
  assert.equal(
    await page.evaluate(() => localStorage.getItem('office:onboarding:v1:live')),
    'seen',
  );
  const checkMacDock = async (stage) => {
    if (process.platform === 'darwin')
      assert.equal(
        await app.evaluate(({ app }) => app.dock.isVisible()),
        true,
        `macOS Dock icon remains visible: ${stage}`,
      );
  };
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.office-pet');
  await checkMacDock('startup');
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
  assert.equal(
    await page.evaluate(() => window.office.inspectDraft('claude:claude-test')),
    null,
    'read-only draft recovery returns no draft for a synthetic colleague without a live terminal',
  );
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
      const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('#mini'));
      const b = w.getBounds();
      return { ...b, area: screen.getDisplayMatching(b).workArea, visible: w.isVisible() };
    });
  const pet = await dockBounds();
  assert.ok(pet.visible && pet.width <= 320 && pet.height <= 360, 'collapsed pet is small');
  await dock.waitForTimeout(400); // entrance fade
  await checkMacDock('desk pet');
  await dock.screenshot({ path: '.local/native-pet.png' });
  await dock.getByRole('button', { name: /^데스크 펫 ·/ }).click();
  await dock.waitForSelector('.desk-row [data-station-id]');
  assert.equal(await dock.locator('.desk-row [data-station-id]').count(), 3);
  const row = await dockBounds();
  assert.equal(row.width, row.area.width, 'row spans the whole work area');
  assert.equal(row.x, row.area.x);
  assert.equal(row.y + row.height, row.area.y + row.area.height, 'row rests on the bottom edge');
  await dock.waitForTimeout(400);
  await checkMacDock('desk row');
  await dock.screenshot({ path: '.local/native-row.png' });
  // Synthetic providers share one project. Its sign moves their benches together.
  const rowZone = dock.locator('.row-zone').first();
  const originalX = await rowZone.evaluate((el) => parseFloat(el.style.left));
  const sign = await dock.locator('.row-zone-handle').first().boundingBox();
  assert.ok(sign, 'project sign is drawn');
  await dock.mouse.move(sign.x + sign.width / 2, sign.y + sign.height / 2);
  await dock.mouse.down();
  await dock.mouse.move(sign.x + sign.width / 2 - 100, sign.y + sign.height / 2, { steps: 8 });
  await dock.mouse.up();
  await dock.waitForFunction(
    (before) => parseFloat(document.querySelector('.row-zone').style.left) < before - 80,
    originalX,
  );
  const arrangedX = await rowZone.evaluate((el) => parseFloat(el.style.left));
  assert.equal(await dock.locator('.row-station').count(), 3, 'all desks move together');
  assert.ok(await dock.evaluate(() => localStorage.getItem('office:row-zones:v1:live')));
  await dock.screenshot({ path: '.local/native-row-arranged.png' });
  // Keep this test's card open if someone uses another app during local QA. Production still
  // closes it on blur; we test its panel focus/keyboard without racing the user's desktop.
  await app.evaluate(({ app }) =>
    app.once('browser-window-created', (_event, window) =>
      window.webContents.once('did-finish-load', () => window.removeAllListeners('blur')),
    ),
  );
  const [card] = await Promise.all([
    app.waitForEvent('window'),
    dock.evaluate(() =>
      window.office.card(
        'open',
        { id: 'codex:codex-test', news: false },
        {
          x: 400,
          y: 600,
          width: 200,
          height: 100,
        },
      ),
    ),
  ]);
  await card.waitForSelector('.inspector');
  await card.bringToFront();
  await card.waitForFunction(() => document.hasFocus());
  await checkMacDock('popup work card');
  await card.getByRole('tab', { name: '기억 메모', exact: true }).click();
  const notes = card.locator('#notes');
  await notes.fill('');
  await notes.pressSequentially('Panel keyboard input');
  assert.equal(await notes.inputValue(), 'Panel keyboard input', 'popup panel accepts keyboard');
  const chat = card.locator('.terminal-send-chat textarea');
  await chat.pressSequentially('Unsent reply draft');
  assert.equal(await chat.inputValue(), 'Unsent reply draft', 'popup chat accepts OS keyboard');
  await page.waitForFunction(
    () =>
      localStorage.getItem('office:reply-draft:v1:live:codex:codex-test') === 'Unsent reply draft',
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem('office:reply-draft:v1:live:codex:codex-test')),
    'Unsent reply draft',
    'draft is stored in the shared native profile immediately',
  );
  // A bookmark saved from another renderer arrives in the open memory tab via real IPC.
  // These are synthetic provider files in this smoke's own profile and DB.
  const saved = await page.evaluate(async () => {
    const s = await window.office.detail('codex:codex-test');
    const e = s.events.find((e) => e.kind === 'user');
    if (!e) throw new Error('synthetic request missing');
    return (await window.office.bookmark(s.id, e.id)).bookmark;
  });
  await card.waitForSelector('.inspector-bookmarks .bookmark-card');
  assert.ok((await card.locator('.bookmark-card').innerText()).includes('작은 사무실 만들기'));
  assert.equal(
    await notes.inputValue(),
    'Panel keyboard input',
    'bookmark refresh preserves notes',
  );
  await card
    .locator('.bookmark-card')
    .getByRole('button', { name: '메모 추가', exact: true })
    .click();
  const annotation = card.locator('.bookmark-note-edit textarea');
  await annotation.pressSequentially('Remember this decision');
  await card
    .locator('.bookmark-note-edit')
    .getByRole('button', { name: '저장', exact: true })
    .click();
  await card.waitForSelector('.bookmark-note');
  assert.equal(await card.locator('.bookmark-note').innerText(), 'Remember this decision');
  const persisted = await page.evaluate(() =>
    window.office.bookmarks({ sessionIds: ['codex:codex-test'] }),
  );
  assert.equal(persisted.bookmarks.find((b) => b.id === saved.id)?.note, 'Remember this decision');
  await card.bringToFront();
  await card.waitForFunction(() => document.hasFocus());
  await card.screenshot({ path: '.local/native-card-memory.png' });
  // The card can be resized, and opens at the size it was given from then on.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('#card'));
    if (!w.isResizable()) throw new Error('the card is not resizable');
    w.setSize(560, 600);
    w.emit('resized');
  });
  await card.waitForTimeout(300);
  await card.evaluate(() => window.office.card('close'));
  await dock.evaluate(() =>
    window.office.card(
      'open',
      { id: 'codex:codex-test', news: false },
      { x: 400, y: 600, width: 200, height: 100 },
    ),
  );
  await card.waitForSelector('.inspector-card');
  const [reopenedWidth] = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((x) => x.webContents.getURL().endsWith('#card'))
      .getSize(),
  );
  assert.equal(reopenedWidth, 560, 'the card reopens at the size the person gave it');
  assert.equal(
    await chat.inputValue(),
    'Unsent reply draft',
    'closing the native popup keeps its draft',
  );
  await card.screenshot({ path: '.local/native-card-reply-draft.png' });
  // Its header moves it from the main process (no CSS drag region in the card).
  await card.evaluate(() => window.office.card('drag-start'));
  await card.evaluate(() => window.office.card('drag-end'));
  // The same desk clicked again puts its card away (a toggle); clicked once more, it is back.
  const cardShown = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((x) => x.webContents.getURL().endsWith('#card'))
        .isVisible(),
    );
  const again = () =>
    dock.evaluate(() =>
      window.office.card(
        'open',
        { id: 'codex:codex-test', news: false },
        { x: 400, y: 600, width: 200, height: 100 },
      ),
    );
  await again();
  assert.equal(await cardShown(), false, 'a second click on the same desk closes its card');
  await again();
  await card.waitForSelector('.inspector-card');
  assert.equal(await cardShown(), true, 'and a third opens it again');
  // Moved on inside the card to another colleague, the first one's desk opens it rather than closing.
  await dock.evaluate(() =>
    window.office.card(
      'open',
      { id: 'claude:claude-test', news: false },
      { x: 400, y: 600, width: 200, height: 100 },
    ),
  );
  await card.evaluate(() =>
    window.office.card('select', { id: 'claude:claude-test', news: false }),
  );
  await card.bringToFront();
  await card.waitForFunction(() => document.hasFocus());
  await card.waitForFunction(() => document.querySelectorAll('.conversation-message').length >= 24);
  const scroll = card.locator('.inspector-scroll');
  await scroll.hover();
  await card.mouse.wheel(0, -260);
  await card.waitForFunction(() => {
    const el = document.querySelector('.inspector-scroll');
    return el.scrollHeight - el.scrollTop - el.clientHeight > 200;
  });
  // Actual collector/IPC pages, reached by scrolling alone, including their end marker.
  for (let i = 0; i < 10 && (await card.locator('.older-messages').count()); i++) {
    await card.mouse.wheel(0, -10000);
    await card.waitForTimeout(900);
  }
  assert.equal(
    await card.locator('.older-messages').count(),
    0,
    'native scrolling reaches the oldest page',
  );
  assert.ok(
    (await card.locator('.conversation-message').first().innerText()).includes('합성 지난 대화 0'),
  );
  await card.screenshot({ path: '.local/native-card-conversation-scroll.png' });
  await again();
  assert.equal(await cardShown(), true, 'a desk other than the one shown switches the card');
  // Kept open, a click elsewhere (the card losing focus) leaves it up; let go, it closes again.
  const blurCard = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((x) => x.webContents.getURL().endsWith('#card'))
        .emit('blur'),
    );
  // A press on its text box gives the card the keyboard again, after another window had it.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((x) => x.webContents.getURL().includes('#mini'))
      ?.focus(),
  );
  await card.evaluate(() => window.office.card('focus'));
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getFocusedWindow()?.webContents.getURL().endsWith('#card'),
    ),
    true,
    'the card holds the keyboard after asking for it',
  );
  await card.evaluate(() => window.office.card('pin-on'));
  await card.waitForTimeout(700);
  await blurCard();
  await card.waitForTimeout(900);
  assert.equal(await cardShown(), true, 'a kept-open card stays when focus goes elsewhere');
  await card.evaluate(() => window.office.card('pin-off'));
  await card.evaluate(() => window.office.card('close'));
  // The floor version: same width and bottom edge, a shorter strip.
  await dock.getByRole('button', { name: '바닥 책상으로 보기' }).click();
  await dock.waitForSelector('.desk-row.desk-floor');
  await dock.waitForFunction(
    (expected) =>
      Math.abs(parseFloat(document.querySelector('.row-zone').style.left) - expected) < 1,
    arrangedX,
  );
  await dock.getByRole('button', { name: '기본 배치로 되돌리기', exact: true }).click();
  await dock.waitForFunction(() => !localStorage.getItem('office:row-zones:v1:live'));
  const floor = await dockBounds();
  assert.equal(floor.width, floor.area.width, 'floor desks span the work area');
  assert.equal(floor.y + floor.height, floor.area.y + floor.area.height, 'standing on the bottom');
  assert.ok(floor.height < row.height, 'no rugs: a shorter strip than the office row');
  await dock.waitForTimeout(400);
  await checkMacDock('floor desks');
  await dock.screenshot({ path: '.local/native-floor.png' });
  await dock.getByRole('button', { name: '책상 줄 접기' }).click();
  await dock.waitForSelector('.desk-pet');
  const back = await dockBounds();
  assert.deepEqual([back.x, back.y, back.width], [pet.x, pet.y, pet.width], 'pet returns home');
  // The pet's tools appear (and take clicks) only while the pet is pointed at.
  await dock.locator('.dock-pet-anchor').hover();
  await dock.getByRole('button', { name: '사무실 펼치기' }).click();
  await checkMacDock('return to main office');
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
      firstRunGuide: true,
      macDockIcon: process.platform === 'darwin',
    }),
  );
} finally {
  if (app) await app.close();
  await rm(temp, { recursive: true, force: true });
}
