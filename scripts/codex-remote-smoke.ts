// Full renderer -> trusted Electron IPC -> isolated synthetic Desktop owner. No user data.
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { X509Certificate, randomUUID } from 'node:crypto';
import { OfficeStore } from '../server/store.js';
import { demoSnapshot } from '../src/lib/demo.js';
import { startExportServer } from '../server/federation/export-server.js';
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
let app, exporter;
try {
  const config = path.join(temp, 'export');
  const data = path.join(temp, 'remote-data');
  const host = 'remote-control:env_synthetic_mini';
  await mkdir(config);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=Office Fixture',
      '-keyout',
      path.join(config, 'server-key.pem'),
      '-out',
      path.join(config, 'server-cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  const { readFile } = await import('node:fs/promises');
  const cert = new X509Certificate(await readFile(path.join(config, 'server-cert.pem')));
  const officeId = randomUUID();
  const exportConfig = {
    enabled: true,
    officeId,
    host: '127.0.0.1',
    port: 0,
    token: 'r'.repeat(64),
    sendToken: 's'.repeat(64),
    allowSend: true,
    conversation: true,
    projects: ['*'],
    profileDir: data,
  };
  await writeFile(path.join(config, 'export.json'), JSON.stringify(exportConfig));
  const store = new OfficeStore(data);
  const session = {
    ...demoSnapshot().sessions[0],
    id,
    nativeId: thread,
    provider: 'codex',
    title: 'Synthetic remote mini',
    alias: '',
    origin: { kind: 'interactive', source: 'fixture' },
    relation: { kind: 'root', parentNativeId: null, source: 'fixture' },
  };
  store.upsert([session], 'codex');
  store.close();
  exporter = await startExportServer(data, config, {
    target: async () => null,
    send: async () => {
      throw Error('Native route must not run');
    },
  });
  await mkdir(path.join(home, 'ipc'), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(home, '.codex-global-state.json'),
    JSON.stringify({
      'thread-project-membership-host-ids': { [thread]: host },
      'codex-managed-remote-connections': [{ hostId: host, displayName: 'Synthetic Mac mini' }],
    }),
  );
  const endpoint = path.join(home, 'ipc', 'ipc.sock');
  await new Promise((resolve) => server.listen(endpoint, resolve));
  await chmod(endpoint, 0o600);
  app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(temp, 'profile')}`],
    env: {
      ...process.env,
      ...quietEnv,
      AGENT_OFFICE_DATA_DIR: path.join(temp, 'local-data'),
      AGENT_OFFICE_FEDERATION_DIR: path.join(temp, 'receiver'),
      CODEX_HOME: home,
      CLAUDE_CONFIG_DIR: path.join(temp, 'claude'),
      OPENCLAW_STATE_DIR: path.join(temp, 'openclaw'),
      AGENT_OFFICE_LOCALE: 'ko',
    },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.office);
  await page.locator('.office-guide').waitFor();
  await page.getByRole('button', { name: '직접 둘러볼게요' }).click();
  const peer = {
    officeId,
    endpoint: `https://127.0.0.1:${exporter.server.address().port}/`,
    fingerprint: cert.fingerprint256.replaceAll(':', '').toLowerCase(),
    token: exportConfig.token,
    sendToken: exportConfig.sendToken,
    label: 'Synthetic Mac mini',
    tags: [],
    projects: {},
  };
  await page.evaluate(async (peer) => {
    await window.office.federation({ action: 'enable', enabled: true });
    await window.office.federation({ action: 'add', peer });
  }, peer);
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  await page.getByRole('tab', { name: '연결', exact: true }).click();
  assert.equal(await page.locator('select[name=codexHostId]').inputValue(), '');
  await page.waitForFunction(async () =>
    (await window.office.snapshot()).sessions.some((s) => s.remote),
  );
  const remoteId = await page.evaluate(
    async () => (await window.office.snapshot()).sessions.find((s) => s.remote).id,
  );
  const target = await page.evaluate(
    async (id) => (await window.office.terminals([id]))[id],
    remoteId,
  );
  assert.equal(target.codexRemote, true);
  assert.equal(target.canSend, true);
  await mkdir('.local/codex-remote-smoke', { recursive: true });
  await page.screenshot({ path: '.local/codex-remote-smoke/settings.png' });
  await page.evaluate((id) => window.office.window('main', id), remoteId);
  await page.locator('.terminal-send-chat').waitFor();
  await page
    .locator('.terminal-send-chat')
    .getByText('이 컴퓨터의 Codex 원격 연결', { exact: false })
    .waitFor();
  const composer = page.locator('.terminal-send-chat');
  await composer.locator('textarea').fill('Synthetic remote delivery');
  await composer.getByRole('button', { name: '보내기', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.terminal-send-chat textarea')?.value === '',
  );
  const sends = calls.filter((c) => c.method === 'thread-follower-start-turn');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].version, 3);
  assert.equal(sends[0].hostId, host);
  assert.equal(sends[0].params.conversationId, thread);
  await page.screenshot({ path: '.local/codex-remote-smoke/chat.png' });
  exportConfig.allowSend = false;
  await writeFile(path.join(config, 'export.json'), JSON.stringify(exportConfig));
  await composer.getByRole('button', { name: '전송 대상 다시 확인' }).click();
  // Native checks reject immediately even if the UI still holds one last successful lookup.
  assert.equal(
    await page.evaluate(async (id) => {
      try {
        await window.office.send(id, 'must not send');
        return false;
      } catch {
        return true;
      }
    }, remoteId),
    true,
  );
  assert.equal(calls.filter((c) => c.method === 'thread-follower-start-turn').length, 1);
  console.log(
    'PASS Electron UI -> worker -> authenticated HTTPS permission -> synthetic remote Codex owner: automatic exact-identity host, one dispatch, permission revocation',
  );
} finally {
  await app?.close();
  await exporter?.close();
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
