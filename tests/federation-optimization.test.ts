import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID, X509Certificate, createHash } from 'node:crypto';
import { demoSnapshot } from '../src/lib/demo.js';
import { OfficeStore } from '../server/store.js';
import {
  MAX_BYTES,
  snapshotSchema,
  deltaSchema,
  exportSession,
  wireId,
  type WireSnapshot,
  type WireDelta,
} from '../server/federation/protocol.js';
import { SnapshotVersions, applyDelta } from '../server/federation/snapshot-delta.js';
import { startExportServer } from '../server/federation/export-server.js';
import { peerRequest, PeerError } from '../server/federation/transport.js';
import { PeerManager } from '../server/federation/peers.js';
import type { PeerInput } from '../src/shared/federation.js';
import { freshConversation, mergeNewest, mergeLive } from '../src/shared/conversation-pages.js';

const source = (i = 0) => ({
  ...demoSnapshot().sessions[0],
  id: `session-${i}`,
  nativeId: `native-${i}`,
  title: `Agent ${i}`,
  revision: `v1-${i}`,
  events: [
    {
      id: `request-${i}`,
      at: 1,
      kind: 'user' as const,
      text: 'User request ' + 'x'.repeat(1000),
      sourceRef: '',
    },
  ],
});
const snapshot = (count = 20): WireSnapshot => ({
  protocol: 1,
  officeId: randomUUID(),
  epoch: randomUUID(),
  version: 1,
  sampledAt: 1,
  paused: false,
  conversation: true,
  sessions: Array.from({ length: count }, (_, i) => exportSession(source(i), [])),
});
const hash = (s: WireSnapshot) => wireId(JSON.stringify([s.sessions, s.paused]));

test('a 900-agent office sends only changed records and validates an exact delta base/order', () => {
  const versions = new SnapshotVersions(),
    first = snapshot(900);
  assert.equal(versions.update(hash(first), first.sessions), 1);
  const next = {
    ...first,
    version: 2,
    sessions: [
      ...first.sessions.slice(1, 899),
      { ...first.sessions[899], title: 'changed' },
      exportSession(source(900), []),
    ],
  };
  versions.update(hash(next), next.sessions);
  const delta = versions.delta(next, first.epoch, '1')!;
  assert.equal(delta.sessions.length, 2);
  assert.deepEqual(delta.removed, [first.sessions[0].id]);
  assert.ok(
    Buffer.byteLength(JSON.stringify(delta)) < Buffer.byteLength(JSON.stringify(next)) / 10,
  );
  const applied = applyDelta(first, delta);
  assert.deepEqual(applied, next);
  assert.equal(applied.sessions[0], first.sessions[1], 'unchanged wire objects are reused');
  assert.throws(() => applyDelta(first, { ...delta, base: 0 }));
  assert.throws(() => applyDelta(first, { ...delta, order: [...delta.order, delta.order[0]] }));
  assert.throws(() => applyDelta(first, { ...delta, removed: [wireId('absent')] }));
  assert.equal(versions.delta(next, first.epoch, '0'), undefined);
  assert.equal(versions.delta(next, randomUUID(), '1'), undefined);
  versions.clear();
  assert.equal(versions.update(hash(next), next.sessions), 1);
  assert.equal(versions.delta(next, first.epoch, '1'), undefined);
});

test('delta rejects an assembled snapshot over the wire budget', () => {
  const first = snapshot(1);
  first.sessions[0].events = Array.from({ length: 150 }, (_, i) => ({
    ...first.sessions[0].events[0],
    id: wireId(`large-${i}`),
    text: 'x'.repeat(64000),
  }));
  const added = { ...first.sessions[0], id: wireId('added') };
  const { protocol: _, ...base } = first;
  const delta: WireDelta = {
    ...base,
    delta: true,
    base: 1,
    version: 2,
    sessions: [added],
    removed: [],
    order: [first.sessions[0].id, added.id],
  };
  snapshotSchema.parse(first);
  deltaSchema.parse(delta);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(delta)) < MAX_BYTES);
  assert.throws(() => applyDelta(first, delta), /byte budget/);
});

