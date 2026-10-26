// The mini terminal in the real app, on a throwaway tmux server and a temp profile:
// open from a colleague's card → type → close → reopen (same shell) → quit and relaunch the
// app → reopen (still the same shell). `npm run build && npm run test:shell:desktop`
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
/** Opens the colleague's card in the big window and the mini terminal from it. */
async function openFromCard(page) {
  const id = await page.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const s = (await window.office.snapshot()).sessions.find((x) => x.nativeId === 'shell-smoke');
      if (s) return s.id;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('session not collected');
  });
  await page.evaluate((id) => window.office.window('main', id), id);
  await page.locator('.inspector-card').getByRole('button', { name: button }).click();
  await page.locator('.mini-shell[data-status="live"]').waitFor({ timeout: 15000 });
  return page.locator('.mini-shell .xterm-rows');
}
let app;
try {
  app = await launch();
  let page = await app.firstWindow();
  const guide = page.getByRole('button', { name: /^(Explore on my own|직접 둘러볼게요)$/ });
  await guide.click({ timeout: 5000 }).catch(() => {});
  let rows = await openFromCard(page);
  await page.locator('.mini-shell .xterm').click();
  await page.keyboard.type('echo office-$((40+2)) > marker.txt; echo done-$((1+1))');
  await page.keyboard.press('Enter');
  await rows.getByText('done-2').first().waitFor({ timeout: 10000 });
  assert.equal((await readFile(path.join(project, 'marker.txt'), 'utf8')).trim(), 'office-42');
  // A flood (several MB) goes through flow control (pause/resume) and the shell stays usable.
  await page.keyboard.type("head -c 4000000 /dev/zero | tr '\\0' y; echo; echo flood-$((2+3))");
  await page.keyboard.press('Enter');
  await rows.getByText('flood-5').first().waitFor({ timeout: 60000 });
  // Closing the panel only detaches.
  await page.getByRole('button', { name: close }).click();
  await page.locator('.mini-shell').waitFor({ state: 'detached' });
  const listed = await page.evaluate(() => window.office.shell.command({ type: 'list' }));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].cwd, project);
  assert.equal(listed[0].attached, 0);
  rows = await openFromCard(page);
  await rows.getByText('flood-5').first().waitFor({ timeout: 10000 });
  // Quit the app and come back: the same shell, with what was on its screen.
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  rows = await openFromCard(page);
  await rows.getByText('flood-5').first().waitFor({ timeout: 10000 });
  const after = await page.evaluate(() => window.office.shell.command({ type: 'list' }));
  assert.deepEqual(
    after.map((s) => s.name),
    listed.map((s) => s.name),
  );
  // Keys from a forged attachment id never reach a shell.
  await page.evaluate(() =>
    window.office.shell.input('00000000-0000-0000-0000-000000000000', 'touch forged\r'),
  );
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(readFile(path.join(project, 'forged')));
  console.log(JSON.stringify({ ok: true, server, shell: listed[0].name }));
} finally {
  await app?.close().catch(() => {});
  try {
    execFileSync(tmux, ['-L', server, 'kill-server'], { stdio: 'ignore' });
  } catch {}
  await rm(temp, { recursive: true, force: true });
}
