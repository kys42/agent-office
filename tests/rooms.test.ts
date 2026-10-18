import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { demoSnapshot } from '../src/lib/demo.js';
import { buildOfficeModel } from '../src/shared/office-model.js';
import { roomModel, LOCAL_ROOM } from '../src/shared/rooms.js';
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
});
