import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from '../src/lib/demo.js';
import {
  FLOOR_ZONE_GAP,
  HELPER_STACK_AT,
  helperSlots,
  layoutOffice,
  layoutRow,
  officeTopology,
  STATION_WIDTH,
} from '../src/shared/office-layout.js';
import { shownSpeech, snapshotEvents, stationSpeech } from '../src/shared/speech.js';
import { stackLead } from '../src/shared/presentation.js';
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

test('from four helpers a colleague gets one stacked desk in both layouts; three keep their own', () => {
  const host = session(0);
  const helpers = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      session(10 + i, 'team', { attachedTo: host.id, officeSeat: undefined }),
    );
  assert.equal(HELPER_STACK_AT, 4);
  assert.deepEqual(
    helperSlots(helpers(3)).map((slot) => slot.stack),
    [undefined, undefined, undefined],
  );
  assert.deepEqual(
    helperSlots(helpers(4)).map((slot) => slot.stack?.length),
    [4],
  );
  const five = helpers(5);
  // Row: one helper slot right after the bench, holding all five.
  const row = layoutRow([host, ...five]);
  assert.equal(row.zones[0].helpers.length, 1);
  assert.equal(row.zones[0].helpers[0].parent, host.id);
  assert.deepEqual(
    row.zones[0].helpers[0].stack,
    five.map((h) => h.id),
  );
  assert.ok(row.width < layoutRow([host, ...helpers(3)]).width, 'narrower than three desks');
  // Big office: one slot and one helper row under the colleague.
  const office = layoutOffice([host, ...five]);
  const station = office.projects[0].stations[0];
  assert.equal(station.children.length, 1);
  assert.deepEqual(
    station.children[0].stack,
    five.map((h) => h.id),
  );
  assert.equal(office.projects[0].height, layoutOffice([host, ...helpers(1)]).projects[0].height);
});

test('a closed or expired bubble comes back only while the desk is pointed at', () => {
  const s = session(0, 'team', { status: 'idle', updatedAt: now - 10 * 60_000 });
  const closed = notice(s.id, { dismissedAt: now - 1000 });
  const speech = stationSpeech(s, [closed], 3, now);
  assert.equal(speech.bubble, undefined);
  assert.equal(speech.peek?.id, closed.id);
  assert.equal(shownSpeech(s, [closed], 3, now, speech, false), undefined, 'hidden by default');
  const shown = shownSpeech(s, [closed], 3, now, speech, true);
  assert.equal(shown?.peek, true);
  assert.equal(shown?.speech.bubble?.id, closed.id);
  assert.equal(shown?.speech.tone, 'reply', 'in its own shape');
  // Expired (older than the bubble hours) comes back the same way.
  const old = notice(s.id, { at: now - 4 * 3600_000, receivedAt: now - 4 * 3600_000 });
  const expired = stationSpeech(s, [old], 3, now);
  assert.equal(expired.bubble, undefined);
  assert.equal(shownSpeech(s, [old], 3, now, expired, true)?.speech.bubble?.id, old.id);
  // The newest notice is what comes back, not an older one.
  const older = notice(s.id, { at: now - 60_000, dismissedAt: now - 30_000, text: '예전 말' });
  assert.equal(stationSpeech(s, [older, closed], 3, now).peek?.id, closed.id);
  // A live bubble is never a peek, and a desk with no news still shows progress on hover.
  const live = notice(s.id);
  assert.equal(
    shownSpeech(s, [live], 3, now, stationSpeech(s, [live], 3, now), false)?.peek,
    false,
  );
  const quiet = stationSpeech(s, [], 3, now);
  assert.equal(quiet.peek, undefined);
  assert.equal(shownSpeech(s, [], 3, now, quiet, true)?.peek, false);
});

test('the stacked desk shows the helper that most needs the person, then one at work', () => {
  const host = session(0);
  const helper = (i: number, patch: Partial<Session>) =>
    session(10 + i, 'team', { attachedTo: host.id, officeSeat: undefined, ...patch });
  const idle = helper(0, { status: 'idle', updatedAt: now });
  const busy = helper(1, { status: 'work', updatedAt: now - 60_000 });
  const asking = helper(2, { status: 'call', updatedAt: now - 120_000 });
  const working = (s: Session) => s.status === 'work';
  assert.equal(stackLead([idle, busy, asking], working).id, asking.id);
  assert.equal(stackLead([idle, busy], working).id, busy.id);
  assert.equal(stackLead([helper(3, { updatedAt: now - 5000 }), idle], () => false).id, idle.id);
});

