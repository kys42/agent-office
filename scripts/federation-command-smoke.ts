// Fully synthetic HTTPS peer + real Electron IPC. Never imports personal connection files.
import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { OfficeStore } from '../server/store.js';
import { demoSnapshot } from '../src/lib/demo.js';
import { startExportServer } from '../server/federation/export-server.js';
const root = mkdtempSync(path.join(os.tmpdir(), 'office-command-desktop-'));
const configDir = path.join(root, 'config');
mkdirSync(configDir);
const data = path.join(root, 'source');
const store = new OfficeStore(data);
const fixture = demoSnapshot().sessions[0];
store.upsert([{ ...fixture, attachedTo: undefined, zone: 'office' }], fixture.provider);
store.close();
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
    '/CN=Fixture',
    '-keyout',
    path.join(configDir, 'server-key.pem'),
    '-out',
    path.join(configDir, 'server-cert.pem'),
  ],
  { stdio: 'ignore' },
);
const config = {
  enabled: true,
  officeId: randomUUID(),
  host: '127.0.0.1',
  port: 0,
  token: 'r'.repeat(64),
  sendToken: 's'.repeat(64),
  allowSend: true,
  profileDir: data,
  conversation: true,
  projects: ['*'],
};
writeFileSync(path.join(configDir, 'export.json'), JSON.stringify(config));
const sent: string[] = [];
const server = await startExportServer(data, configDir, {
  target: async () => ({
    kind: 'codex',
    label: '',
    canFocus: false,
    canSend: true,
    status: 'desktop',
    desktop: true,
    queues: false,
  }),
  send: async (s, text, authorize) => {
    authorize();
    assert.equal(s.id, fixture.id);
    sent.push(text);
  },
});
let app;
try {
  const cert = new X509Certificate(readFileSync(path.join(configDir, 'server-cert.pem')));
  const federation = path.join(root, 'receiver');
  mkdirSync(federation);
  writeFileSync(
    path.join(federation, 'peers.json'),
    JSON.stringify({
      enabled: true,
      peers: [
        {
          officeId: config.officeId,
          endpoint: `https://127.0.0.1:${(server.server.address() as { port: number }).port}/`,
          token: config.token,
          sendToken: config.sendToken,
          fingerprint: cert.fingerprint256.replaceAll(':', '').toLowerCase(),
          label: 'Synthetic office',
          tags: [],
          projects: {},
        },
      ],
    }),
  );
  app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(root, 'profile')}`],
    env: {
      ...process.env,
      AGENT_OFFICE_LOCALE: 'ko',
      AGENT_OFFICE_DATA_DIR: path.join(root, 'local'),
      AGENT_OFFICE_FEDERATION_DIR: federation,
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      CODEX_HOME: path.join(root, 'codex'),
      OPENCLAW_STATE_DIR: path.join(root, 'openclaw'),
    },
  });
  const page = await app.firstWindow();
  const deadline = Date.now() + 20000;
  while (
    !(await page.evaluate(async () =>
      (await window.office?.snapshot())?.sessions.some((s) => s.remote),
    ))
  ) {
    assert.ok(Date.now() < deadline, 'remote fixture did not load');
    await new Promise((r) => setTimeout(r, 200));
  }
  const result = await page.evaluate(async () => {
    const id = (await window.office!.snapshot()).sessions.find((s) => s.remote)!.id;
    const targets = await window.office!.terminals([id]);
    const sent = await window.office!.send(id, 'Synthetic desktop message');
    let replaceDenied = false;
    try {
      await window.office!.send(id, 'Never dispatch', {
        replaceDraft: { text: 'anything' },
      } as any);
    } catch {
      replaceDenied = true;
    }
    await window.office!.federation({ action: 'enable', enabled: false });
    let disabledDenied = false;
    try {
      await window.office!.send(id, 'Never dispatch');
    } catch {
      disabledDenied = true;
    }
    return {
      target: targets[id]?.canSend,
      desktop: targets[id]?.desktop,
      queues: targets[id]?.queues,
      sent: sent.status,
      replaceDenied,
      disabledDenied,
    };
  });
  assert.deepEqual(result, {
    target: true,
    desktop: true,
    queues: false,
    sent: 'sent',
    replaceDenied: true,
    disabledDenied: true,
  });
  assert.deepEqual(sent, ['Synthetic desktop message']);
  console.log(
    JSON.stringify({
      syntheticDesktopSend: true,
      dispatches: sent.length,
      replaceDenied: true,
      disabledDenied: true,
    }),
  );
} finally {
  await app?.close();
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
