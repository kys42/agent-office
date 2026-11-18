// Optional private connection file. Only aggregate results are printed; no remote text/images.
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { quietEnv } from './quiet-smoke.mjs';
async function poll(page, predicate) {
  const deadline = Date.now() + 20000;
  while (!(await page.evaluate(predicate))) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for desktop state');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
const file = process.argv[2];
if (!file) throw new Error('Pass a private connection.json path');
const { sendToken: _sendToken, ...peer } = JSON.parse(await readFile(file, 'utf8'));
const temp = await mkdtemp(path.join(os.tmpdir(), 'office-peer-desktop-'));
let app;
try {
  // The real-LAN smoke must NEVER dispatch to a user's running agent. Import read-only credentials.
  const readOnlyFile = path.join(temp, 'connection.json');
  await writeFile(readOnlyFile, JSON.stringify(peer), { mode: 0o600 });
  const claude = path.join(temp, 'claude');
  await mkdir(path.join(claude, 'projects', 'test'), { recursive: true });
  await writeFile(
    path.join(claude, 'projects', 'test', 'local.jsonl'),
    JSON.stringify({
      type: 'user',
      sessionId: 'local-peer-fixture',
      timestamp: new Date().toISOString(),
      cwd: '/tmp/office-peer-fixture',
      message: { role: 'user', content: 'Local beta connection fixture' },
    }) + '\n',
  );
  app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(temp, 'profile')}`],
    env: {
      ...process.env,
      ...quietEnv,
      AGENT_OFFICE_LOCALE: 'ko',
      AGENT_OFFICE_DATA_DIR: path.join(temp, 'data'),
      AGENT_OFFICE_FEDERATION_DIR: path.join(temp, 'federation'),
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: path.join(temp, 'codex'),
      OPENCLAW_STATE_DIR: path.join(temp, 'openclaw'),
    },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.office-guide').waitFor();
  await page.getByRole('button', { name: '직접 둘러볼게요' }).click();
  await poll(page, async () => (await window.office.snapshot()).sessions.length === 1);
  assert.equal(
    (await page.evaluate(() => window.office.federation({ action: 'state' }))).enabled,
    false,
  );
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  await page.getByRole('switch', { name: '여러 사무실 연결 베타 켜기' }).click();
  await page.locator('.federation-settings input[type=file]').setInputFiles(readOnlyFile);
  await poll(page, async () => (await window.office.snapshot()).sessions.some((s) => s.remote));
  const summary = await page.evaluate(async () => {
    const s = await window.office.snapshot();
    const remote = s.sessions.find((x) => x.remote);
    if (!remote)
      throw new Error(JSON.stringify({ localCount: s.sessions.length, federation: s.federation }));
    const detail = await window.office.detail(remote.id);
    const denied = [];
    for (const fn of [
      () => window.office.resume(remote.id),
      () => window.office.reveal(remote.id),
      () => window.office.send(remote.id, 'must not send'),
      () => window.office.patch(remote.id, { pinned: true }),
    ]) {
      try {
        await fn();
        denied.push(false);
      } catch {
        denied.push(true);
      }
    }
    return {
      local: s.sessions.filter((x) => !x.remote).length,
      remote: s.sessions.filter((x) => x.remote).length,
      remoteId: remote.id,
      detailEvents: detail.events.length,
      denied,
    };
  });
  assert.equal(summary.local, 1);
  assert.ok(summary.remote > 0);
  assert.ok(summary.denied.every(Boolean));
  await page.evaluate((id) => window.office.window('main', id), summary.remoteId);
  await page.locator('.remote-source').waitFor();
  assert.equal(await page.locator('.card-composer textarea').count(), 0);
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  await page.getByRole('switch', { name: '여러 사무실 연결 베타 켜기' }).click();
  await poll(page, async () => !(await window.office.snapshot()).sessions.some((s) => s.remote));
  const preferences = JSON.parse(
    await readFile(path.join(temp, 'federation', 'peers.json'), 'utf8'),
  );
  assert.equal(preferences.enabled, false);
  assert.deepEqual(errors, []);
  const { remoteId: _id, ...counts } = summary;
  console.log(JSON.stringify({ ...counts, uiErrors: errors.length, disabledReturnsLocal: true }));
} finally {
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