test('an answered call comes back settled, not calling again', () => {
  const s = session(0, 'team', { status: 'idle', updatedAt: now - 10 * 60_000 });
  const ask = notice(s.id, {
    kind: 'attention',
    phase: undefined,
    text: '원래 앱에서 질문이나 입력 요청을 확인해 주세요.',
    resolvedAt: now - 60_000,
  });
  const speech = stationSpeech(s, [ask], 3, now);
  assert.equal(speech.bubble, undefined, 'a resolved call has no bubble');
  const shown = shownSpeech(s, [ask], 3, now, speech, true);
  assert.equal(shown?.peek, true);
  assert.equal(shown?.speech.tone, 'message');
  assert.match(shown!.speech.label, /해결됨$/);
});

test('pointing at a desk quotes the latest request the person sent it', () => {
  const s = session(0, 'team', { status: 'idle', updatedAt: now - 10 * 60_000, events: [] });
  const asked = notice(s.id, {
    kind: 'request',
    phase: undefined,
    text: '로그인 화면 다듬어 줘',
    at: now - 5 * 60_000,
    receivedAt: now - 5 * 60_000,
    dismissedAt: now - 4 * 60_000,
  });
  const older = notice(s.id, {
    kind: 'request',
    phase: undefined,
    text: '예전 부탁',
    at: now - 60 * 60_000,
  });
  const scheduled = notice(s.id, {
    kind: 'request',
    phase: undefined,
    text: '정기 실행',
    at: now - 60_000,
    background: true,
  });
  const reply = notice(s.id, { text: '다듬었어요', at: now - 1000 });
  // The latest own request (closed ones too), never a background run.
  const speech = stationSpeech(s, [older, asked, scheduled, reply], 3, now);
  assert.equal(speech.bubble?.id, reply.id);
  assert.equal(speech.request?.id, asked.id);
  // A peek carries it too.
  const closedReply = { ...reply, dismissedAt: now };
  const quiet = stationSpeech(s, [asked, closedReply], 3, now);
  assert.equal(
    shownSpeech(s, [asked, closedReply], 3, now, quiet, true)?.speech.request?.id,
    asked.id,
  );
  // When the bubble already is the person's request, nothing is quoted twice.
  const fresh = notice(s.id, { kind: 'request', phase: undefined, text: '새 부탁', at: now });
  const mine = stationSpeech(s, [asked, fresh], 3, now);
  assert.equal(mine.tone, 'mine');
  assert.equal(mine.request, undefined);
  // A resident desk hears requests sent to any of its runs.
  const resident = session(0, 'team', {
    status: 'idle',
    events: [],
    resident: { sessionIds: [s.id, 'fixture:other'] } as Session['resident'],
  });
  const viaOther = notice('fixture:other', { kind: 'request', phase: undefined, at: now - 2000 });
  assert.equal(stationSpeech(resident, [viaOther, reply], 3, now).request?.id, viaOther.id);
  assert.equal(stationSpeech(s, [reply], 3, now).request, undefined, 'nothing asked yet');
});

