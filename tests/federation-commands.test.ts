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

async function setup(
  remoteCodex = false,
  origin: 'unknown' | 'interactive' | 'scheduled' | 'internal' = 'unknown',
  count = 1,
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'office-commands-'));
  const data = path.join(root, 'data'),
    configDir = path.join(root, 'config');
  mkdirSync(configDir);
  const writer = new OfficeStore(data);
  const s = demoSnapshot().sessions[0];
  if (remoteCodex) {
    s.nativeId = randomUUID();
    s.id = `codex:${s.nativeId}`;
    s.provider = 'codex';
    s.relation = { kind: 'root', parentNativeId: null, source: 'fixture' };
    // Existing exporters classify ordinary Codex Desktop records as unknown.
    s.origin = { kind: origin, source: 'fixture' };
  }
  const sessions = Array.from({ length: count }, (_, i) =>
    i === 0 ? s : { ...s, id: `${s.id}-${i}`, nativeId: `${s.nativeId}-${i}` },
  );
  writer.upsert(sessions, s.provider);
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
  if (remoteCodex) sender.target = async () => null;
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
    root,
    ids: sessions.map((session) => wireId(session.id)),
    session: s,
    sender,
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
    let checked = 0;
    await assert.rejects(
      manager.send(remote.id, 'revoked mobile', randomUUID(), async () => {
        checked++;
        throw new Error('revoked');
      }),
      /revoked/,
    );
    assert.equal(checked, 1);
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

test('Local Codex relay automatically resolves exact identity with live permission; durable requests never replay', async () => {
  const f = await setup(true);
  const host = 'remote-control:env_fixture';
  const { DesktopCodexRelay } = await import('../desktop/codex-remote.js');
  const home = path.join(f.root, 'codex');
  mkdirSync(home);
  writeFileSync(
    path.join(home, '.codex-global-state.json'),
    JSON.stringify({ 'thread-project-membership-host-ids': { [f.session.nativeId]: host } }),
  );
  const identity = new DesktopCodexRelay(home);
  const sends: string[] = [];
  let preflight = async () => {};
  const relay = {
    hosts: () => identity.hosts(),
    resolve: (h: string, id: string) => identity.resolve(h, id),
    available: async () => true,
    send: async (h: string, thread: string, text: string, authorize: () => Promise<void>) => {
      assert.equal(h, host);
      assert.equal(thread, f.session.nativeId);
      await preflight();
      await authorize();
      sends.push(text);
    },
  };
  const dir = path.join(f.root, 'receiver');
  let manager = new PeerManager(dir, undefined, relay);
  const connected = async () => {
    manager.start();
    await new Promise<void>((resolve) => {
      if (manager.sessions().length) return resolve();
      manager.once('change', () => resolve());
    });
    assert.equal(manager.state().peers[0].state, 'connected');
    return manager.sessions()[0].id;
  };
  try {
    manager.command({ action: 'enable', enabled: true });
    // Imports cannot assign local Codex host permissions.
    assert.throws(() => manager.command({ action: 'add', peer: { ...f.peer, codexHostId: host } }));
    manager.command({
      action: 'add',
      peer: { ...f.peer, token: f.config.token, sendToken: f.config.sendToken },
    });
    let id = await connected();
    assert.equal((await manager.targets([id]))[id]?.canSend, true);
    manager.command({
      action: 'update',
      officeId: f.peer.officeId,
      label: 'Mini fixture',
      tags: [],
      projects: {},
      codexHostId: host,
    });
    id = await connected();
    const target = (await manager.targets([id]))[id];
    assert.equal(target?.codexRemote, true);
    assert.equal(target?.canSend, true);
    assert.ok(!JSON.stringify(target).includes(f.session.nativeId));
    const request = randomUUID();
    assert.equal((await manager.send(id, 'once', request)).status, 'sent');
    manager.close();
    manager = new PeerManager(dir, undefined, relay);
    await connected();
    assert.equal((await manager.send(id, 'once', request)).status, 'sent');
    assert.deepEqual(sends, ['once']);
    assert.deepEqual(f.sent, []);
    await assert.rejects(manager.send(id, 'different', request));
    preflight = async () => {
      f.config.allowSend = false;
      f.save();
    };
    await assert.rejects(manager.send(id, 'revoked remotely', randomUUID()));
    assert.deepEqual(sends, ['once']);
    f.config.allowSend = true;
    f.save();
    preflight = async () => {
      manager.command({ action: 'enable', enabled: false });
    };
    await assert.rejects(manager.send(id, 'disabled during owner discovery', randomUUID()));
    assert.deepEqual(sends, ['once']);
  } finally {
    manager.close();
    await f.close();
  }
});

