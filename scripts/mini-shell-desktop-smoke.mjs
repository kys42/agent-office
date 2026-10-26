// The mini terminal in the real app, on a throwaway tmux server and a temp profile:
// open from a colleague's card → its own window appears beside the big office → type → close
// the window → reopen (same shell, one window) → hide the screen content (the window closes) →
// quit and relaunch the app → reopen (still the same shell).
// `npm run build && npm run test:shell:desktop`
// (AGENT_OFFICE_EXECUTABLE=<packaged binary> checks the packaged app's native module instead).
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { quietEnv } from './quiet-smoke.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'agent-office-shell-'));
const project = path.join(temp, 'project');
const server = `office-shell-desktop-${process.pid}`;
const claude = path.join(temp, 'claude');
const shots = process.env.AGENT_OFFICE_SMOKE_SHOTS;
const now = new Date().toISOString();
await mkdir(project, { recursive: true });
await mkdir(path.join(claude, 'projects', 'demo'), { recursive: true });
await writeFile(
  path.join(claude, 'projects', 'demo', 'shell.jsonl'),
  [
    {
      type: 'user',
      sessionId: 'shell-smoke',
      timestamp: now,
      cwd: project,
      message: { role: 'user', content: '미니 터미널 확인' },
    },
    {
      type: 'assistant',
      sessionId: 'shell-smoke',
      timestamp: now,
      message: {
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'text', text: '확인할게요.' }],
        stop_reason: 'end_turn',
      },
    },
  ]
    .map((x) => JSON.stringify(x))
    .join('\n') + '\n',
);
const tmux = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((f) => {
  try {
    execFileSync(f, ['-V']);
    return true;
  } catch {
    return false;
  }
});
assert.ok(tmux, 'tmux is installed');
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
      AGENT_OFFICE_SHELL_SERVER: server,
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: path.join(temp, 'codex'),
      OPENCLAW_STATE_DIR: path.join(temp, 'openclaw'),
    },
  });
const button = /^(Mini terminal|미니 터미널)$/;
const close = /^(Close \(keeps running\)|닫기 \(계속 실행\))$/;
const isShell = (p) => p.url().endsWith('#shell');
/** Every window's page URL and bounds, from the main process. */
const windows = (app) =>
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
/**
 * Opens the colleague's card in the big window and the mini terminal from it: the terminal is a
 * window of its own, returned with its page.
 */
