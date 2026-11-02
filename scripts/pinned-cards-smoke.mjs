import { _electron as electron, expect } from 'playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { quietEnv } from './quiet-smoke.mjs';

// Pinned cards come back where they were when the app starts again; one whose colleague is gone
// stays closed, and with the setting off nothing comes back. Runs quiet (no focus taken).
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
let app;
try {
  await mkdir(data, { recursive: true });
  await pinned([
    { target: { id: 'claude:claude-test', news: false }, pin: 'top', bounds: at },
    { target: { id: 'claude:gone', news: false }, pin: 'pinned', bounds: at },
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
  // The person closes it: the next start leaves it closed.
  // A pinned card closes for good: its window goes away before the call can answer.
  await card.evaluate(() => window.office.card('close')).catch(() => {});
  await expect.poll(() => card.isClosed()).toBe(true);
  await app.close();
  app = await launch();
  const main = await app.firstWindow();
  await main.waitForFunction(() => !!window.office);
  await main.waitForTimeout(3000);
  assert.equal(cards(app).length, 0, 'a card closed by the person stays closed');
  // Turned off in settings, a pinned card is not brought back.
  await main.evaluate(() => window.office.preferences({ restorePinnedCards: false }));
  await app.close();
  await pinned([{ target: { id: 'claude:claude-test', news: false }, pin: 'pinned', bounds: at }]);
  app = await launch();
  await (await app.firstWindow()).waitForFunction(() => !!window.office);
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(cards(app).length, 0, 'the setting off brings nothing back');
  console.log(
    JSON.stringify({ ok: true, restored: true, closedStaysClosed: true, settingOff: true }),
  );
} finally {
  if (app) await app.close();
  await rm(temp, { recursive: true, force: true });
}
