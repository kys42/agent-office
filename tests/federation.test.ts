import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID, X509Certificate, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { demoSnapshot } from '../src/lib/demo.js';
import { OfficeStore } from '../server/store.js';
import { startExportServer } from '../server/federation/export-server.js';
import { peerRequest, PeerError } from '../server/federation/transport.js';
import {
  exportSession,
  wireId,
  responseSchema,
  type WireSnapshot,
} from '../server/federation/protocol.js';
import { PeerManager, importSession } from '../server/federation/peers.js';
import { FederatedService } from '../server/federation/service.js';
import { parentSession } from '../src/shared/office.js';
import { remoteId, type PeerInput } from '../src/shared/federation.js';
import { freshConversation, mergeNewest, mergeLive } from '../src/shared/conversation-pages.js';
import { isWorking } from '../src/shared/presentation.js';
import type { OfficeService } from '../server/service.js';

const temp = () => mkdtempSync(path.join(os.tmpdir(), 'office-peer-test-'));
const peer = (): PeerInput => ({
  officeId: randomUUID(),
  endpoint: 'https://127.0.0.1:4320/',
  fingerprint: 'a'.repeat(64),
  token: 'b'.repeat(64),
  label: 'Other Mac',
  tags: ['LAN'],
  projects: {},
});
const fixture = () => ({
  ...demoSnapshot().sessions[0],
  notes: 'PRIVATE NOTES',
  alias: 'PRIVATE ALIAS',
  sourcePath: '/PRIVATE/SOURCE',
  cwd: '/PRIVATE/WORKTREE',
  sourcePaths: ['/PRIVATE/SOURCE'],
  events: [
    {
      id: 'event',
      at: Date.now(),
      kind: 'assistant' as const,
      text: 'Shared reply',
      sourceRef: '/PRIVATE/SOURCE:2',
      phase: 'final' as const,
    },
  ],
});
const packet = (p: PeerInput): WireSnapshot => ({
  protocol: 1,
  officeId: p.officeId,
  epoch: randomUUID(),
  version: 1,
  sampledAt: Date.now(),
  paused: false,
  conversation: true,
  sessions: [exportSession(fixture(), [])],
});
async function changed(manager: PeerManager, action: () => void) {
  const promise = new Promise<void>((resolve) => manager.once('change', () => resolve()));
  action();
  await promise;
}

test('export allowlist removes private fields and opaque keys isolate parents and actors', () => {
  const root = fixture();
  const child = {
    ...fixture(),
    id: 'child',
    parentId: root.id,
    relation: { kind: 'subagent' as const, parentNativeId: root.nativeId, source: 'fixture' },
  };
  const exported = [root, child].map((s) => exportSession(s, [root, child]));
  const text = JSON.stringify(exported);
  for (const privateValue of ['PRIVATE NOTES', 'PRIVATE ALIAS', '/PRIVATE/'])
    assert.ok(!text.includes(privateValue));
  const a = peer(),
    b = peer();
  const imported = [a, b].flatMap((p) =>
    exported.map((s) => importSession(s, p, Date.now(), false)),
  );
  assert.equal(new Set(imported.map((s) => s.id)).size, 4);
  assert.equal(parentSession(imported[1], imported)?.id, imported[0].id);
  assert.equal(parentSession(imported[3], imported)?.id, imported[2].id);
  assert.notEqual(imported[0].workspace?.key, imported[2].workspace?.key);
});

test('disabled peer manager does not create files, connect, or expose tokens', async () => {
  const dir = temp();
  let calls = 0;
  const manager = new PeerManager(path.join(dir, 'new'), async () => {
    calls++;
    throw new Error();
  });
  manager.start();
  assert.equal(manager.enabled, false);
  assert.equal(calls, 0);
  assert.equal(existsSync(path.join(dir, 'new')), false);
  manager.command({ action: 'enable', enabled: true });
  manager.command({ action: 'add', peer: peer() });
  assert.ok(!JSON.stringify(manager.state()).includes('"token"'));
  manager.command({ action: 'enable', enabled: false });
  assert.deepEqual(manager.sessions(), []);
  manager.close();
  rmSync(dir, { recursive: true, force: true });
});