async function openFromCard(app, page) {
  const id = await page.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const s = (await window.office.snapshot()).sessions.find((x) => x.nativeId === 'shell-smoke');
      if (s) return s.id;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('session not collected');
  });
  await page.evaluate((id) => window.office.window('main', id), id);
  const opened = app.windows().find(isShell)
    ? Promise.resolve(app.windows().find(isShell))
    : app.waitForEvent('window', { predicate: isShell, timeout: 15000 });
  await page.locator('.inspector-card').getByRole('button', { name: button }).click();
  const shell = await opened;
  await shell.locator('.mini-shell[data-status="live"]').waitFor({ timeout: 15000 });
  // Nothing of the terminal is drawn inside the big office.
  assert.equal(await page.locator('.mini-shell').count(), 0);
  return shell;
}
/** The terminal window opens beside the big office (or just inside its right edge). */
async function assertBeside(app) {
  const all = await windows(app);
  const main = all.find((w) => !w.url.includes('#'));
  const shell = all.filter((w) => w.url.endsWith('#shell'));
  assert.equal(shell.length, 1, 'one terminal window');
  const [{ bounds: s, area, visible }] = shell;
  const m = main.bounds;
  assert.ok(visible, 'the terminal window is shown');
  assert.ok(
    s.x >= area.x &&
      s.y >= area.y &&
      s.x + s.width <= area.x + area.width &&
      s.y + s.height <= area.y + area.height,
    `inside the work area: ${JSON.stringify({ s, area })}`,
  );
  const right = s.x >= m.x + m.width;
  const left = s.x + s.width <= m.x;
  const edge = Math.abs(s.x + s.width - (Math.min(m.x + m.width, area.x + area.width) - 8)) <= 1;
  assert.ok(right || left || edge, `beside the big office: ${JSON.stringify({ s, m })}`);
  return s;
}
let app;
try {
  app = await launch();
  let page = await app.firstWindow();
  const guide = page.getByRole('button', { name: /^(Explore on my own|직접 둘러볼게요)$/ });
  await guide.click({ timeout: 5000 }).catch(() => {});
  let shell = await openFromCard(app, page);
  const placed = await assertBeside(app);
  let rows = shell.locator('.mini-shell .xterm-rows');
  await shell.locator('.mini-shell .xterm').click();
  await shell.keyboard.type('echo office-$((40+2)) > marker.txt; echo done-$((1+1))');
  await shell.keyboard.press('Enter');
  await rows.getByText('done-2').first().waitFor({ timeout: 10000 });
  assert.equal((await readFile(path.join(project, 'marker.txt'), 'utf8')).trim(), 'office-42');
  if (shots) {
    await shell.screenshot({ path: path.join(shots, 'mini-shell-desktop-window.png') });
    await page.screenshot({ path: path.join(shots, 'mini-shell-desktop-office.png') });
  }
  // A flood (several MB) goes through flow control (pause/resume) and the shell stays usable.
  await shell.keyboard.type("head -c 4000000 /dev/zero | tr '\\0' y; echo; echo flood-$((2+3))");
  await shell.keyboard.press('Enter');
  await rows.getByText('flood-5').first().waitFor({ timeout: 60000 });
  // Asked again while open: the same window comes forward, never a second one.
  await page.locator('.inspector-card').getByRole('button', { name: button }).click();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await windows(app)).filter((w) => w.url.endsWith('#shell')).length, 1);
  // Other windows (the big office) cannot drive the shell's window or forge its keys.
  await assert.rejects(page.evaluate(() => window.office.shell.window('target')));
  // Closing the window only detaches.
  const closed = shell.waitForEvent('close');
  await shell.getByRole('button', { name: close }).click();
  await closed;
  const listed = await page.evaluate(() => window.office.shell.command({ type: 'list' }));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].cwd, project);
  assert.equal(listed[0].attached, 0);
  shell = await openFromCard(app, page);
  const again = await assertBeside(app);
  assert.deepEqual(again, placed, 'opens in the same place beside the office');
  rows = shell.locator('.mini-shell .xterm-rows');
  await rows.getByText('flood-5').first().waitFor({ timeout: 10000 });
  // Hiding the screen's content closes the terminal window; the shell keeps running.
  const hidden = shell.waitForEvent('close');
  await page.evaluate(() => window.office.preferences({ privacy: true }));
  await hidden;
  await assert.rejects(
    page.evaluate(async () => {
      const s = (await window.office.snapshot()).sessions.find((x) => x.nativeId === 'shell-smoke');
      return window.office.shell.window('open', { id: s.id, cwd: '' });
    }),
  );
  await page.evaluate(() => window.office.preferences({ privacy: false }));
  assert.equal(
    (await page.evaluate(() => window.office.shell.command({ type: 'list' })))[0].name,
    listed[0].name,
  );
  // Quit the app and come back: the same shell, with what was on its screen.
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  shell = await openFromCard(app, page);
  await assertBeside(app);
  rows = shell.locator('.mini-shell .xterm-rows');
  await rows.getByText('flood-5').first().waitFor({ timeout: 10000 });
  const after = await page.evaluate(() => window.office.shell.command({ type: 'list' }));
  assert.deepEqual(
    after.map((s) => s.name),
    listed.map((s) => s.name),
  );
  // Keys from a forged attachment id never reach a shell.
  await shell.evaluate(() =>
    window.office.shell.input('00000000-0000-0000-0000-000000000000', 'touch forged\r'),
  );
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(readFile(path.join(project, 'forged')));
  console.log(JSON.stringify({ ok: true, server, shell: listed[0].name, placed }));
} finally {
  await app?.close().catch(() => {});
  try {
    execFileSync(tmux, ['-L', server, 'kill-server'], { stdio: 'ignore' });
  } catch {}
  await rm(temp, { recursive: true, force: true });
}
