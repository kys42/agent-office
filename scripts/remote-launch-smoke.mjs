// Quiet, isolated renderer -> trusted main confirmation -> worker -> real HTTPS exporter.
// No personal agent, terminal or conversation is used.
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { X509Certificate, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { OfficeStore } from '../server/store.ts';
import { demoSnapshot } from '../src/lib/demo.ts';
import { startExportServer } from '../server/federation/export-server.ts';
import { quietEnv } from './quiet-smoke.mjs';
const root = await mkdtemp(path.join(os.tmpdir(), 'office-launch-'));
let app, exporter;
try {
  const config = path.join(root, 'config'),
    data = path.join(root, 'remote-data');
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
      '/CN=Fixture',
      '-keyout',
      path.join(config, 'server-key.pem'),
      '-out',
      path.join(config, 'server-cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  const cert = new X509Certificate(await readFile(path.join(config, 'server-cert.pem')));
  const cfg = {
    enabled: true,
    officeId: randomUUID(),
    host: '127.0.0.1',
    port: 0,
    token: 'r'.repeat(64),
    sendToken: 's'.repeat(64),
    allowSend: true,
    allowLaunch: true,
    profileDir: data,
    projects: ['*'],
    conversation: true,
  };
  const save = () => writeFile(path.join(config, 'export.json'), JSON.stringify(cfg));
  await save();
  const session = {
    ...demoSnapshot().sessions[0],
    id: 'codex:' + randomUUID(),
    provider: 'codex',
    nativeId: randomUUID(),
    project: 'launch-fixture',
    workspace: undefined,
    cwd: path.join(root, 'project'),
    alias: '',
    title: 'Launch source',
    area: undefined,
    zone: 'office',
    origin: { kind: 'interactive', source: 'fixture' },
    relation: { kind: 'root', parentNativeId: null, source: 'fixture' },
  };
  const store = new OfficeStore(data);
  store.upsert([session], 'codex');
  store.close();
  const launches = [];
  exporter = await startExportServer(
    data,
    config,
    {
      target: async () => null,
      send: async () => {
        throw Error('Unexpected send');
      },
    },
    {
      status: async () => ({ tmux: true, orca: true }),
      start: async (cwd, spec, authorize) => {
        authorize();
        launches.push({ cwd, spec });
        const db = new OfficeStore(data);
        db.upsert(
          [
            {
              ...session,
              id: 'codex:' + randomUUID(),
              nativeId: randomUUID(),
              title: 'Synthetic launched',
              startedAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
          'codex',
        );
        db.close();
        return 'started';
      },
    },
  );
  app = await electron.launch({
    executablePath: process.env.AGENT_OFFICE_EXECUTABLE,
    args: [
      ...(process.env.AGENT_OFFICE_EXECUTABLE ? [] : ['.']),
      `--user-data-dir=${path.join(root, 'profile')}`,
    ],
    env: {
      ...process.env,
      ...quietEnv,
      AGENT_OFFICE_DATA_DIR: path.join(root, 'local-data'),
      AGENT_OFFICE_FEDERATION_DIR: path.join(root, 'receiver'),
      CODEX_HOME: path.join(root, 'codex'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      OPENCLAW_STATE_DIR: path.join(root, 'openclaw'),
      AGENT_OFFICE_LOCALE: 'ko',
    },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.office);
  await page.getByRole('button', { name: '직접 둘러볼게요' }).click();
  await app.evaluate(({ dialog }) => {
    globalThis.launchDialogs = [];
    dialog.showMessageBox = async (...args) => {
      globalThis.launchDialogs.push(args.at(-1));
      return { response: 1, checkboxChecked: false };
    };
  });
  await page.evaluate(
    async (peer) => {
      await window.office.federation({ action: 'enable', enabled: true });
      await window.office.federation({ action: 'add', peer });
    },
    {
      officeId: cfg.officeId,
      endpoint: `https://127.0.0.1:${exporter.server.address().port}/`,
      fingerprint: cert.fingerprint256.replaceAll(':', '').toLowerCase(),
      token: cfg.token,
      sendToken: cfg.sendToken,
      label: 'Synthetic Mini',
      tags: [],
      projects: {},
    },
  );
  await page.waitForFunction(async () =>
    (await window.office.snapshot()).sessions.some((s) => s.remote),
  );
  await page.getByRole('tab', { name: 'Synthetic Mini', exact: true }).click();
  await page
    .getByRole('button', { name: '원격 사무실에 새 에이전트 소환', exact: true })
    .first()
    .click();
  const modal = page.getByRole('dialog', { name: '원격 사무실에 새 에이전트 소환' });
  await modal.getByLabel('에이전트 이름', { exact: true }).fill('Synthetic colleague');
  await modal.getByLabel('원격 컴퓨터의 터미널').selectOption('orca');
  await modal.getByLabel('첫 메시지 (선택)', { exact: true }).fill('Literal first message');
  await modal.getByRole('button', { name: '연결과 이름 확인' }).click();
  await modal.getByRole('button', { name: '원격에서 소환하기' }).click();
  await modal.getByText('원격 세션이 시작됐어요. 첫 대화가 감지되면 동료가 나타나요.').waitFor();
  assert.equal(launches.length, 1);
  assert.equal(launches[0].cwd, session.cwd);
  assert.equal(launches[0].spec.host, 'orca');
  const dialogs = await app.evaluate(() => globalThis.launchDialogs);
  assert.equal(dialogs.length, 1);
  assert.ok(dialogs[0].detail.includes('Synthetic Mini'));
  assert.ok(dialogs[0].detail.includes(session.cwd));
  await page.waitForFunction(async () =>
    (await window.office.snapshot()).sessions.some((s) => s.title === 'Synthetic launched'),
  );
  cfg.allowLaunch = false;
  await save();
  const blocked = await page.evaluate(async () => {
    const s = (await window.office.snapshot()).sessions.find((s) => s.remote);
    try {
      await window.office.remoteLaunch(s.id, 'start', {
        provider: 'claude',
        host: 'tmux',
        name: 'blocked',
        initialMessage: '',
      });
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(blocked, true);
  assert.equal(launches.length, 1);
  console.log(
    'PASS quiet Electron remote launch: native destination confirmation, one authenticated create, collected colleague appears, revocation blocks creation',
  );
} finally {
  await app?.close();
  await exporter?.close();
  await rm(root, { recursive: true, force: true });
}