test('Relay never falls back to native send after an uncertain local dispatch, including after restart', async () => {
  const f = await setup(true);
  const host = 'ssh:fixture';
  let dispatched = 0;
  const relay = {
    hosts: () => [{ id: host, label: host }],
    resolve: () => f.session.nativeId,
    available: async () => true,
    send: async (_h: string, _t: string, _text: string, auth: () => Promise<void>) => {
      await auth();
      dispatched++;
      throw Error('ack lost');
    },
  };
  const dir = path.join(f.root, 'receiver');
  let manager = new PeerManager(dir, undefined, relay);
  const wait = async () => {
    manager.start();
    if (!manager.sessions().length)
      await new Promise<void>((r) => manager.once('change', () => r()));
  };
  try {
    manager.command({ action: 'enable', enabled: true });
    manager.command({
      action: 'add',
      peer: { ...f.peer, token: f.config.token, sendToken: f.config.sendToken },
    });
    manager.command({
      action: 'update',
      officeId: f.peer.officeId,
      label: 'Mini',
      tags: [],
      projects: {},
      codexHostId: host,
    });
    await wait();
    const id = manager.sessions()[0].id,
      request = randomUUID();
    await assert.rejects(manager.send(id, 'unknown', request));
    manager.close();
    f.sender.target = async () => ({
      kind: 'codex',
      label: '',
      status: 'desktop',
      canSend: true,
      canFocus: false,
    });
    manager = new PeerManager(dir, undefined, relay);
    await wait();
    await assert.rejects(manager.send(id, 'unknown', request));
    assert.equal(dispatched, 1);
    assert.deepEqual(f.sent, []);
  } finally {
    manager.close();
    await f.close();
  }
});

for (const origin of ['scheduled', 'internal'] as const) {
  test(`Local relay excludes ${origin} records before owner lookup`, async () => {
    const f = await setup(true, origin);
    let lookedUp = 0;
    const host = 'ssh:fixture';
    const manager = new PeerManager(path.join(f.root, 'receiver'), undefined, {
      hosts: () => [{ id: host, label: host }],
      resolve: () => f.session.nativeId,
      available: async () => {
        lookedUp++;
        return true;
      },
      send: async () => {
        throw Error('must not send');
      },
    });
    try {
      manager.command({ action: 'enable', enabled: true });
      manager.command({
        action: 'add',
        peer: { ...f.peer, token: f.config.token, sendToken: f.config.sendToken },
      });
      manager.command({
        action: 'update',
        officeId: f.peer.officeId,
        label: 'Mini',
        tags: [],
        projects: {},
        codexHostId: host,
      });
      if (!manager.sessions().length)
        await new Promise<void>((r) => manager.once('change', () => r()));
      const id = manager.sessions()[0].id;
      assert.equal((await manager.targets([id]))[id], null);
      await assert.rejects(manager.send(id, 'must not send', randomUUID()));
      assert.equal(lookedUp, 0);
    } finally {
      manager.close();
      await f.close();
    }
  });
}

