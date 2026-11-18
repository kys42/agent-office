// Full renderer -> trusted Electron IPC -> isolated synthetic Desktop owner. No user data.
import { _electron as electron, chromium } from 'playwright';
import net from 'node:net';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { quietEnv } from './quiet-smoke.mjs';
const temp = await mkdtemp(path.join(os.tmpdir(), 'ao-desktop-send-'));
const home = path.join(temp, 'codex');
const thread = '11111111-2222-3333-4444-555555555555';
const id = `codex:${thread}`;
const calls = [],
  sockets = new Set();
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
      const n = buffer.readUInt32LE();
      const req = JSON.parse(buffer.subarray(4, 4 + n));
      buffer = buffer.subarray(4 + n);
      if (req.type !== 'request') continue;
      calls.push(req);
      const result =
        req.method === 'initialize'
          ? { clientId: 'office-smoke' }
          : req.method === 'thread-owner-discovery'
            ? { supportsUntrustedAppInput: true }
            : req.method === 'thread-follower-read-model-settings'
              ? { settings: { resumeState: 'resumed', mode: 'default', threadSource: 'user' } }
              : { result: { turn: { id: 'synthetic-turn' } } };
      const body = Buffer.from(
        JSON.stringify({
          type: 'response',
          requestId: req.requestId,
          method: req.method,
          resultType: 'success',
          handledByClientId: 'smoke-owner',
          result,
        }),
      );
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    }
  });
});
let app;
let browser;
try {
  await mkdir(path.join(home, 'ipc'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    path.join(home, 'sessions', 'rollout.jsonl'),
    [
      {
        type: 'session_meta',
        timestamp: now,
        payload: { id: thread, cwd: temp, originator: 'Codex Desktop', source: 'vscode' },
      },
      {
        type: 'event_msg',
        timestamp: now,
        payload: { type: 'user_message', message: '합성 Desktop 대화' },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n') + '\n',
  );
  const endpoint = path.join(home, 'ipc', 'ipc.sock');
  await new Promise((resolve) => server.listen(endpoint, resolve));
  await chmod(endpoint, 0o600);
  app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(temp, 'profile')}`],
    env: {
      ...process.env,
      ...quietEnv,
      AGENT_OFFICE_DATA_DIR: path.join(temp, 'data'),
      CODEX_HOME: home,
      CLAUDE_CONFIG_DIR: path.join(temp, 'claude'),
      OPENCLAW_STATE_DIR: path.join(temp, 'openclaw'),
      AGENT_OFFICE_LOCALE: 'en',
    },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.office);
  await page.waitForFunction(
    async (id) => (await window.office.snapshot()).sessions.some((s) => s.id === id),
    id,
  );
  const disabled = await page.evaluate(() => window.office.mobile({ action: 'state' }));
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.running, false);
  const state = await page.evaluate(() =>
    window.office.mobile({ action: 'configure', enabled: true, address: '127.0.0.1', port: 14321 }),
  );
  assert.equal(state.running, true);
  browser = await chromium.launch();
  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 },
    locale: 'ko-KR',
    isMobile: true,
    hasTouch: true,
  });
  await phone.goto(state.url);
  await phone.getByLabel('접속 코드').fill(state.accessCode);
  await phone.getByRole('button', { name: '오피스 연결' }).click();
  await phone.getByRole('button').filter({ hasText: '합성 Desktop 대화' }).first().click();
  await phone.getByLabel('메시지', { exact: true }).fill('Synthetic mobile delivery');
  await phone.getByRole('button', { name: '메시지 보내기', exact: true }).click();
  await phone.getByText('전송이 접수됐습니다. 답변은 대화에 표시됩니다.').waitFor();
  const sends = calls.filter((x) => x.method === 'thread-follower-start-turn');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].params.conversationId, thread);
  assert.equal(sends[0].params.turnStart.request.input[0].text, 'Synthetic mobile delivery');
  const evidence = path.resolve('.local/mobile-smoke');
  await mkdir(evidence, { recursive: true });
  await phone.screenshot({ path: path.join(evidence, 'chat.png') });
  await phone.getByRole('button', { name: '목록으로' }).click();
  await phone.screenshot({ path: path.join(evidence, 'list.png') });
  await page.evaluate(() => window.office.mobile({ action: 'rotate' }));
  await phone.reload();
  await phone.getByRole('button', { name: '오피스 연결' }).waitFor();
  await page.evaluate(() =>
    window.office.mobile({
      action: 'configure',
      enabled: false,
      address: '127.0.0.1',
      port: 14321,
    }),
  );
  assert.equal(
    (await page.evaluate(() => window.office.mobile({ action: 'state' }))).running,
    false,
  );
  console.log(
    'PASS isolated mobile browser -> running Electron -> synthetic Desktop owner: one dispatch, revocation, shutdown',
  );
} finally {
  await browser?.close();
  await app?.close();
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
