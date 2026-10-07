import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from '../src/lib/demo.js';
import { ARRIVAL_MS, deskSpeech, freshRequest, stationSpeech } from '../src/shared/speech.js';
import { deskPapers, FOCUS_LABELS, focusLevel, MAX_PAPERS } from '../src/shared/presentation.js';
import { buildOfficeModel, petSummary } from '../src/shared/office-model.js';
import type { OfficeNotice, Session, Snapshot } from '../src/shared/types.js';

const now = Date.now();
const min = 60_000;
const make = (id: string, patch: Partial<Session> = {}): Session => ({
  ...demoSnapshot().sessions[0],
  id,
  nativeId: id,
  status: 'work',
  updatedAt: now,
  events: [],
  activity: undefined,
  runtime: undefined,
  taskStartedAt: now - 10 * min,
  resident: undefined,
  archived: false,
  pinned: false,
  hiddenAt: undefined,
  actor: undefined,
  attachedTo: undefined,
  relation: { kind: 'root', parentNativeId: null, source: 'fixture' },
  zone: 'office',
  ...patch,
});
const request = (sessionId: string, patch: Partial<OfficeNotice> = {}): OfficeNotice => ({
  id: `${sessionId}::${Math.random()}`,
  sessionId,
  eventId: 'e',
  kind: 'request',
  text: '새로운 요청이에요',
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
const snap = (sessions: Session[], notices: OfficeNotice[] = []): Snapshot => ({
  ...demoSnapshot(),
  sessions,
  notices,
});

test('a request plays its arrival for 15 seconds after it reaches the office, from any view', () => {
  const s = make('a');
  const fresh = request('a', { receivedAt: now - 3000 });
  assert.equal(stationSpeech(s, [fresh], 3, now).arrival?.id, fresh.id);
  // Pure: the same answer on every render, until the window ends.
  assert.equal(freshRequest([fresh], now + ARRIVAL_MS - 3001)?.id, fresh.id);
  assert.equal(freshRequest([fresh], now + ARRIVAL_MS - 3000), undefined);
  assert.equal(freshRequest([request('a', { receivedAt: now - 16_000 })], now), undefined);
  // History found at start-up, closed requests and other kinds never play.
  assert.equal(freshRequest([request('a', { bootstrap: true })], now), undefined);
  assert.equal(freshRequest([request('a', { dismissedAt: now })], now), undefined);
  assert.equal(freshRequest([request('a', { kind: 'reply' })], now), undefined);
  // A desk only hears its own (or its resident sessions') requests.
  assert.equal(stationSpeech(s, [request('b')], 3, now).arrival, undefined);
  const resident = make('a', { resident: { sessionIds: ['a', 'a2'] } as Session['resident'] });
  assert.ok(stationSpeech(resident, [request('a2')], 3, now).arrival);
  // The newest of several wins, and the desk speaks it in the person's own words.
  const older = request('a', { receivedAt: now - 8000, text: '먼저 보낸 요청' });
  const newer = request('a', { receivedAt: now - 1000, text: '방금 보낸 요청' });
  const reply = { ...request('a'), kind: 'reply' as const, text: '답장', at: now + 1 };
  const speech = deskSpeech(s, [older, newer, reply], 3, now);
  assert.equal(speech.arrival?.id, newer.id);
  assert.equal(speech.bubble?.id, newer.id);
  assert.equal(speech.tone, 'mine');
  // Once the window ends the desk's usual bubble comes back.
  assert.equal(deskSpeech(s, [older, newer, reply], 3, now + ARRIVAL_MS).bubble?.text, '답장');
});

test('focus climbs four levels with the observed task: 집중 5분, 몰입 15분, 불타는 중 30분', () => {
  const at = (minutes: number, patch: Partial<Session> = {}) =>
    focusLevel(make('a', { taskStartedAt: now - minutes * min, ...patch }), now);
  assert.equal(at(4), 0);
  assert.equal(at(6), 1);
  assert.equal(at(16), 2);
  assert.equal(at(29), 2);
  assert.equal(at(31), 3);
  assert.equal(at(120), 3);
  // Decorative heat needs live work: standing by, done or stale logs cool down.
  assert.equal(at(40, { status: 'ready' }), 0);
  assert.equal(at(40, { status: 'done' }), 0);
  assert.equal(at(40, { updatedAt: now - 3 * min }), 0);
  assert.deepEqual([...FOCUS_LABELS], ['작업 중', '집중 중', '몰입 중', '불타는 중']);
});

test('papers pile up one per five minutes of the task, stay while standing by and clear when resting', () => {
  const at = (minutes: number, patch: Partial<Session> = {}) =>
    deskPapers(make('a', { taskStartedAt: now - minutes * min, ...patch }), now);
  assert.equal(at(1), 1);
  assert.equal(at(9), 1);
  assert.equal(at(12), 2);
  assert.equal(at(35), 7);
  assert.equal(at(300), MAX_PAPERS);
  // Standing by keeps the pile of the task that just ended (start → last activity).
  assert.equal(at(35, { status: 'ready', updatedAt: now - 15 * min }), 4);
  assert.equal(at(35, { status: 'done', updatedAt: now - 1 * min }), 6);
  // Resting, going home, calls, archived or an unknown start: a clear desk.
  for (const status of ['idle', 'sleep', 'call', 'error'] as const)
    assert.equal(at(35, { status }), 0, status);
  assert.equal(at(35, { archived: true }), 0);
  assert.equal(deskPapers(make('a', { taskStartedAt: undefined }), now), 0);
});

test('the pet catches the newest arrival across visible desks without changing who it is', () => {
  const a = make('a', { officeSeat: 1 });
  const b = make('b', { officeSeat: 2 });
  // Veiled just after its request arrived (a new request would unveil it).
  const veiled = make('c', { officeSeat: 3, hiddenAt: now - 1000 });
  const first = request('a', { receivedAt: now - 5000 });
  const second = request('b', { receivedAt: now - 2000 });
  const pet = petSummary(
    buildOfficeModel(
      snap(
        [a, b, veiled],
        [first, second, request('c', { at: now - 4000, receivedAt: now - 4000 })],
      ),
      now,
    ),
  );
  assert.equal(pet.arrivals, 2, 'a veiled desk does not count');
  assert.equal(pet.arrival?.id, second.id);
  assert.equal(petSummary(buildOfficeModel(snap([a, b]), now)).arrival, undefined);
});
