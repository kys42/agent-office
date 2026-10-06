import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from '../src/lib/demo.js';
import { isVeiled } from '../src/shared/veil.js';
import { buildOfficeModel, petSummary, PET_FRESH_MS } from '../src/shared/office-model.js';
import type { OfficeNotice, Session, Snapshot } from '../src/shared/types.js';
const now = Date.now();
const hiddenAt = now - 10 * 60_000;
const make = (id: string, patch: Partial<Session> = {}): Session => ({
  ...demoSnapshot().sessions[0],
  id,
  nativeId: id,
  status: 'idle',
  updatedAt: now - 20 * 60_000,
  events: [],
  activity: { text: '예전 답변', kind: 'reply', at: now - 30 * 60_000 },
  runtime: undefined,
  taskStartedAt: undefined,
  resident: undefined,
  archived: false,
  pinned: false,
  actor: undefined,
  attachedTo: undefined,
  hiddenAt: undefined,
  relation: { kind: 'root', parentNativeId: null, source: 'fixture' },
  zone: 'office',
  ...patch,
});
const notice = (sessionId: string, patch: Partial<OfficeNotice> = {}): OfficeNotice => ({
  id: `${sessionId}::${Math.random()}`,
  sessionId,
  eventId: 'e',
  kind: 'reply',
  phase: 'final',
  text: '결과',
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

test('a hidden colleague stays hidden until their next public conversation', () => {
  const s = make('a', { hiddenAt });
  assert.equal(isVeiled([s], []), true);
  assert.equal(isVeiled([s], [notice('a', { at: hiddenAt - 1000 })]), true, 'older news');
  assert.equal(isVeiled([s], [notice('a', { kind: 'request', at: hiddenAt + 1 })]), false);
  const replied = make('a', { hiddenAt, activity: { text: '새 답', kind: 'reply', at: now } });
  assert.equal(isVeiled([replied], []), false, 'a newer reply brings them back');
  const busy = make('a', { hiddenAt, activity: { text: '기록 상태', kind: 'status', at: now } });
  assert.equal(isVeiled([busy], []), true, 'tool activity alone is not a conversation');
  assert.equal(isVeiled([make('a')], []), false, 'never hidden');
  const other = make('b', { activity: { text: '새 요청', kind: 'request', at: now } });
  assert.equal(isVeiled([s, other], []), false, 'any persona member talking counts');
});

test('the model takes hidden colleagues out of scenes and the pet, never the roster', () => {
  const a = make('a', { officeSeat: 0, hiddenAt });
  const b = make('b', { officeSeat: 1 });
  const model = buildOfficeModel(snap([a, b]), now);
  assert.deepEqual(
    model.scene.map((s) => s.id),
    ['b'],
  );
  assert.deepEqual(
    model.veiled.map((v) => v.session.id),
    ['a'],
  );
  assert.equal(model.seats.length, 2, 'lists still know about everyone');
  assert.equal(model.lead?.session.id, 'b');
  assert.equal(model.counts.resting, 1);
});

test('anyone who needs the person is shown even if hidden; helpers follow their host', () => {
  const caller = make('c', { officeSeat: 0, hiddenAt, status: 'call' });
  assert.equal(buildOfficeModel(snap([caller]), now).veiled.length, 0);
  const host = make('h', { officeSeat: 0, hiddenAt });
  const helper = make('x', {
    relation: { kind: 'subagent', parentNativeId: 'h', source: 'fixture' },
    parentId: 'h',
    status: 'work',
    updatedAt: now - 5_000,
  });
  const quiet = buildOfficeModel(snap([host, helper]), now);
  assert.deepEqual(quiet.scene, [], 'a hidden host takes its helper desks with it');
  const asking = buildOfficeModel(
    snap(
      [host, { ...helper, status: 'error' }],
      [notice('x', { kind: 'error', phase: undefined, background: true, at: hiddenAt - 1 })],
    ),
    now,
  );
  assert.deepEqual(asking.scene.map((s) => s.id).sort(), ['h', 'x']);
});

test('a just-arrived result turns the collapsed pet into its colleague', () => {
  const a = make('a', { officeSeat: 0 });
  const b = make('b', { officeSeat: 1 });
  const calm = buildOfficeModel(snap([a, b]), now);
  assert.equal(petSummary(calm).speaker, undefined);
  const fresh = notice('b', { receivedAt: now - 10_000 });
  const pet = petSummary(buildOfficeModel(snap([a, b], [fresh]), now));
  assert.equal(pet.speaker?.notice.id, fresh.id);
  assert.equal(pet.lead?.session.id, 'b');
  const newer = notice('a', { receivedAt: now - 1_000 });
  assert.equal(
    petSummary(buildOfficeModel(snap([a, b], [fresh, newer]), now)).speaker?.view.session.id,
    'a',
  );
  // Late-collected older events: the latest receipt wins, even within one colleague.
  const late = notice('b', { at: now - 60_000, receivedAt: now - 500 });
  const early = notice('a', { at: now - 1_000, receivedAt: now - 5_000 });
  const mine = notice('b', { at: now - 2_000, receivedAt: now - 9_000 });
  assert.equal(
    petSummary(buildOfficeModel(snap([a, b], [late, early, mine]), now)).speaker?.notice.id,
    late.id,
  );
  for (const stale of [
    notice('b', { receivedAt: now - PET_FRESH_MS - 1 }),
    notice('b', { bootstrap: true }),
    notice('b', { dismissedAt: now }),
    notice('b', { seenAt: now }),
    notice('b', { kind: 'progress', phase: 'commentary' }),
  ])
    assert.equal(petSummary(buildOfficeModel(snap([a, b], [stale]), now)).speaker, undefined);
  const hidden = make('b', { officeSeat: 1, hiddenAt: now + 1 });
  assert.equal(
    petSummary(buildOfficeModel(snap([a, hidden], [notice('b', { at: now - 1 })]), now)).speaker,
    undefined,
    'a hidden colleague does not take over the pet',
  );
});
