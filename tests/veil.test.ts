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
  assert.equal(asking.view('h')?.needsPerson, true, 'no hide button for a host whose helper asks');
  assert.equal(quiet.view('h')?.needsPerson, false);
});

test('a helper hidden on its own leaves its host and siblings in place (#35)', () => {
  const host = make('h', { officeSeat: 0 });
  const helper = (id: string, patch: Partial<Session> = {}) =>
    make(id, {
      relation: { kind: 'subagent', parentNativeId: 'h', source: 'fixture' },
      parentId: 'h',
      status: 'work',
      updatedAt: now - 5_000,
      activity: { text: '조사 중', kind: 'progress', at: now - 5_000 },
      ...patch,
    });
  const model = buildOfficeModel(snap([host, helper('x', { hiddenAt }), helper('y')]), now);
  assert.deepEqual(model.scene.map((s) => s.id).sort(), ['h', 'y']);
  assert.deepEqual(
    model.veiledHelpers.map((v) => v.session.id),
    ['x'],
  );
  assert.deepEqual(model.veiled, [], 'the host itself is not hidden');
  assert.equal(model.counts.working, 1, 'the hidden helper is not counted');
  assert.equal(model.view('x')?.veiled, true);
  // Its own next conversation brings it back, like any lone desk.
  const back = buildOfficeModel(
    snap(
      [host, helper('x', { hiddenAt }), helper('y')],
      [notice('x', { kind: 'reply', background: true, at: now })],
    ),
    now,
  );
  assert.deepEqual(back.veiledHelpers, []);
  // A fresh result from a hidden helper never takes over the pet.
  const quiet = helper('x', { hiddenAt });
  assert.equal(
    petSummary(
      buildOfficeModel(
        snap([host, quiet], [notice('x', { at: hiddenAt - 1, receivedAt: now - 1 })]),
        now,
      ),
    ).speaker,
    undefined,
  );
  // Hiding the host still hides every helper; restoring it keeps one hidden on its own.
  const both = buildOfficeModel(
    snap([make('h', { officeSeat: 0, hiddenAt }), helper('x', { hiddenAt }), helper('y')]),
    now,
  );
  assert.deepEqual(both.scene, []);
  assert.deepEqual(both.veiledHelpers, [], 'listed under its host while that is hidden');
  // A helper that asks for the person is shown even if hidden, and offers no hide button.
  const asking = buildOfficeModel(snap([host, helper('x', { hiddenAt, status: 'call' })]), now);
  assert.deepEqual(asking.scene.map((s) => s.id).sort(), ['h', 'x']);
  assert.equal(asking.view('x')?.needsPerson, true);
  // Bring-everyone-back includes helpers hidden on their own.
  assert.deepEqual(model.hiddenSessionIds, ['x']);
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

test('only a real next conversation brings them back, not chatter or background runs', () => {
  const s = make('a', { hiddenAt });
  const progress = notice('a', { kind: 'progress', phase: 'commentary', at: now });
  assert.equal(isVeiled([s], [progress]), true, 'progress notes do not end the hiding');
  const working = make('a', { hiddenAt, activity: { text: '진행', kind: 'progress', at: now } });
  assert.equal(isVeiled([working], []), true);
  assert.equal(isVeiled([s], [notice('a', { background: true })]), true, 'background final');
  assert.equal(isVeiled([s], [notice('a')]), false, 'a final answer');
  // A persona's scheduled run answering does not count; its interactive session does.
  const cron = make('cron', {
    actor: { id: 'butler', name: '집사', source: 'fixture' } as Session['actor'],
    origin: { kind: 'scheduled', source: 'fixture' },
    activity: { text: '정기 보고', kind: 'reply', at: now },
  });
  assert.equal(isVeiled([s, cron], [notice('cron')]), true);
  // A helper shown at its own desk (no parent in view) returns on its own conversation.
  const loneHelper = make('h', {
    hiddenAt,
    relation: { kind: 'subagent', parentNativeId: 'gone', source: 'fixture' },
    activity: { text: '새 요청', kind: 'request', at: now },
  });
  assert.equal(isVeiled([loneHelper], []), false);
  // …also through its notices, which the store files as background.
  const loneQuiet = {
    ...loneHelper,
    activity: { text: '진행', kind: 'progress' as const, at: now },
  };
  assert.equal(isVeiled([loneQuiet], [notice('h', { kind: 'request', background: true })]), false);
  const returned = make('a', { hiddenAt, returnedAt: now });
  assert.equal(isVeiled([returned], []), false, 'bringing them back to the office shows them');
});

test('bring-everyone-back covers every hidden session, shown or not', () => {
  const caller = make('c', { officeSeat: 0, hiddenAt, status: 'call' });
  const quiet = make('q', { officeSeat: 1, hiddenAt });
  const model = buildOfficeModel(snap([caller, quiet]), now);
  assert.deepEqual(
    model.veiled.map((v) => v.session.id),
    ['q'],
  );
  assert.deepEqual(model.hiddenSessionIds.sort(), ['c', 'q']);
});

test('the pet prefers a question, skips opened news, and lets go once closed', () => {
  const a = make('a', { officeSeat: 0 });
  const b = make('b', { officeSeat: 1 });
  const reply = notice('a', { receivedAt: now - 1_000 });
  const question = notice('b', {
    kind: 'attention',
    phase: undefined,
    receivedAt: now - 20_000,
  });
  assert.equal(
    petSummary(buildOfficeModel(snap([a, b], [reply, question]), now)).speaker?.notice.id,
    question.id,
    'a question beats a newer result',
  );
  const opened = notice('a', { viewedAt: now - 500 });
  assert.equal(petSummary(buildOfficeModel(snap([a, b], [opened]), now)).speaker, undefined);
  // Closing the bubble the pet spoke releases it (no silent speaking state).
  const closed = { ...reply, dismissedAt: now };
  const pet = petSummary(buildOfficeModel(snap([a, b], [closed]), now));
  assert.equal(pet.speaker, undefined);
  assert.equal(pet.lead?.session.id, 'a', 'back to the usual representative');
  // Two results in a row: closing the newest does not replay the older one.
  const first = notice('a', { receivedAt: now - 30_000 });
  const second = notice('a', { receivedAt: now - 2_000, dismissedAt: now });
  assert.equal(petSummary(buildOfficeModel(snap([a, b], [first, second]), now)).speaker, undefined);
  const read = { ...second, dismissedAt: null, seenAt: now };
  assert.equal(
    petSummary(buildOfficeModel(snap([a, b], [first, read]), now)).speaker,
    undefined,
    'reading the newest does not replay the older one either',
  );
  const asked = notice('a', {
    kind: 'attention',
    phase: undefined,
    receivedAt: now - 3_000,
    resolvedAt: now,
  });
  assert.equal(
    petSummary(buildOfficeModel(snap([a, b], [first, asked]), now)).speaker,
    undefined,
    'a resolved question still stands in front of the older result',
  );
});
