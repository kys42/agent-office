import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopCodexRelay } from '../desktop/codex-remote.js';
import { RelayJournal } from '../server/federation/relay-journal.js';
import { wireId } from '../server/federation/protocol.js';

test('Remote identities require exact host and digest; conflicting cached hosts fail closed', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ao-remote-'));
  const id = randomUUID(),
    host = 'remote-control:env_test';
  const file = path.join(home, '.codex-global-state.json');
  const relay = new DesktopCodexRelay(home);
  try {
    const state = {
      'thread-project-membership-host-ids': { [id]: host },
      'unrelated-secret': 'do not modify',
    };
    writeFileSync(file, JSON.stringify(state));
    const before = readFileSync(file);
    assert.equal(relay.resolve(host, wireId(`codex:${id}`)), id);
    assert.equal(relay.resolve('ssh:other', wireId(`codex:${id}`)), null);
    assert.equal(relay.resolve(host, wireId(`claude:${id}`)), null);
    assert.deepEqual(relay.hosts(), [{ id: host, label: host }]);
    assert.deepEqual(readFileSync(file), before);
    const cached = {
      'electron-persisted-atom-state': {
        [`remote-thread-summaries-v3:${host}`]: [{ hostId: host, conversationId: id }],
      },
    };
    writeFileSync(file, JSON.stringify(cached));
    assert.equal(relay.resolve(host, wireId(`codex:${id}`)), id);
    writeFileSync(
      file,
      JSON.stringify({ ...cached, 'thread-project-membership-host-ids': { [id]: 'local' } }),
    );
    assert.equal(relay.resolve(host, wireId(`codex:${id}`)), null);
    writeFileSync(file, '{broken');
    assert.deepEqual(relay.hosts(), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Outgoing journal survives restart, blocks route changes and stores no message text', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ao-journal-'));
  try {
    const request = randomUUID();
    const j = new RelayJournal(dir);
    assert.equal(j.claim(request, 'session', 'private message'), 'new');
    assert.equal(new RelayJournal(dir).claim(request, 'session', 'private message'), 'uncertain');
    assert.throws(() => j.claim(request, 'other', 'private message'));
    j.sent(request);
    assert.equal(j.claim(request, 'session', 'private message'), 'sent');
    assert.equal(
      readFileSync(path.join(dir, 'outgoing.sqlite')).includes(Buffer.from('private message')),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A temporarily unavailable existing mapping survives edits; unknown new mappings are rejected', async () => {
  const { PeerManager } = await import('../server/federation/peers.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ao-host-config-'));
  const peer = {
    officeId: randomUUID(),
    endpoint: 'https://localhost:4320/',
    fingerprint: 'a'.repeat(64),
    token: 'b'.repeat(64),
    label: 'Mini',
    tags: [],
    projects: {},
    codexHostId: 'ssh:existing',
  };
  writeFileSync(path.join(dir, 'peers.json'), JSON.stringify({ enabled: false, peers: [peer] }));
  const manager = new PeerManager(dir, undefined, {
    hosts: () => [],
    resolve: () => null,
    available: async () => false,
    send: async () => {},
  });
  try {
    const command = {
      action: 'update',
      officeId: peer.officeId,
      label: 'Renamed',
      tags: [],
      projects: {},
      codexHostId: peer.codexHostId,
    };
    assert.equal(manager.command(command).peers[0].label, 'Renamed');
    assert.throws(() => manager.command({ ...command, codexHostId: 'ssh:unknown' }));
    assert.equal(
      manager.command({ ...command, codexHostId: undefined }).peers[0].codexHostId,
      undefined,
    );
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Preparing opens only the exact existing conversation after authorization, with no prompt in URL', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ao-connect-'));
  const id = randomUUID(),
    host = 'remote-control:env_fixture';
  const file = path.join(home, '.codex-global-state.json');
  writeFileSync(file, JSON.stringify({ 'thread-project-membership-host-ids': { [id]: host } }));
  const opened: string[] = [],
    steps: string[] = [];
  const relay = new DesktopCodexRelay(home, async (url) => {
    opened.push(url);
    steps.push('open');
  });
  relay.available = async () => {
    steps.push('owner');
    return true;
  };
  try {
    await relay.prepare!(host, id, async () => {
      steps.push('authorize');
    });
    const url = new URL(opened[0]);
    assert.equal(url.protocol, 'codex:');
    assert.equal(url.hostname, 'threads');
    assert.equal(url.pathname, `/${id}`);
    assert.equal(url.searchParams.get('hostId'), host);
    assert.deepEqual([...url.searchParams.keys()], ['hostId']);
    assert.deepEqual(steps, ['authorize', 'open', 'authorize', 'owner']);
    await assert.rejects(
      relay.prepare!(host, id, async () => {
        throw Error('revoked');
      }),
    );
    assert.equal(opened.length, 1);
    await assert.rejects(
      relay.prepare!(host, id, async () => {
        writeFileSync(file, '{}');
      }),
    );
    assert.equal(opened.length, 1, 'membership removed during authorization does not open');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