test('late responses after disable cannot restore remote sessions', async () => {
  const dir = temp(),
    p = peer();
  let finish!: (v: unknown) => void;
  const manager = new PeerManager(
    dir,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  manager.command({ action: 'enable', enabled: true });
  manager.command({ action: 'add', peer: p });
  manager.command({ action: 'enable', enabled: false });
  finish(packet(p));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(manager.sessions(), []);
  assert.equal(manager.enabled, false);
  manager.close();
  rmSync(dir, { recursive: true, force: true });
});

test('remote full snapshots replace one office and invalid identity fails closed', async () => {
  const dir = temp(),
    p = peer();
  writeFileSync(path.join(dir, 'peers.json'), JSON.stringify({ enabled: true, peers: [p] }));
  const manager = new PeerManager(dir, async () => packet(p));
  await changed(manager, () => manager.start());
  assert.equal(manager.sessions().length, 1);
  assert.equal(manager.sessions()[0].remote?.officeId, p.officeId);
  manager.close();
  const invalid = new PeerManager(dir, async () => packet(peer()));
  await changed(invalid, () => invalid.start());
  assert.equal(invalid.state().peers[0].state, 'rejected');
  assert.deepEqual(invalid.sessions(), []);
  invalid.close();
  rmSync(dir, { recursive: true, force: true });
});

test('stale observations are not counted as currently working', () => {
  const s = fixture();
  s.status = 'work';
  s.updatedAt = Date.now();
  const remote = importSession(exportSession(s, []), peer(), Date.now(), true);
  assert.equal(remote.status, 'work');
  assert.equal(isWorking(remote), false);
});

test('composition leaves local data untouched and blocks remote IDs in mutations', async () => {
  const dir = temp(),
    p = peer();
  writeFileSync(path.join(dir, 'peers.json'), JSON.stringify({ enabled: true, peers: [p] }));
  const manager = new PeerManager(dir, async () => packet(p));
  const local = new EventEmitter() as EventEmitter & { call: (m: string) => Promise<unknown> };
  const snapshot = demoSnapshot();
  const before = JSON.stringify(snapshot);
  const calls: string[] = [];
  local.call = async (m) => {
    calls.push(m);
    return snapshot;
  };
  const service = new FederatedService(local as unknown as OfficeService, manager);
  await changed(manager, () => manager.start());
  const combined = (await service.call('snapshot')) as typeof snapshot;
  assert.equal(combined.sessions.length, snapshot.sessions.length + 1);
  assert.equal(JSON.stringify(snapshot), before);
  await assert.rejects(
    service.call('patch', [remoteId(p.officeId, wireId(fixture().id)), { pinned: true }]),
    /read-only/,
  );
  await assert.rejects(
    service.call('pin', [[snapshot.sessions[0].id, remoteId(p.officeId, wireId('x'))], true]),
    /read-only/,
  );
  assert.deepEqual(calls, ['snapshot']);
  manager.command({ action: 'enable', enabled: false });
  assert.equal(await service.call('snapshot'), snapshot);
  manager.close();
  rmSync(dir, { recursive: true, force: true });
});

test('local text and snapshots remain compatible with beta off or enabled without peers', async () => {
  const dir = temp();
  const manager = new PeerManager(path.join(dir, 'config'), async () => {
    throw new Error('No peer request expected');
  });
  const snapshot = demoSnapshot();
  const local = new EventEmitter() as EventEmitter & {
    call: (m: string, a?: unknown[]) => Promise<unknown>;
  };
  const forwarded: unknown[][] = [];
  const result = { ok: true };
  local.call = async (method, args) => {
    forwarded.push([method, args]);
    return method === 'snapshot' ? snapshot : result;
  };
  const service = new FederatedService(local as unknown as OfficeService, manager);
  try {
    assert.equal(await service.call('snapshot'), snapshot);
    const remote = remoteId(randomUUID(), wireId('remote'));
    const text = 'remote-office: connection reference';
    for (const enabled of [false, true]) {
      if (enabled) manager.command({ action: 'enable', enabled });
      for (const [method, args] of [
        ['search', [text]],
        ['search', [remote]],
        ['patch', ['codex:local', { notes: text, alias: text }]],
        ['bookmark', ['codex:local', 'message', remote]],
        ['bookmarkNote', ['bookmark-id', text]],
        ['bookmarks', [{ sessionIds: ['codex:local'], text }]],
        [
          'preferences',
          [{ excludedProjects: [text], zoneRules: [{ match: 'branch', value: text, name: text }] }],
        ],
      ] as [string, unknown[]][]) {
        assert.equal(await service.call(method, args), result);
        assert.deepEqual(forwarded.at(-1), [method, args]);
      }
      const before = forwarded.length;
      for (const [method, args] of [
        ['patch', [remote, { notes: 'blocked' }]],
        ['pin', [['codex:local', remote], true]],
        ['veil', [[remote], true]],
        ['identities', [[remote]]],
        ['bookmark', ['codex:local', remote, 'note']],
        ['noticeReadAll', [{ filter: 'all', sessionIds: [remote] }, Date.now()]],
        ['notices', [[{ id: remote, version: '1' }], 'read']],
        ['preferences', [{ zoneRules: [{ match: 'session', value: remote, name: 'blocked' }] }]],
        ['preferences', [{ petAppearance: { colleagues: { [remote]: null } } }]],
      ] as [string, unknown[]][]) {
        await assert.rejects(service.call(method, args), /read-only/);
      }
      assert.deepEqual(await service.call('bookmarks', [{ sessionIds: [remote] }]), {
        bookmarks: [],
        more: false,
        total: 0,
      });
      assert.equal(forwarded.length, before);
    }
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTPS export is read-only, authenticates before data and scopes every detail request', async () => {
  const dir = temp(),
    data = path.join(dir, 'data'),
    configDir = path.join(dir, 'export');
  mkdirSync(configDir);
  const writer = new OfficeStore(data);
  const session = fixture();
  writer.upsert(
    [session, { ...session, id: 'office:manager', builtin: 'manager', nativeId: 'manager-native' }],
    session.provider,
  );
  writer.close();
  const dbBefore = readFileSync(path.join(data, 'office.sqlite'));
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
  const p = peer();
  p.fingerprint = createHash('sha256')
    .update(new X509Certificate(readFileSync(path.join(configDir, 'server-cert.pem'))).raw)
    .digest('hex');
  const config = {
    enabled: true,
    officeId: p.officeId,
    host: '127.0.0.1',
    port: 0,
    token: p.token,
    projects: ['*'],
    conversation: true,
  };
  const save = () => writeFileSync(path.join(configDir, 'export.json'), JSON.stringify(config));
  save();
  const exporter = await startExportServer(data, configDir);
  let requests = 0;
  exporter.server.on('request', () => requests++);
  p.endpoint = `https://127.0.0.1:${(exporter.server.address() as { port: number }).port}/`;
  try {
    const snapshot = responseSchema.parse(await peerRequest(p, '/office/v1/snapshot'));
    assert.ok(!('unchanged' in snapshot));
    if ('unchanged' in snapshot) throw new Error();
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0].id, wireId(session.id));
    await assert.rejects(peerRequest(p, `/office/v1/detail?id=${wireId('office:manager')}`));
    const same = (await peerRequest(
      p,
      `/office/v1/snapshot?epoch=${snapshot.epoch}&version=${snapshot.version}`,
    )) as { unchanged: boolean };
    assert.equal(same.unchanged, true);
    const detail = (await peerRequest(p, `/office/v1/detail?id=${wireId(session.id)}`)) as {
      session: { events: unknown[] };
    };
    assert.equal(detail.session.events.length, 1);
    await assert.rejects(
      peerRequest({ ...p, token: 'wrong'.repeat(10) }, '/office/v1/snapshot'),
      (e: unknown) => e instanceof PeerError && e.code === 401,
    );
    const beforeWrongPin = requests;
    await assert.rejects(
      peerRequest({ ...p, fingerprint: '0'.repeat(64) }, '/office/v1/snapshot'),
      /Certificate/,
    );
    assert.equal(requests, beforeWrongPin, 'no HTTP credentials before certificate verification');
    await assert.rejects(
      peerRequest(p, '/api/rpc'),
      (e: unknown) => e instanceof PeerError && e.code === 404,
    );
    config.projects = [];
    save();
    await assert.rejects(
      peerRequest(p, `/office/v1/detail?id=${wireId(session.id)}`),
      (e: unknown) => e instanceof PeerError && e.code === 404,
    );
    const narrowed = (await peerRequest(p, '/office/v1/snapshot')) as WireSnapshot;
    assert.equal(narrowed.sessions.length, 0);
    assert.notEqual(narrowed.epoch, snapshot.epoch);
    config.enabled = false;
    save();
    await assert.rejects(
      peerRequest(p, '/office/v1/snapshot'),
      (e: unknown) => e instanceof PeerError && e.code === 403,
    );
  } finally {
    await exporter.close();
    assert.deepEqual(
      readFileSync(path.join(data, 'office.sqlite')),
      dbBefore,
      'existing database file unchanged',
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test('peer reconnects after network failure, replaces restarted epochs and clears revoked data', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = temp(),
    p = peer();
  writeFileSync(path.join(dir, 'peers.json'), JSON.stringify({ enabled: true, peers: [p] }));
  let result: unknown = packet(p),
    failure: PeerError | undefined;
  let calls = 0;
  const manager = new PeerManager(dir, async () => {
    calls++;
    if (failure) throw failure;
    return result;
  });
  try {
    await changed(manager, () => manager.start());
    manager.start();
    assert.equal(calls, 1, 'start is idempotent');
    failure = new PeerError(0, 'Peer connection unavailable');
    await changed(manager, () => t.mock.timers.tick(5000));
    assert.equal(manager.state().peers[0].state, 'offline');
    assert.equal(manager.sessions().length, 1);
    assert.equal(manager.sessions()[0].remote?.stale, true);
    failure = undefined;
    result = { ...packet(p), sessions: [] }; // New server epoch, old sessions deleted.
    await changed(manager, () => t.mock.timers.tick(5000));
    assert.equal(manager.state().peers[0].state, 'connected');
    assert.equal(manager.sessions().length, 0);
    result = packet(p);
    await changed(manager, () => t.mock.timers.tick(5000));
    assert.equal(manager.sessions().length, 1);
    failure = new PeerError(403, 'Revoked');
    await changed(manager, () => t.mock.timers.tick(5000));
    assert.equal(manager.state().peers[0].state, 'rejected');
    assert.deepEqual(manager.sessions(), []);
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project links and tags affect only the composed view and survive restart', async () => {
  const dir = temp(),
    p = peer();
  p.projects = { [fixture().project]: 'Unified project' };
  p.tags = ['work'];
  const manager = new PeerManager(dir, async () => packet(p));
  manager.command({ action: 'enable', enabled: true });
  const ready = new Promise<void>((resolve) =>
    manager.on('change', () => {
      if (manager.sessions().length) resolve();
    }),
  );
  manager.command({ action: 'add', peer: p });
  await ready;
  const remote = manager.sessions()[0];
  assert.equal(remote.area?.name, 'Unified project');
  assert.equal(remote.project, fixture().project);
  assert.deepEqual(remote.remote?.tags, ['work']);
  manager.close();
  const restarted = new PeerManager(dir, async () => packet(p));
  assert.equal(restarted.enabled, true);
  assert.deepEqual(restarted.sessions(), [], 'remote contents are not persisted');
  await changed(restarted, () => restarted.start());
  assert.equal(restarted.sessions()[0].area?.name, 'Unified project');
  restarted.close();
  rmSync(dir, { recursive: true, force: true });
});

test('summary-only peer cards do not request forbidden detail or evict the office', async () => {
  const dir = temp(),
    p = peer();
  writeFileSync(path.join(dir, 'peers.json'), JSON.stringify({ enabled: true, peers: [p] }));
  let calls = 0;
  const manager = new PeerManager(dir, async () => {
    calls++;
    return { ...packet(p), conversation: false };
  });
  try {
    await changed(manager, () => manager.start());
    const summary = manager.sessions()[0];
    assert.equal(summary.remote?.conversation, false);
    const detail = await manager.detail(summary.id);
    assert.equal(detail.partial, true);
    assert.equal(calls, 1);
    assert.equal(manager.sessions().length, 1);
    assert.equal(manager.state().peers[0].state, 'connected');
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('narrowing conversation permission removes previously loaded detail from an open card', () => {
  const p = peer(),
    session = exportSession(fixture(), []);
  const permitted = importSession(session, p, Date.now(), false, true);
  const detail = {
    ...permitted,
    events: [
      ...permitted.events,
      { ...permitted.events[0], id: 'full-only', text: 'Detailed earlier text' },
    ],
    olderEvents: false,
    notices: [],
  };
  const loaded = mergeNewest(freshConversation(permitted), detail);
  assert.equal(loaded.session.events.length, 2);
  const narrowed = importSession(session, p, Date.now(), false, false);
  assert.notEqual(narrowed.revision, permitted.revision);
  const next = mergeLive(loaded, narrowed);
  assert.equal(next.session.events.length, 1);
  assert.equal(
    next.session.events.some((e) => e.id === 'full-only'),
    false,
  );
  assert.deepEqual(next.notices, []);
});

test('unchanged peer heartbeats do not shorten a loaded full conversation message', () => {
  const source = fixture();
  source.events[0].text = 'x'.repeat(5000);
  const p = peer();
  const summary = importSession(exportSession(source, []), p, Date.now(), false);
  const full = importSession(exportSession(source, [], true), p, Date.now(), false);
  assert.equal(summary.events[0].text.length, 2000);
  assert.equal(summary.events[0].excerpt, true);
  assert.equal(full.events[0].excerpt, false);
  const loaded = mergeNewest(freshConversation(summary), {
    ...full,
    olderEvents: false,
    notices: [],
  });
  const heartbeat = { ...summary, remote: { ...summary.remote!, receivedAt: Date.now() + 5000 } };
  assert.equal(heartbeat.revision, full.revision);
  assert.equal(mergeLive(loaded, heartbeat).session.events[0].text.length, 5000);
});