test('peer delta keeps unchanged imported objects and coalesces desktop/mobile reads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = mkdtempSync(path.join(tmpdir(), 'ao-peer-delta-'));
  const first = snapshot(2),
    versions = new SnapshotVersions();
  versions.update(hash(first), first.sessions);
  const next = {
    ...first,
    version: 2,
    sessions: [first.sessions[0], { ...first.sessions[1], title: 'changed' }],
  };
  versions.update(hash(next), next.sessions);
  const delta = versions.delta(next, first.epoch, '1')!;
  const peer: PeerInput = {
    officeId: first.officeId,
    label: 'LAN',
    tags: [],
    projects: {},
    endpoint: 'https://127.0.0.1:4320/',
    fingerprint: 'a'.repeat(64),
    token: 'b'.repeat(64),
  };
  writeFileSync(path.join(dir, 'peers.json'), JSON.stringify({ enabled: true, peers: [peer] }));
  let snapshots = 0,
    reads = 0,
    release!: () => void;
  let invalid = false;
  const manager = new PeerManager(dir, async (_peer, route) => {
    if (route.startsWith('/office/v1/snapshot')) {
      if (snapshots++ === 0) return first;
      assert.ok(route.includes('delta=1'));
      return invalid ? { ...delta, base: 0 } : delta;
    }
    reads++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { officeId: first.officeId, session: first.sessions[0] };
  });
  const change = (run: () => void) =>
    new Promise<void>((resolve) => {
      manager.once('change', resolve);
      run();
    });
  try {
    await change(() => manager.start());
    const old = manager.sessions();
    await change(() => t.mock.timers.tick(5000));
    const updated = manager.sessions();
    assert.equal(updated[0], old[0]);
    assert.notEqual(updated[1], old[1]);
    const pending = Array.from({ length: 10 }, () =>
      manager.detail(updated[0].id, { view: 'conversation', limit: 180 }),
    );
    assert.equal(reads, 1, 'one in-flight peer HTTP read per view');
    release();
    assert.equal((await Promise.all(pending)).length, 10);
    invalid = true;
    await change(() => t.mock.timers.tick(5000));
    assert.equal(manager.sessions().length, 0, 'bad delta clears the old snapshot');
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop remote history is bounded by text during detail refresh and live merges', () => {
  const s = source();
  const remote = {
    ...s,
    remote: {
      officeId: randomUUID(),
      sessionId: 'remote',
      label: 'Other',
      tags: [],
      receivedAt: 1,
      stale: false,
      conversation: true,
      send: false,
    },
  };
  const events = Array.from({ length: 180 }, (_, i) => ({
    ...s.events[0],
    id: `e${i}`,
    at: i,
    text: 'x'.repeat(64000),
  }));
  let view = mergeNewest(freshConversation(remote), {
    ...remote,
    events,
    olderEvents: false,
    notices: [],
  });
  assert.equal(view.session.events.length, 8);
  for (let i = 180; i < 1180; i++) {
    view = mergeLive(view, { ...remote, events: [{ ...events[0], id: `e${i}`, at: i }] });
    assert.ok(view.session.events.reduce((n, e) => n + e.text.length, 0) <= 512000);
  }
  assert.equal(view.session.events.at(-1)?.id, 'e1179');
  assert.equal(view.older, false);
});

test('exporter reuses a bounded summary view, invalidates DB policy immediately and negotiates delta', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ao-export-optimized-')),
    data = path.join(dir, 'data'),
    configDir = path.join(dir, 'export');
  mkdirSync(configDir);
  const writer = new OfficeStore(data);
  const rows = Array.from({ length: 20 }, (_, i) => source(i));
  writer.upsert(rows, rows[0].provider);
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
  const officeId = randomUUID(),
    token = 'a'.repeat(64);
  writeFileSync(
    path.join(configDir, 'export.json'),
    JSON.stringify({
      enabled: true,
      officeId,
      host: '127.0.0.1',
      port: 0,
      token,
      projects: ['*'],
      conversation: true,
    }),
  );
  const exporter = await startExportServer(data, configDir);
  const peer: PeerInput = {
    officeId,
    label: 'fixture',
    token,
    tags: [],
    projects: {},
    endpoint: `https://127.0.0.1:${(exporter.server.address() as { port: number }).port}/`,
    fingerprint: createHash('sha256')
      .update(new X509Certificate(readFileSync(path.join(configDir, 'server-cert.pem'))).raw)
      .digest('hex'),
  };
  const listing = t.mock.method(OfficeStore.prototype, 'list');
  const get = t.mock.method(OfficeStore.prototype, 'get');
  try {
    const first = (await peerRequest(peer, '/office/v1/snapshot')) as WireSnapshot;
    for (let i = 0; i < 3; i++)
      await peerRequest(peer, `/office/v1/detail?id=${first.sessions[0].id}&view=conversation`);
    await peerRequest(peer, `/office/v1/snapshot?epoch=${first.epoch}&version=${first.version}`);
    assert.equal(listing.mock.callCount(), 1, 'list+detail consumers share one source view');
    assert.equal(
      get.mock.callCount(),
      0,
      'detail does not recover workspaces by parsing every session',
    );
    rows[0] = { ...rows[0], title: 'changed once', revision: 'v2' };
    writer.upsert(rows, rows[0].provider);
    const delta = (await peerRequest(
      peer,
      `/office/v1/snapshot?delta=1&epoch=${first.epoch}&version=${first.version}`,
    )) as WireDelta;
    assert.equal(delta.delta, true);
    assert.equal(delta.sessions.length, 1);
    const legacy = (await peerRequest(
      peer,
      `/office/v1/snapshot?epoch=${first.epoch}&version=${first.version}`,
    )) as WireSnapshot;
    assert.equal(legacy.sessions.length, 20, 'a legacy client never receives delta');
    assert.deepEqual(applyDelta(first, delta).sessions, legacy.sessions);
    writer.upsert(
      [
        {
          ...rows[0],
          revision: 'huge-tool',
          events: [
            ...rows[0].events,
            { id: 'huge-tool', at: 2, kind: 'tool', text: 'x'.repeat(800000), sourceRef: '' },
          ],
        },
      ],
      rows[0].provider,
    );
    const large = (await peerRequest(
      peer,
      `/office/v1/detail?id=${wireId(rows[0].id)}&view=all`,
    )) as { session: WireSnapshot['sessions'][number] };
    assert.equal(large.session.events.length, 2, 'large final output keeps earlier requests');
    assert.equal(large.session.events[0].kind, 'user');
    assert.equal(large.session.events[1].text.length, 64000);
    writer.preferences({ excludedProjects: [rows[0].project] });
    await assert.rejects(
      peerRequest(peer, `/office/v1/detail?id=${wireId(rows[0].id)}&view=conversation`),
      (e: unknown) => e instanceof PeerError && e.code === 404,
    );
    assert.equal(
      ((await peerRequest(peer, '/office/v1/snapshot')) as WireSnapshot).sessions.length,
      0,
    );
  } finally {
    await exporter.close();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
