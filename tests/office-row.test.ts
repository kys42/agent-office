import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from '../src/lib/demo.js';
import {
  layoutOffice,
  layoutRow,
  officeTopology,
  STATION_WIDTH,
} from '../src/shared/office-layout.js';
import { stationSpeech } from '../src/shared/speech.js';
import type { OfficeNotice, Session } from '../src/shared/types.js';
const now = Date.now();
const base = demoSnapshot().sessions[0];
function session(i: number, project = 'team', patch: Partial<Session> = {}): Session {
  return {
    ...base,
    id: `fixture:${i}`,
    nativeId: `${i}`,
    project,
    cwd: `/tmp/${project}`,
    officeSeat: i,
    branch: 'main',
    attachedTo: undefined,
    resident: undefined,
    ...patch,
  };
}
const notice = (sessionId: string, patch: Partial<OfficeNotice> = {}): OfficeNotice => ({
  id: `${sessionId}::${Math.random()}`,
  sessionId,
  eventId: 'e',
  kind: 'reply',
  phase: 'final',
  text: '결과를 남겼어요',
  at: now,
  receivedAt: now,
  version: 'v',
  seenAt: null,
  viewedAt: null,
  dismissedAt: null,
  resolvedAt: null,
  bootstrap: false,
  ...patch,
});

test('the row and the big office share one topology: zones, benches and seat order', () => {
  const sessions = [
    session(0),
    session(1, 'other'),
    session(2),
    session(3, 'team', { branch: 'feature' }),
  ];
  const topology = officeTopology(sessions);
  const office = layoutOffice(sessions, 2);
  const row = layoutRow(sessions);
  assert.deepEqual(
    row.zones.map((z) => [z.key, z.name]),
    topology.projects.map((p) => [p.key, p.name]),
  );
  assert.deepEqual(
    row.zones.map((z) => z.stations.map((s) => s.id)),
    office.projects.map((p) => p.stations.map((s) => s.id)),
  );
  assert.deepEqual(
    row.zones.map((z) => z.benches.map((b) => b.members)),
    office.projects.map((p) => p.benches.map((b) => b.members)),
  );
});

test('a shared bench is one long desk and zones never overlap along the line', () => {
  const sessions = [session(0), session(1), session(2, 'team', { branch: 'feature' })];
  const extra = [session(3, 'other'), session(4, 'other')];
  const row = layoutRow([...sessions, ...extra]);
  const [team, other] = row.zones;
  assert.equal(team.benches.length, 2);
  assert.equal(team.benches[0].width, 2 * STATION_WIDTH - 10, 'two colleagues at one desk');
  assert.equal(team.stations[1].x - team.stations[0].x, STATION_WIDTH);
  assert.ok(other.x >= team.x + team.width, 'zones sit side by side');
  assert.equal(row.width, other.x + other.width);
});

test('helper desks follow the bench they belong to without splitting it', () => {
  const host = session(0);
  const mate = session(1);
  const helpers = [0, 1].map((i) =>
    session(10 + i, 'team', { attachedTo: host.id, officeSeat: undefined }),
  );
  const row = layoutRow([host, mate, ...helpers]);
  const zone = row.zones[0];
  assert.equal(zone.benches.length, 1);
  assert.deepEqual(
    zone.helpers.map((h) => h.parent),
    [host.id, host.id],
  );
  const benchEnd = zone.benches[0].x - 5 + 2 * STATION_WIDTH;
  assert.ok(zone.helpers.every((h) => h.x >= benchEnd));
  assert.ok(zone.helpers[1].x > zone.helpers[0].x);
});

test('desks speak the same words in both views: a notice bubble, else live progress', () => {
  const busy = session(0, 'team', { status: 'work' });
  const quiet = session(1, 'team', { status: 'idle' });
  assert.equal(stationSpeech(busy, [], 3, now).shows(false), true, 'busy shows progress');
  assert.equal(stationSpeech(quiet, [], 3, now).shows(false), false, 'quiet waits for hover');
  assert.equal(stationSpeech(quiet, [], 3, now).shows(true), true);
  const reply = notice(quiet.id);
  const speech = stationSpeech(quiet, [reply], 3, now);
  assert.equal(speech.bubble?.id, reply.id);
  assert.equal(speech.text, '결과를 남겼어요');
  assert.equal(speech.unread, 1);
  assert.equal(speech.shows(false), true);
  const old = notice(quiet.id, { receivedAt: now - 5 * 3600_000, at: now - 5 * 3600_000 });
  assert.equal(stationSpeech(quiet, [old], 3, now).bubble, undefined, 'expired after 3h');
  const busyOld = { ...old, sessionId: busy.id };
  assert.equal(stationSpeech(busy, [busyOld], 3, now).shows(false), false, 'news hides live text');
});
