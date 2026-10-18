import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const temp = await mkdtemp(path.join(os.tmpdir(), 'office-manager-desktop-'));
let app;
try {
  const cli = path.join(temp, 'bin');
  await mkdir(cli);
  // Emits provider protocol, while the real Electron runtime, tmux, runner and Office CLI run.
  await writeFile(
    path.join(cli, 'codex'),
    `#!${process.execPath}\nconst cp=require('node:child_process');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const office=JSON.parse(cp.execFileSync('./office',['overview','{}'],{encoding:'utf8'}));cp.execFileSync('./office',['show_briefing','{}'],{encoding:'utf8'});console.log(JSON.stringify({type:'thread.started',thread_id:'native-manager-smoke'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Office verified: '+office.sessions.length}}));console.log(JSON.stringify({type:'turn.completed'}));});\n`,
    { mode: 0o700 },
  );
  app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(temp, 'profile')}`],
    env: {
      ...process.env,
      PATH: cli + path.delimiter + process.env.PATH,
      AGENT_OFFICE_DATA_DIR: path.join(temp, 'data'),
      AGENT_OFFICE_LOCALE: 'ko',
      CLAUDE_CONFIG_DIR: path.join(temp, 'claude'),
      CODEX_HOME: path.join(temp, 'codex'),
      OPENCLAW_STATE_DIR: path.join(temp, 'openclaw'),
    },
  });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: '직접 둘러볼게요' }).click();
  await page.locator('[data-station-id="office:manager"] .office-pet').click();
  await page.getByRole('button', { name: '매니저 출근', exact: true }).click();
  await page.waitForFunction(async () => (await window.office.manager({ action: 'status' })).ready);
  // The manager has an ordinary project desk, bubble and card in every dock view.
  await page.evaluate(() => window.office.window('mini'));
  const dock =
    app.windows().find((p) => p.url().includes('#mini')) ?? (await app.waitForEvent('window'));
  await dock.waitForSelector('.desk-pet');
  await dock.evaluate(() => window.office.dock('floor'));
  await dock.waitForSelector('.desk-floor');
  await dock.locator('[data-project-key="office:manager-project"]').waitFor();
  const cardOpened = app.waitForEvent('window');
  await dock.locator('[data-station-id="office:manager"] .office-pet').click();
  const card = await cardOpened;
  await card.getByRole('button', { name: '이 카드 고정', exact: true }).click();
  const input = card.locator('.terminal-send textarea');
  await input.fill('Inspect the office from this popup.');
  await input.press('Enter');
  await card.locator('.conversation-message').filter({ hasText: 'Office verified: 0' }).waitFor();
  await card.locator('.manager-rich-card').waitFor();
  await dock.locator('[data-station-id="office:manager"] .speech-bubble').waitFor();
  const state = await page.evaluate(() => window.office.manager({ action: 'status' }));
  assert.equal(state.sessionId, 'native-manager-smoke');
  assert.deepEqual(state.ownedSessionIds, ['codex:native-manager-smoke']);
  assert.equal(state.jobs[0].status, 'completed');
  await input.fill('Preserve my draft');
  await card.getByRole('button', { name: '이 카드 고정', exact: true }).click();
  await card.evaluate(() => window.office.card('close'));
  await dock.locator('[data-station-id="office:manager"] .office-pet').click();
  await input.waitFor();
  assert.equal(await input.inputValue(), 'Preserve my draft');
  await card.getByRole('button', { name: '이 카드 고정', exact: true }).click();
  assert.equal((await card.evaluate(() => window.office.cardState())).pinned, true);
  await input.fill('A second request from the flag view.');
  await card.getByRole('button', { name: '보내기', exact: true }).click();
  await card.waitForFunction(
    async () =>
      (await window.office.manager({ action: 'status' })).jobs.filter(
        (j) => j.status === 'completed',
      ).length === 2,
  );
  await card
    .locator('.conversation-message.category-reply')
    .filter({ hasText: 'Office verified: 0' })
    .nth(1)
    .waitFor();
  await card.screenshot({ path: '.local/manager-popup.png' });
  await dock.screenshot({ path: '.local/manager-floor.png' });
  // Old collected native IDs also reach the manager queue, even with terminal send disabled.
  await page.evaluate(() => window.office.terminalSend(false));
  const sent = await page.evaluate(() =>
    window.office.send('codex:native-manager-smoke', 'Old card route'),
  );
  assert.equal(sent.status, 'sent');
  await page.waitForFunction(
    async () =>
      (await window.office.manager({ action: 'status' })).jobs.filter(
        (j) => j.status === 'completed',
      ).length === 3,
  );
  await page.evaluate(() => window.office.manager({ action: 'stop' }));
  assert.equal(
    (await page.evaluate(() => window.office.manager({ action: 'status' }))).running,
    false,
  );
  console.log(
    JSON.stringify({
      ok: true,
      desktopIPC: true,
      tmux: true,
      electronNodeRuntime: true,
      skillCLI: true,
      dedicatedConversation: true,
      popupSend: true,
      flagView: true,
      draftPersistence: true,
      legacyNativeRoute: true,
    }),
  );
} finally {
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
