import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { OfficeStore } from '../server/store.js';
import { demoSnapshot } from '../src/lib/demo.js';
import { startExportServer } from '../server/federation/export-server.js';
import { peerRequest, PeerError } from '../server/federation/transport.js';
import { targetResponseSchema, sendResponseSchema } from '../server/federation/command-protocol.js';
import { wireId } from '../server/federation/protocol.js';
import { PeerManager } from '../server/federation/peers.js';
import type { PeerInput } from '../src/shared/federation.js';
import type { PeerSender } from '../server/federation/sender.js';

async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'office-commands-'));
  const data = path.join(root, 'data'),
    configDir = path.join(root, 'config');
  mkdirSync(configDir);
  const writer = new OfficeStore(data);
  const s = demoSnapshot().sessions[0];
  writer.upsert([s], s.provider);
  writer.close();
  const original = readFileSync(path.join(data, 'office.sqlite'));
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
      '/CN=Office Test',
      '-keyout',
      path.join(configDir, 'server-key.pem'),
      '-out',
      path.join(configDir, 'server-cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  const cert = new X509Certificate(readFileSync(path.join(configDir, 'server-cert.pem')));
  const config = {
    enabled: true,
    officeId: randomUUID(),
    host: '127.0.0.1',
    port: 0,
    token: 'r'.repeat(64),
    conversation: true,
    projects: ['*'],
    allowSend: true,
    profileDir: data,
    sendToken: 's'.repeat(64),
  };
  const save = () => writeFileSync(path.join(configDir, 'export.json'), JSON.stringify(config));
  save();
  const sent: string[] = [];
  let beforeSend: (() => Promise<void>) | undefined;
  let fail = false;
  const sender: PeerSender = {
    target: async () => ({
      kind: 'codex',
      label: 'PRIVATE HANDLE',
      canFocus: true,
      status: 'queue',
      queues: true,
      canSend: true,
    }),
    send: async (session, text, authorize) => {
      await beforeSend?.();
      authorize();
      assert.equal(session.id, s.id);
      sent.push(text);
      if (fail) throw new Error('PRIVATE NATIVE ERROR');
    },
  };
  let server = await startExportServer(data, configDir, sender);
  const peer: PeerInput = {
    officeId: config.officeId,
    endpoint: `https://127.0.0.1:${(server.server.address() as { port: number }).port}/`,
    fingerprint: cert.fingerprint256.replaceAll(':', '').toLowerCase(),
    token: config.sendToken,
    label: 'Test office',
    tags: [],
    projects: {},
  };
  const id = wireId(s.id);
  const targets = async () =>
    targetResponseSchema.parse(
      await peerRequest(peer, '/office/v1/commands/targets', undefined, { body: { ids: [id] } }),
    );
  const send = async (body: unknown) =>
    sendResponseSchema.parse(
      await peerRequest(peer, '/office/v1/commands/send', undefined, { body }),
    );
  return {
    config,
    save,
    peer,
    sent,
    id,
    data,
    targets,
    send,
    setBefore: (fn?: () => Promise<void>) => (beforeSend = fn),
    fail: () => (fail = true),
    restart: async () => {
      await server.close();
      server = await startExportServer(data, configDir, sender);
      peer.endpoint = `https://127.0.0.1:${(server.server.address() as { port: number }).port}/`;
    },
    close: async () => {
      await server.close();
      assert.deepEqual(readFileSync(path.join(data, 'office.sqlite')), original);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('command credential, existing desktop setting and shared project all gate sends', async () => {
  const f = await setup();
  try {
    await assert.rejects(
      peerRequest({ ...f.peer, token: f.config.token }, '/office/v1/commands/targets', undefined, {
        body: { ids: [f.id] },
      }),
      (e) => e instanceof PeerError && e.code === 403,
    );
    const target = await f.targets();
    assert.ok(!JSON.stringify(target).includes('PRIVATE'));
    assert.equal(target.targets[f.id]?.canSend, true);
    const command = {
      epoch: target.epoch,
      requestId: randomUUID(),
      id: f.id,
      text: 'fixture message',
    };
    f.config.allowSend = false;
    f.save();
    await assert.rejects(f.send(command));
    f.config.allowSend = true;
    f.save();
    writeFileSync(path.join(f.data, 'terminal-send.json'), '{"enabled":false}');
    await assert.rejects(f.send(command));
    writeFileSync(path.join(f.data, 'terminal-send.json'), '{"enabled":true}');
    f.config.projects = [];
    f.save();
    await assert.rejects(f.send(command));
    assert.deepEqual(f.sent, []);
    f.config.projects = ['*'];
    f.save();
    assert.equal((await f.send(command)).status, 'sent');
    assert.deepEqual(f.sent, ['fixture message']);
  } finally {
    await f.close();
  }
});

test('request IDs prevent duplicate dispatch, changed payload and stale epochs across restart', async () => {
  const f = await setup();
  try {
    const targets = await f.targets();
    const command = { epoch: targets.epoch, requestId: randomUUID(), id: f.id, text: 'once only' };
    assert.equal((await f.send(command)).status, 'sent');
    assert.equal((await f.send(command)).status, 'sent');
    await assert.rejects(f.send({ ...command, text: 'changed' }));
    await f.restart();
    assert.equal((await f.send(command)).status, 'sent');
    await assert.rejects(f.send({ ...command, requestId: randomUUID() }));
    assert.deepEqual(f.sent, ['once only']);
    const newer = await f.targets();
    f.fail();
    const uncertain = {
      ...command,
      epoch: newer.epoch,
      requestId: randomUUID(),
      text: 'uncertain fixture',
    };
    assert.equal((await f.send(uncertain)).status, 'uncertain');
    await f.restart();
    assert.equal((await f.send(uncertain)).status, 'uncertain');
    assert.equal(f.sent.length, 2);
  } finally {
    await f.close();
  }
});

test('permission is rechecked after target lookup; concurrent duplicate stays pending without replay', async () => {
  const f = await setup();
  try {
    const target = await f.targets();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    f.setBefore(() => {
      entered();
      return new Promise<void>((r) => (release = r));
    });
    const command = {
      epoch: target.epoch,
      requestId: randomUUID(),
      id: f.id,
      text: 'never delivered',
    };
    const sending = f.send(command);
    await started;
    assert.equal((await f.send(command)).status, 'uncertain');
    f.config.allowSend = false;
    f.save();
    release();
    assert.equal((await sending).status, 'uncertain');
    assert.deepEqual(f.sent, []);
  } finally {
    await f.close();
  }
});

test('receiver routes remote chat through the command credential and never returns credentials', async () => {
  const f = await setup();
  const dir = path.join(f.data, '..', 'receiver');
  mkdirSync(dir);
  const peer = { ...f.peer, token: f.config.token, sendToken: f.config.sendToken };
  writeFileSync(path.join(dir, 'peers.json'), JSON.stringify({ enabled: true, peers: [peer] }));
  const manager = new PeerManager(dir);
  try {
    await new Promise<void>((resolve) => {
      manager.once('change', resolve);
      manager.start();
    });
    const remote = manager.sessions()[0];
    assert.ok(remote.remote?.send);
    assert.ok(!JSON.stringify(manager.state()).includes(f.config.sendToken));
    assert.ok(!JSON.stringify(manager.state()).includes(f.config.token));
    assert.equal((await manager.send(remote.id, 'receiver fixture', randomUUID())).status, 'sent');
    assert.deepEqual(f.sent, ['receiver fixture']);
    manager.command({ action: 'enable', enabled: false });
    await assert.rejects(manager.send(remote.id, 'must not send', randomUUID()));
    assert.equal(f.sent.length, 1);
  } finally {
    manager.close();
    await f.close();
  }
});

test('sending requires an explicit desktop profile and honors its setting independently of the data path', async () => {
  const f = await setup();
  try {
    const target = await f.targets();
    const command = {
      epoch: target.epoch,
      requestId: randomUUID(),
      id: f.id,
      text: 'profile fixture',
    };
    const profileDir = path.join(f.data, '..', 'desktop-profile');
    mkdirSync(profileDir);
    writeFileSync(path.join(profileDir, 'terminal-send.json'), '{"enabled":false}');
    f.config.profileDir = profileDir;
    f.save();
    await assert.rejects(f.send(command));
    const correctProfile = f.config.profileDir;
    delete (f.config as { profileDir?: string }).profileDir;
    f.save();
    await assert.rejects(f.send(command));
    f.config.profileDir = correctProfile;
    writeFileSync(path.join(profileDir, 'terminal-send.json'), '{"enabled":true}');
    f.save();
    assert.equal((await f.send(command)).status, 'sent');
    assert.deepEqual(f.sent, ['profile fixture']);
  } finally {
    await f.close();
  }
});
