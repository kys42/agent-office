import { _electron as electron, expect } from 'playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { quietEnv } from './quiet-smoke.mjs';

// Pinned cards come back where they were when the app starts again; one whose colleague is gone
// stays closed, and with the setting off nothing comes back. A card taken out into its own window
// (창으로 띄우기) is an ordinary app window, comes back as one, and goes back in as a pinned card.
// Runs quiet (no focus taken).
const temp = await mkdtemp(path.join(os.tmpdir(), 'agent-office-pinned-'));
const claude = path.join(temp, 'claude');
const data = path.join(temp, 'data');
const now = new Date().toISOString();
await mkdir(path.join(claude, 'projects', 'demo'), { recursive: true });
await writeFile(
  path.join(claude, 'projects', 'demo', 'claude.jsonl'),
  [
    {
      type: 'user',
      sessionId: 'claude-test',
      timestamp: now,
      cwd: '/tmp/pinned-test',
      message: { role: 'user', content: '고정 카드를 확인해 주세요' },
    },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n') + '\n',
);
const at = { x: 120, y: 140, width: 420, height: 560 };
const pinned = (cards) =>
  writeFile(path.join(data, 'pinned-cards.json'), JSON.stringify({ v: 1, cards }));
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
      AGENT_OFFICE_DATA_DIR: data,
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: path.join(temp, 'codex'),
      OPENCLAW_STATE_DIR: path.join(temp, 'openclaw'),
    },
  });
const cards = (app) => app.windows().filter((p) => p.url().endsWith('#card'));
const readPinned = async () =>
  JSON.parse(await readFile(path.join(data, 'pinned-cards.json'), 'utf8')).cards;
/** A card in its own window: an ordinary app window, never floating, titled with the name. */
const isOwnWindow = async (page, w, name) => {
  await expect(page.locator('.card-head .card-own-window')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.card-head .card-pin')).toHaveCount(0);
  assert.equal(await w.evaluate((w) => w.isAlwaysOnTop()), false, 'not on top');
  assert.equal(await w.evaluate((w) => w.isVisibleOnAllWorkspaces()), false, 'on one desktop');
  // A card panel is neither (desktop/window-style.ts `cardWindowStyle`).
  assert.equal(await w.evaluate((w) => w.isMaximizable()), true, 'zooms like an app window');
  assert.equal(await w.evaluate((w) => w.isFullScreenable()), true, 'and goes full screen');
  await expect.poll(() => w.evaluate((w) => w.getTitle())).toBe(name);
};
/** Takes `card` out into its own window; the card's old window goes once the new one shows. */
const ownWindow = async (card, name) => {
  await card.evaluate(() => window.office.card('pin-window')).catch(() => {});
  await expect.poll(() => card.isClosed(), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => cards(app).length, { timeout: 20_000 }).toBe(1);
  const page = cards(app)[0];
  await page.locator('.inspector-card').waitFor();
  const window = await app.browserWindow(page);
  await isOwnWindow(page, window, name);
  return { page, window };
};
let app;
try {
  await mkdir(data, { recursive: true });
  await pinned([
    { target: { id: 'claude:claude-test' }, pin: 'top', bounds: at },
    { target: { id: 'claude:gone' }, pin: 'pinned', bounds: at },
  ]);
  app = await launch();
  await (await app.firstWindow()).waitForFunction(() => !!window.office);
  await expect.poll(() => cards(app).length, { timeout: 20_000 }).toBe(1);
  const card = cards(app)[0];
  await card.locator('.inspector-card').waitFor();
  const w = await app.browserWindow(card);
  const b = await w.evaluate((w) => w.getBounds());
  assert.deepEqual({ x: b.x, y: b.y }, { x: at.x, y: at.y }, 'reopens where it was');
  assert.equal(await w.evaluate((w) => w.isAlwaysOnTop()), true, 'pinned on top stays on top');
  await expect(card.locator('.card-head .card-pin')).toHaveAttribute('data-pin', 'top');
  // 창으로 띄우기: the card moves to an ordinary app window of its own (a new window: a macOS
  // panel cannot become one), where it was, titled with the colleague's name.
  const name = await card.locator('.card-head h2').getAttribute('title');
  const own = await ownWindow(card, name);
  const ob = await own.window.evaluate((w) => w.getBounds());
  assert.deepEqual({ x: ob.x, y: ob.y }, { x: at.x, y: at.y }, 'its own window opens where it was');
  assert.equal(
    (await readPinned()).find((c) => c.target.id === 'claude:claude-test')?.pin,
    'window',
    'written down as a card in its own window',
  );
  // It comes back as its own window at the next start.
  await app.close();
  app = await launch();
  await (await app.firstWindow()).waitForFunction(() => !!window.office);
  await expect.poll(() => cards(app).length, { timeout: 20_000 }).toBe(1);
  const back = cards(app)[0];
  await back.locator('.inspector-card').waitFor();
  await isOwnWindow(back, await app.browserWindow(back), name);
  // And goes back in as a pinned card panel.
  await back.evaluate(() => window.office.card('pin-on')).catch(() => {});
  await expect.poll(() => back.isClosed(), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => cards(app).length, { timeout: 20_000 }).toBe(1);
  const card2 = cards(app)[0];
  await expect(card2.locator('.card-head .card-pin')).toHaveAttribute('data-pin', 'pinned');
  const w2 = await app.browserWindow(card2);
  assert.equal(await w2.evaluate((w) => w.isMaximizable()), false, 'a card panel again');
  assert.equal(await w2.evaluate((w) => w.isAlwaysOnTop()), false, 'pinned, not on top');
  await expect.poll(async () => (await readPinned())[0]?.pin).toBe('pinned');
  // The person closes it: the next start leaves it closed.
  // A pinned card closes for good: its window goes away before the call can answer.
  await card2.evaluate(() => window.office.card('close')).catch(() => {});
  await expect.poll(() => card2.isClosed()).toBe(true);
  await app.close();
  app = await launch();
  const main = await app.firstWindow();
  await main.waitForFunction(() => !!window.office);
  await main.waitForTimeout(3000);
  assert.equal(cards(app).length, 0, 'a card closed by the person stays closed');
  // Turned off in settings, a pinned card is not brought back.
  await main.evaluate(() => window.office.preferences({ restorePinnedCards: false }));
  await app.close();
  await pinned([{ target: { id: 'claude:claude-test' }, pin: 'pinned', bounds: at }]);
  app = await launch();
  await (await app.firstWindow()).waitForFunction(() => !!window.office);
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(cards(app).length, 0, 'the setting off brings nothing back');
  console.log(
    JSON.stringify({
      ok: true,
      restored: true,
      ownWindow: true,
      closedStaysClosed: true,
      settingOff: true,
    }),
  );
} finally {
  if (app) await app.close();
  await rm(temp, { recursive: true, force: true });
}