test('the quote is the request a bubble answers, never over a background run', () => {
  const s = session(0, 'team', { status: 'idle', updatedAt: now - 10 * 60_000, events: [] });
  const first = notice(s.id, {
    kind: 'request',
    phase: undefined,
    text: '첫 부탁',
    at: now - 10 * 60_000,
  });
  const reply = notice(s.id, { text: '첫 부탁 끝', at: now - 5 * 60_000 });
  // A follow-up sent after the answer (e.g. while the pet still speaks the answer).
  const followUp = notice(s.id, {
    kind: 'request',
    phase: undefined,
    text: '후속',
    at: now - 1000,
  });
  const answered = stationSpeech(s, [first, reply, followUp], 3, now, reply);
  assert.equal(answered.bubble?.id, reply.id);
  assert.equal(answered.request?.id, first.id, 'the request this answer is for');
  // A resident desk prefers the run that is speaking.
  const resident = session(0, 'team', {
    status: 'idle',
    events: [],
    resident: { sessionIds: [s.id, 'fixture:cron'] } as Session['resident'],
  });
  const elsewhere = notice('fixture:cron', {
    kind: 'request',
    phase: undefined,
    at: now - 6 * 60_000,
  });
  assert.equal(stationSpeech(resident, [first, elsewhere, reply], 3, now).request?.id, first.id);
  // A scheduled run's output is not answering the person: nothing is quoted over it.
  const cronOut = notice('fixture:cron', { text: '정기 보고', at: now - 30_000, background: true });
  assert.equal(stationSpeech(resident, [first, cronOut], 3, now).bubble?.id, cronOut.id);
  assert.equal(stationSpeech(resident, [first, cronOut], 3, now).request, undefined);
});

test('the snapshot keeps the last requests so a quote can show its full original words', () => {
  const long =
    '로그인 화면을 다듬어 줘.\n```css\n.login { padding: 8px; }\n```\n' + '자세히 '.repeat(200);
  const events = [
    { id: 'u1', at: now - 9000, kind: 'user' as const, text: long, sourceRef: 'f' },
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `a${i}`,
      at: now - 8000 + i * 1000,
      kind: 'assistant' as const,
      text: `진행 ${i}`,
      sourceRef: 'f',
    })),
  ];
  const s = session(0, 'team', { status: 'idle', events });
  const kept = snapshotEvents(s);
  assert.ok(
    kept.some((e) => e.id === 'u1'),
    'the request survives the compact snapshot',
  );
  const asked = notice(s.id, {
    kind: 'request',
    phase: undefined,
    eventId: 'u1',
    text: '로그인 화면을 다듬어 줘.',
    at: now - 9000,
  });
  const reply = notice(s.id, { text: '다듬었어요', at: now - 1000 });
  const speech = stationSpeech({ ...s, events: kept }, [asked, reply], 3, now);
  assert.equal(speech.request?.id, asked.id);
  assert.equal(speech.requestText, long, 'the tooltip gets the original, not the excerpt');
  assert.equal(stationSpeech({ ...s, events: [] }, [asked, reply], 3, now).requestText, asked.text);
});

test('a conversation found as history still quotes the request its snapshot kept', () => {
  // First collected late: only the reply became a notice, but the user event is retained.
  const events = [
    { id: 'u1', at: now - 9000, kind: 'user' as const, text: '테스트를 고쳐 줘', sourceRef: 'f' },
    { id: 'a1', at: now - 1000, kind: 'assistant' as const, text: '고쳤어요', sourceRef: 'f' },
  ];
  const s = session(0, 'team', { status: 'idle', events });
  const reply = notice(s.id, { eventId: 'a1', text: '고쳤어요', at: now - 1000, bootstrap: true });
  const speech = stationSpeech(s, [reply], 3, now);
  assert.equal(speech.request?.text, '테스트를 고쳐 줘');
  assert.equal(speech.request?.at, now - 9000);
  // Not for a scheduled/internal run or a helper (their prompts aren't the person's words).
  for (const patch of [
    { origin: { kind: 'scheduled' } },
    { relation: { kind: 'subagent', parentNativeId: 'p', source: 'f' } },
  ] as Partial<Session>[])
    assert.equal(stationSpeech({ ...s, ...patch }, [reply], 3, now).request, undefined);
});

test("a resident's speaking run quotes its own retained request before another run's", () => {
  const events = [
    { id: 'u1', at: now - 9000, kind: 'user' as const, text: '내 실행의 부탁', sourceRef: 'f' },
  ];
  const s = session(0, 'team', {
    status: 'idle',
    events,
    resident: { sessionIds: ['fixture:0', 'fixture:other'] } as Session['resident'],
  });
  const other = notice('fixture:other', {
    kind: 'request',
    phase: undefined,
    text: '다른 실행의 부탁',
    at: now - 5000,
  });
  const reply = notice(s.id, { eventId: 'a1', text: '끝냈어요', at: now - 1000, bootstrap: true });
  assert.equal(stationSpeech(s, [other, reply], 3, now).request?.text, '내 실행의 부탁');
});
