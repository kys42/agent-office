import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from '../src/lib/demo.js';
import {
  FLOOR_ZONE_GAP,
  layoutOffice,
  layoutRow,
  officeTopology,
  STATION_WIDTH,
} from '../src/shared/office-layout.js';
import { snapshotEvents, stationSpeech } from '../src/shared/speech.js';
import type { OfficeNotice, Session } from '../src/shared/types.js';
import { setLocale } from '../src/shared/i18n/index.js';
// These tests assert the original Korean copy: pin the language so results never depend on the
// machine (services resolve `auto` through AGENT_OFFICE_LOCALE first).
process.env.AGENT_OFFICE_LOCALE = 'ko';
setLocale('ko');
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

test('the pet can speak the notice that woke it, not just the desk’s latest one', () => {
  const s = session(0, 'team', { status: 'idle' });
  const reply = notice(s.id, { at: now - 2_000 });
  const progress = notice(s.id, {
    kind: 'progress',
    phase: 'commentary',
    text: '진행 중',
    at: now,
  });
  assert.equal(stationSpeech(s, [reply, progress], 3, now).bubble?.id, progress.id);
  const focused = stationSpeech(s, [reply, progress], 3, now, reply);
  assert.equal(focused.bubble?.id, reply.id);
  assert.equal(focused.text, reply.text);
  assert.equal(focused.label, '최종 응답');
});

test('bubbles speak the original wording, keeping "~" and inline style, never code blocks', () => {
  const text = '지난주(9/28~10/2) **데일리** 중 `9/28~9/30`\n```sh\nsecret\n```';
  const s = session(0, 'team', {
    status: 'work',
    events: [{ id: 'm1', kind: 'assistant', text, at: now, phase: 'final', sourceRef: 'fixture' }],
    activity: {
      text: '지난주(9/2810/2) 데일리 중 9/289/30',
      kind: 'reply',
      at: now,
      eventId: 'm1',
    },
  });
  const live = stationSpeech(s, [], 3, now);
  assert.equal(live.markdown, '지난주(9/28~10/2) **데일리** 중 `9/28~9/30`');
  const reply = notice(s.id, { eventId: 'm1' });
  assert.equal(stationSpeech(s, [reply], 3, now).markdown, live.markdown);
  const asks = notice(s.id, { kind: 'attention', phase: undefined, eventId: 'm1' });
  assert.equal(stationSpeech(s, [asks], 3, now).markdown, null, 'questions keep their sentence');
  const gone = notice(s.id, { eventId: 'elsewhere' });
  assert.equal(stationSpeech(s, [gone], 3, now).markdown, null, 'falls back to the excerpt');
});

test('the compact snapshot keeps the message a desk is speaking', () => {
  const events = Array.from({ length: 10 }, (_, i) => ({
    id: `e${i}`,
    kind: i === 2 ? ('assistant' as const) : ('tool' as const),
    text: i === 2 ? '최종 답변' : 'tool',
    at: now - (10 - i) * 1000,
    sourceRef: 'fixture',
  }));
  const s = session(0, 'team', {
    events,
    activity: { text: '최종 답변', kind: 'reply', at: now, eventId: 'e2' },
  });
  assert.deepEqual(
    snapshotEvents(s).map((e) => e.id),
    ['e2', 'e6', 'e7', 'e8', 'e9'],
  );
  const recentOnly = session(0, 'team', { events, activity: { ...s.activity!, eventId: 'e9' } });
  assert.equal(snapshotEvents(recentOnly).length, 4);
});

test('each kind of speech gets its own bubble tone', () => {
  const tone = (status: Session['status'], n?: Partial<OfficeNotice>, kind = 'progress') =>
    stationSpeech(
      session(0, 'team', {
        status,
        activity: { text: 'x', kind: kind as 'progress', at: now },
      }),
      n ? [notice('fixture:0', n)] : [],
      3,
      now,
    ).tone;
  assert.equal(tone('idle', { kind: 'request', phase: undefined }), 'mine');
  assert.equal(tone('think', { kind: 'progress', phase: 'commentary' }), 'thought');
  assert.equal(tone('work', { kind: 'progress', phase: 'commentary' }), 'progress');
  assert.equal(tone('done', { kind: 'reply', phase: 'final' }), 'reply');
  assert.equal(tone('done', { kind: 'reply', phase: undefined }), 'message');
  assert.equal(tone('call', { kind: 'attention', phase: undefined }), 'attention');
  assert.equal(tone('call', { kind: 'progress', phase: 'commentary' }), 'attention', 'calling');
  assert.equal(tone('call', { kind: 'request', phase: undefined }), 'mine', 'my words stay mine');
  assert.equal(tone('error', { kind: 'error', phase: undefined }), 'error');
  // Live speech without a notice follows the colleague's state.
  assert.equal(tone('think'), 'thought');
  assert.equal(tone('work'), 'progress');
  assert.equal(tone('call'), 'attention');
  assert.equal(tone('idle', undefined, 'request'), 'mine');
  assert.equal(tone('idle', undefined, 'reply'), 'reply');
});

test('the floor version keeps the same topology with room for a flag between zones', () => {
  const sessions = [session(0), session(1), session(2, 'other'), session(3, 'third')];
  const row = layoutRow(sessions);
  const floor = layoutRow(sessions, { zoneGap: FLOOR_ZONE_GAP });
  assert.deepEqual(
    floor.zones.map((z) => [z.key, z.stations.map((s) => s.id), z.benches.length]),
    row.zones.map((z) => [z.key, z.stations.map((s) => s.id), z.benches.length]),
  );
  for (let i = 1; i < floor.zones.length; i++)
    assert.equal(
      floor.zones[i].x - (floor.zones[i - 1].x + floor.zones[i - 1].width),
      FLOOR_ZONE_GAP,
      'a flag pole fits between zones',
    );
  assert.equal(floor.width - row.width, (FLOOR_ZONE_GAP - 18) * (floor.zones.length - 1));
});
