import { _electron as electron, expect } from 'playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { focusTests, quietEnv } from './quiet-smoke.mjs';

// Every step here is about which card window holds the OS focus: it only means something when
// the app may take the screen.
if (!focusTests) {
  console.log(
    'Card windows smoke skipped: run with AGENT_OFFICE_FOCUS_TESTS=1 when the screen is free.',
  );
  process.exit(0);
}

const temp = await mkdtemp(path.join(os.tmpdir(), 'agent-office-cards-'));
const now = new Date().toISOString();
const sources = Object.fromEntries(
  ['claude', 'codex', 'openclaw'].map((p) => [p, path.join(temp, p)]),
);
const jsonl = async (file, rows) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};
await jsonl(path.join(sources.claude, 'projects', 'demo', 'claude.jsonl'), [
  {
    type: 'user',
    sessionId: 'claude-test',
    timestamp: now,
    cwd: '/tmp/card-test',
    message: { role: 'user', content: '팝업 카드를 확인해 주세요' },
  },
  {
    type: 'assistant',
    sessionId: 'claude-test',
    timestamp: now,
    message: {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'text', text: '합성 Claude 카드입니다.' }],
      stop_reason: 'end_turn',
    },
  },
]);
await jsonl(path.join(sources.codex, 'sessions', 'codex.jsonl'), [
  { type: 'session_meta', timestamp: now, payload: { id: 'codex-test', cwd: '/tmp/card-test' } },
  {
    type: 'response_item',
    timestamp: now,
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '위치를 기억해 주세요' }],
    },
  },
]);
await jsonl(path.join(sources.openclaw, 'agents', 'test', 'sessions', 'claw.jsonl'), [
  { type: 'session', id: 'claw-test', timestamp: now, cwd: '/tmp/card-test' },
  {
    type: 'message',
    id: 'm',
    timestamp: now,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '합성 세 번째 카드입니다.' }],
      stopReason: 'stop',
    },
  },
]);
const launch = () =>
  electron.launch({
    executablePath: process.env.AGENT_OFFICE_EXECUTABLE,
    args: [
      ...(process.env.AGENT_OFFICE_EXECUTABLE ? [] : ['.']),
      `--user-data-dir=${path.join(temp, 'profile')}`,
    ],
    env: {
      ...process.env,
      ...quietEnv,
      AGENT_OFFICE_DATA_DIR: path.join(temp, 'data'),
      CLAUDE_CONFIG_DIR: sources.claude,
      CODEX_HOME: sources.codex,
      OPENCLAW_STATE_DIR: sources.openclaw,
    },
  });
