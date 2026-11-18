import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { demoSnapshot } from '../src/lib/demo.js';
import { buildOfficeModel } from '../src/shared/office-model.js';
import { roomModel, LOCAL_ROOM, ALL_ROOMS } from '../src/shared/rooms.js';
import { exportSession } from '../server/federation/protocol.js';
import { importSession } from '../server/federation/peers.js';
import { projectKey } from '../src/shared/office.js';

test('computers are separate offices while projects remain separate inside each room', () => {
  const local = demoSnapshot();
  const sessions = local.sessions.filter((s) => !s.attachedTo).slice(0, 2);
  const peer = {
    officeId: randomUUID(),
    endpoint: 'https://localhost:4320/',
    fingerprint: 'a'.repeat(64),
    token: 'b'.repeat(64),
    label: 'Remote machine',
    tags: [],
    projects: {},
  };
  const remotes = sessions.map((s, i) =>
    importSession(exportSession({ ...s, project: `Project ${i}` }, []), peer, Date.now(), false),
  );
  assert.notEqual(projectKey(remotes[0]), projectKey(remotes[1]));
  assert.equal(remotes[0].area?.name, 'Project 0');
  const all = buildOfficeModel({ ...local, sessions: [...sessions, ...remotes] });
  const localRoom = roomModel(all, LOCAL_ROOM),
    remote = roomModel(all, peer.officeId);
  assert.ok(localRoom.residents.every((s) => !s.remote));
  assert.ok(remote.residents.every((s) => s.remote?.officeId === peer.officeId));
  assert.equal(localRoom.view(remotes[0].id), undefined);
  assert.equal(remote.view(sessions[0].id), undefined);
  assert.equal(localRoom.residents.length + remote.residents.length, all.residents.length);
  const combined = roomModel(all, ALL_ROOMS);
  assert.equal(
    combined,
    all,
    'all offices retain shared counts, helper/owner resolution and notice state',
  );
  assert.ok(combined.view(remotes[0].id));
  assert.ok(combined.view(sessions[0].id));
});

test('explicit same-name project groups merge only within their source office', () => {
  const sessions = demoSnapshot()
    .sessions.slice(0, 2)
    .map((s, i) => ({ ...s, project: `Source ${i}` }));
  const input = {
    officeId: randomUUID(),
    endpoint: 'https://localhost:4320/',
    fingerprint: 'a'.repeat(64),
    token: 'b'.repeat(64),
    label: 'Mac',
    tags: [],
    projects: { 'Source 0': 'Shared', 'Source 1': 'Shared' },
  };
  const peer2 = { ...input, officeId: randomUUID() };
  const remote = sessions.map((s) =>
    importSession(exportSession(s, sessions), input, Date.now(), false),
  );
  const other = importSession(exportSession(sessions[0], sessions), peer2, Date.now(), false);
  assert.equal(
    projectKey(remote[0]),
    projectKey(remote[1]),
    'explicit grouping inside one computer remains',
  );
  assert.notEqual(
    projectKey(remote[0]),
    projectKey(other),
    'two computers with identical mapping stay separate',
  );
  assert.notEqual(projectKey(remote[0]), projectKey(sessions[0]));
  assert.equal(remote[0].area?.name, other.area?.name, 'matching labels do not merge identities');
});
