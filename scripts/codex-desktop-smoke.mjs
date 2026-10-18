// Full renderer -> trusted Electron IPC -> isolated synthetic Desktop owner. No user data.
import { _electron as electron } from 'playwright';
import net from 'node:net';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
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
  const targets = await page.evaluate((id) => window.office.terminals([id]), id);
  assert.equal(targets[id].desktop, true);
  assert.equal(targets[id].canSend, true);
  const sent = await page.evaluate((id) => window.office.send(id, 'Synthetic IPC delivery'), id);
  assert.equal(sent.status, 'sent');
  const sends = calls.filter((x) => x.method === 'thread-follower-start-turn');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].params.conversationId, thread);
  assert.equal(sends[0].targetClientId, 'smoke-owner');
  assert.deepEqual(sends[0].params.turnStart.context, { inheritThreadSettings: true });
  assert.equal(sends[0].params.turnStart.request.input[0].text, 'Synthetic IPC delivery');
  console.log(
    'PASS isolated Electron renderer -> Desktop owner: one send, settings inherited; no user conversations used',
  );
} finally {
  await app?.close();
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