test('twenty target lookups read the shared view twice and recheck revocation after lookup', async (t) => {
  const f = await setup(false, 'unknown', 20);
  const original = OfficeStore.prototype.list;
  let reads = 0;
  t.mock.method(
    OfficeStore.prototype,
    'list',
    function (this: OfficeStore, ...args: Parameters<typeof original>) {
      reads++;
      return original.apply(this, args);
    },
  );
  const lookup = () =>
    peerRequest(f.peer, '/office/v1/commands/targets', undefined, { body: { ids: f.ids } });
  try {
    const result = targetResponseSchema.parse(await lookup());
    assert.equal(Object.keys(result.targets).length, 20);
    assert.equal(reads, 2, 'not two full database scans per target');
    const target = f.sender.target;
    f.sender.target = async (session) => {
      const result = await target(session);
      f.config.projects = [];
      f.save();
      return result;
    };
    await assert.rejects(lookup(), (e) => e instanceof PeerError && e.code === 404);
    assert.deepEqual(f.sent, []);
  } finally {
    await f.close();
  }
});

for (const scenario of [
  'ready',
  'permission-revoked',
  'host-changed',
  'ambiguous',
  'wrong-override',
  'connect-failed',
] as const) {
  test(`Automatic relay prepares only on send and rechecks identity/permission: ${scenario}`, async () => {
    const f = await setup(true);
    let hosts = ['ssh:fixture'];
    let ready = false,
      opened = 0,
      sent = 0;
    const relay = {
      hosts: () => hosts.map((id) => ({ id, label: id })),
      resolve: (host: string, id: string) =>
        hosts.includes(host) && id === wireId(f.session.id) ? f.session.nativeId : null,
      available: async () => ready,
      prepare: async (_h: string, _t: string, auth: () => Promise<void>) => {
        await auth();
        opened++;
        if (scenario === 'permission-revoked') {
          f.config.allowSend = false;
          f.save();
        }
        if (scenario === 'host-changed') hosts = ['ssh:changed'];
        if (scenario === 'connect-failed') throw Error('offline');
        ready = true;
        await auth();
      },
      send: async (_h: string, _t: string, _text: string, auth: () => Promise<void>) => {
        await auth();
        sent++;
      },
    };
    const manager = new PeerManager(path.join(f.root, 'receiver'), undefined, relay);
    try {
      manager.command({ action: 'enable', enabled: true });
      manager.command({
        action: 'add',
        peer: { ...f.peer, token: f.config.token, sendToken: f.config.sendToken },
      });
      if (!manager.sessions().length)
        await new Promise<void>((r) => manager.once('change', () => r()));
      const id = manager.sessions()[0].id;
      if (scenario === 'ambiguous') hosts.push('ssh:duplicate');
      if (scenario === 'wrong-override') {
        hosts.push('ssh:wrong');
        manager.command({
          action: 'update',
          officeId: f.peer.officeId,
          label: 'Test',
          tags: [],
          projects: {},
          codexHostId: 'ssh:wrong',
        });
        hosts = ['ssh:fixture'];
        if (!manager.sessions().length)
          await new Promise<void>((r) => manager.once('change', () => r()));
      }
      const target = (await manager.targets([id]))[id];
      assert.equal(opened, 0, 'status queries never open Codex');
      if (scenario === 'ambiguous' || scenario === 'wrong-override') assert.equal(target, null);
      else {
        assert.equal(target?.canSend, false);
        assert.equal(target?.canPrepare, true);
      }
      if (scenario === 'ready') {
        const request = randomUUID();
        assert.equal((await manager.send(id, 'synthetic', request)).status, 'sent');
        await manager.send(id, 'synthetic', request);
        assert.equal(opened, 1);
        assert.equal(sent, 1);
      } else {
        await assert.rejects(manager.send(id, 'synthetic', randomUUID()));
        assert.equal(sent, 0);
      }
      assert.deepEqual(f.sent, [], 'never fall back to another sender');
    } finally {
      manager.close();
      await f.close();
    }
  });
}