let app;
try {
  app = await launch();
  const main = await app.firstWindow();
  await main.locator('.office-guide').waitFor();
  await main.getByRole('button', { name: /^(Explore on my own|직접 둘러볼게요)$/ }).click();
  await main.evaluate(() => window.office.preferences({ locale: 'ko' }));
  const [dock] = await Promise.all([
    app.waitForEvent('window'),
    main.evaluate(() => window.office.window('mini')),
  ]);
  await dock.waitForFunction(() => !!window.office);
  const open = (id) =>
    dock.evaluate(
      (id) =>
        window.office.card(
          'open',
          { id, news: false },
          { x: 1000, y: 700, width: 120, height: 60 },
        ),
      id,
    );
  const newCard = async (id) => {
    const [p] = await Promise.all([app.waitForEvent('window'), open(id)]);
    await p.waitForFunction(() => !!window.office);
    await p.bringToFront();
    await p.evaluate(() => window.office.card('focus'));
    await p.locator('.inspector-card').waitFor();
    await p.waitForFunction(() => document.hasFocus());
    return p;
  };
  const visible = async (p) => (await app.browserWindow(p)).evaluate((w) => w.isVisible());
  const bounds = async (p) => (await app.browserWindow(p)).evaluate((w) => w.getBounds());
  const cardsCount = () => app.windows().filter((p) => p.url().endsWith('#card')).length;
  const a = await newCard('codex:codex-test');
  const aw = await app.browserWindow(a);
  const desired = await app.evaluate(({ screen }) => {
    const area = screen.getPrimaryDisplay().workArea;
    return { x: area.x + 40, y: area.y + 40, width: 500, height: Math.min(640, area.height - 40) };
  });
  await aw.evaluate((w, b) => {
    w.setBounds(b);
    w.emit('resized');
  }, desired);
  await a.bringToFront();
  await a.waitForFunction(() => document.hasFocus());
  await a.getByRole('button', { name: '위치 기억', exact: true }).click();
  await expect(a.getByRole('button', { name: '위치 기억', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const remembered = await bounds(a);
  await a.evaluate(() => window.office.card('close'));
  await open('codex:codex-test');
  await a.locator('.inspector-card').waitFor();
  assert.deepEqual(await bounds(a), remembered, 'another anchor does not move a remembered popup');
  await a.locator('.card-composer textarea').fill('A의 미전송 글');
  await a.getByRole('button', { name: '이 카드 고정', exact: true }).click();
  await expect(a.getByRole('button', { name: '이 카드 고정', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const titleA = await a.locator('.card-head h2').textContent();
  const b = await newCard('claude:claude-test');
  await b.getByRole('button', { name: '이 카드 고정', exact: true }).click();
  await expect(b.getByRole('button', { name: '이 카드 고정', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await b.locator('.card-composer textarea').fill('B의 미전송 글');
  assert.deepEqual(await bounds(a), remembered, 'pinning never repositions an existing card');
  assert.notDeepEqual(await bounds(b), remembered, 'new popup leaves the pinned header reachable');
  assert.equal(await a.locator('.card-head h2').textContent(), titleA);
  await expect(a.locator('.card-composer textarea')).toHaveValue('A의 미전송 글');
  const count = cardsCount();
  await open('codex:codex-test');
  assert.equal(cardsCount(), count, 'opening a pinned colleague reuses its window');
  await expect(a.locator('.card-composer textarea')).toHaveValue('A의 미전송 글');
  const bookmark = await a.evaluate(async () => {
    const s = await window.office.detail('codex:codex-test');
    const e = s.events.find((e) => e.kind === 'user');
    if (!e) throw Error('Synthetic bookmark event missing');
    return (await window.office.bookmark(s.id, e.id, '')).bookmark;
  });
  await a.bringToFront();
  await a.getByRole('tab', { name: '기억 메모', exact: true }).click();
  await a
    .locator('.bookmark-card')
    .getByRole('button', { name: '원문 대화로 이동', exact: true })
    .click();
  await expect(a.locator('.conversation-message.is-focused')).toHaveCount(1);
  await a.getByRole('tab', { name: '작업 정보', exact: true }).click();
  const titleB = await b.locator('.card-head h2').textContent();
  await b.evaluate(
    (bookmark) =>
      window.office.card('select', {
        id: bookmark.sessionId,
        news: false,
        bookmark: { eventId: bookmark.eventId, at: bookmark.at },
      }),
    bookmark,
  );
  await expect(a.getByRole('tab', { name: '대화', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(a.locator('.conversation-message.is-focused')).toHaveCount(1);
  assert.equal(
    await b.locator('.card-head h2').textContent(),
    titleB,
    'bookmark reuse leaves its source pinned card alone',
  );
  assert.equal(cardsCount(), count, 'bookmark navigation reuses the destination pinned card');
  await assert.rejects(() =>
    b.evaluate(() =>
      window.office.card('select', {
        id: 'codex:codex-test',
        news: false,
        bookmark: { eventId: 'x'.repeat(1001), at: 1 },
      }),
    ),
  );
  const clawId = await main.evaluate(
    async () =>
      (await window.office.snapshot()).sessions.find((s) => s.provider === 'openclaw')?.id,
  );
  assert.ok(clawId);
  const c = await newCard(clawId);
  await b.evaluate((id) => window.office.card('select', { id, news: false }), clawId);
  await expect
    .poll(() => b.evaluate(async () => (await window.office.cardState()).target.id))
    .toBe(clawId);
  await expect.poll(() => visible(c)).toBe(false);
  await assert.rejects(() => c.evaluate(() => window.office.card('pin-on')));
  assert.equal((await b.evaluate(() => window.office.cardState())).pinned, true);
  await b.evaluate(() => window.office.card('select', { id: 'claude:claude-test', news: false }));
  await open(clawId);
  await c.locator('.inspector-card').waitFor();
  await c.bringToFront();
  await c.waitForTimeout(600);
  await aw.evaluate((w) => w.focus());
  await expect.poll(() => visible(c)).toBe(false);
  assert.equal(await visible(a), true);
  assert.equal(await visible(b), true, 'blur closes only the ordinary preview');
  await assert.rejects(() => main.evaluate(() => window.office.card('pin-on')));
  await b.bringToFront();
  await b.getByRole('button', { name: '이 카드 고정', exact: true }).click();
  await expect(b.getByRole('button', { name: '이 카드 고정', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect.poll(() => c.isClosed()).toBe(true);
  await expect(b.locator('.card-composer textarea')).toHaveValue('B의 미전송 글');
  await b.getByRole('button', { name: '이 카드 고정', exact: true }).click();
  await a.bringToFront();
  await a.getByRole('button', { name: '업무 카드 닫기', exact: true }).click();
  await expect.poll(() => a.isClosed()).toBe(true);
  assert.equal(await visible(b), true, 'closing one pinned window leaves the other alone');
  const reopened = await newCard('codex:codex-test');
  await expect(reopened.locator('.card-composer textarea')).toHaveValue('A의 미전송 글');
  await expect(reopened.getByRole('button', { name: '인수인계 꾸리기' })).toHaveCount(0);
  await expect(
    reopened.locator('.card-head').getByRole('button', { name: '사무실에 고정', exact: true }),
  ).toHaveCount(0);
  await reopened.getByRole('button', { name: '카드 메뉴', exact: true }).click();
  await expect(
    reopened.getByRole('menuitem', { name: '사무실에 고정', exact: true }),
  ).toBeVisible();
  await reopened.keyboard.press('Escape');
  await reopened.screenshot({ path: '.local/popup-position-and-pin.png' });
  await b.screenshot({ path: '.local/popup-pinned-colleague.png' });
  await app.close();
  app = await launch();
  const restarted = await app.firstWindow();
  await restarted.waitForFunction(() => !!window.office);
  assert.equal(cardsCount(), 0, 'pinned windows are not automatically reopened on app restart');
  const [dock2] = await Promise.all([
    app.waitForEvent('window'),
    restarted.evaluate(() => window.office.window('mini')),
  ]);
  await dock2.waitForFunction(() => !!window.office);
  const [restored] = await Promise.all([
    app.waitForEvent('window'),
    dock2.evaluate(() =>
      window.office.card(
        'open',
        { id: 'codex:codex-test', news: false },
        { x: 1100, y: 800, width: 100, height: 50 },
      ),
    ),
  ]);
  await restored.locator('.inspector-card').waitFor();
  const restoredBounds = await bounds(restored);
  assert.deepEqual(
    { x: restoredBounds.x, y: restoredBounds.y },
    { x: remembered.x, y: remembered.y },
  );
  await expect(restored.getByRole('button', { name: '위치 기억', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(restored.getByRole('button', { name: '이 카드 고정', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await restored.getByRole('button', { name: '위치 기억', exact: true }).click();
  await restored.evaluate(() => window.office.card('close'));
  await dock2.evaluate(() =>
    window.office.card(
      'open',
      { id: 'claude:claude-test', news: false },
      { x: 1100, y: 800, width: 100, height: 50 },
    ),
  );
  await restored.locator('.inspector-card').waitFor();
  const anchored = await bounds(restored);
  assert.notDeepEqual({ x: anchored.x, y: anchored.y }, { x: remembered.x, y: remembered.y });
  console.log(
    JSON.stringify({
      ok: true,
      independentCards: true,
      pinnedReuse: true,
      blurIsolation: true,
      draftIsolation: true,
      positionRestart: true,
      positionOff: true,
      ipcIsolation: true,
      bookmarkFocus: true,
      uniquePinnedTarget: true,
    }),
  );
} finally {
  if (app) await app.close();
  await rm(temp, { recursive: true, force: true });
}
