import { _electron as electron, expect } from 'playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { quietEnv } from './quiet-smoke.mjs';

// A card moving into its own window (창으로 띄우기) and back is a new window each time (a macOS
// panel cannot become one): the tab and memo notes not saved go along both ways, and a colleague
// opened while the new window loads keeps its own card. Runs quiet (no focus taken).
const temp = await mkdtemp(path.join(os.tmpdir(), 'agent-office-card-move-'));
const claude = path.join(temp, 'claude');
const now = new Date().toISOString();
await mkdir(path.join(claude, 'projects', 'demo'), { recursive: true });
const user = (sessionId, content) => ({
  type: 'user',
  sessionId,
  timestamp: now,
  cwd: '/tmp/card-move-test',
  message: { role: 'user', content },
});
await writeFile(
  path.join(claude, 'projects', 'demo', 'a.jsonl'),
  JSON.stringify(user('claude-a', '창으로 띄울 대화예요')) + '\n',
);
await writeFile(
  path.join(claude, 'projects', 'demo', 'b.jsonl'),
  JSON.stringify(user('claude-b', '그사이에 여는 다른 동료예요')) + '\n',
);
let app;
try {
  app = await electron.launch({
    executablePath: process.env.AGENT_OFFICE_EXECUTABLE,
    args: [
      ...(process.env.AGENT_OFFICE_EXECUTABLE ? [] : ['.']),
      `--user-data-dir=${path.join(temp, 'profile')}`,
    ],
    env: {
      ...process.env,
      ...quietEnv,
      AGENT_OFFICE_DATA_DIR: path.join(temp, 'data'),
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: path.join(temp, 'codex'),
      OPENCLAW_STATE_DIR: path.join(temp, 'openclaw'),
    },
  });
  const page = await app.firstWindow();
  await page.locator('.office-guide').waitFor();
  await page.getByRole('button', { name: /^(Explore on my own|직접 둘러볼게요)$/ }).click();
  const [dock] = await Promise.all([
    app.waitForEvent('window'),
    page.getByRole('button', { name: '데스크 펫', exact: true }).evaluate((b) => b.click()),
  ]);
  await dock.waitForSelector('.desk-pet');
  const open = (id) =>
    dock.evaluate(
      (id) => window.office.card('open', { id }, { x: 400, y: 600, width: 200, height: 100 }),
      id,
    );
  /** Every card window: whose card, shown or not, its own window or a card panel. */
  const windows = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => w.webContents.getURL().endsWith('#card'))
        .map((w) => ({ visible: w.isVisible(), own: w.isMaximizable() })),
    );
  const pageOf = async (pick) => {
    const ids = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => w.webContents.getURL().endsWith('#card'))
        .map((w) => ({ id: w.webContents.id, visible: w.isVisible(), own: w.isMaximizable() })),
    );
    const want = ids.find(pick);
    if (!want) return null;
    for (const p of app.windows())
      if (
        p.url().endsWith('#card') &&
        (await app.browserWindow(p).then((w) => w.evaluate((w) => w.webContents.id))) === want.id
      )
        return p;
    return null;
  };
  const visibleCard = async (own) => {
    let found = null;
    await expect
      .poll(
        async () => {
          found = await pageOf((w) => w.visible && w.own === own);
          return !!found;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    await found.locator('.inspector-card').waitFor();
    return found;
  };
  const named = (card) => card.locator('.card-head h2').getAttribute('title');
  const notesTab = (card) => card.getByRole('tab', { name: '기억 메모', exact: true });

  // 1. Unsaved notes go along into its own window, on the notes tab.
  await open('claude:claude-a');
  const preview = await visibleCard(false);
  const nameA = await named(preview);
  await notesTab(preview).click();
  await preview.locator('#notes').fill('저장 안 한 메모');
  await preview.locator('.card-head .card-own-window').click();
  const own = await visibleCard(true);
  assert.equal(await named(own), nameA);
  await expect(notesTab(own)).toHaveAttribute('aria-selected', 'true');
  await expect(own.locator('#notes')).toHaveValue('저장 안 한 메모');
  // 2. And back into a pinned card, edited further on the way.
  await own.locator('#notes').fill('저장 안 한 메모 · 창에서 더 씀');
  await own.locator('.card-head .card-own-window').click();
  await expect.poll(() => own.isClosed(), { timeout: 20_000 }).toBe(true);
  const pinned = await visibleCard(false);
  await expect(pinned.locator('.card-head .card-pin')).toHaveAttribute('data-pin', 'pinned');
  await expect(notesTab(pinned)).toHaveAttribute('aria-selected', 'true');
  await expect(pinned.locator('#notes')).toHaveValue('저장 안 한 메모 · 창에서 더 씀');
  // Nothing was saved on the way: the colleague's stored notes are untouched.
  const stored = await page.evaluate(
    async (id) => (await window.office.snapshot()).sessions.find((s) => s.id === id)?.notes,
    'claude:claude-a',
  );
  assert.ok(!stored, 'no notes saved');
  await pinned.evaluate(() => window.office.card('close')).catch(() => {});
  await expect.poll(() => pinned.isClosed()).toBe(true);

  // 3. Another colleague opened while the new window loads keeps its own card.
  await open('claude:claude-a');
  const previewA = await visibleCard(false);
  await previewA.evaluate(() => window.office.card('pin-window'));
  await open('claude:claude-b');
  const ownA = await visibleCard(true);
  assert.equal(await named(ownA), nameA);
  // The other colleague's card stays shown once A's own window has replaced A's card.
  await ownA.waitForTimeout(800);
  const previewB = await pageOf((w) => w.visible && !w.own);
  assert.ok(previewB, 'the card opened meanwhile is still shown');
  await previewB.locator('.inspector-card').waitFor();
  assert.notEqual(await named(previewB), nameA, 'and it is the other colleague');
  // The card A left behind is gone; one preview and A's own window remain.
  await expect.poll(async () => (await windows()).length, { timeout: 10_000 }).toBe(2);
  console.log(JSON.stringify({ ok: true, notesBothWays: true, openedMeanwhileKept: true }));
} finally {
  if (app) await app.close();
  await rm(temp, { recursive: true, force: true });
}
