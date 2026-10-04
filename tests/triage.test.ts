import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from '../src/lib/demo.js';
import { awayDigest, triage, triageGroup, unreadInbox, workingFor } from '../src/shared/triage.js';
import type { OfficeNotice, Session } from '../src/shared/types.js';
const now = Date.now();
const make = (id: string, patch: Partial<Session> = {}): Session => ({
  ...demoSnapshot().sessions[0],
  id,
  nativeId: id,
  status: 'idle',
  updatedAt: now - 10 * 60_000,
  events: [],
  activity: undefined,
  taskStartedAt: undefined,
  resident: undefined,
  archived: false,
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

test('triage puts calls first, then unread finals, then live work, then the rest', () => {
  const call = make('call', { status: 'call' });
  const result = make('result');
  const busy = make('busy', { status: 'work', updatedAt: now - 5_000 });
  const stale = make('stale', { status: 'work', updatedAt: now - 30 * 60_000 });
  const notices = [notice('result')];
  const groups = triage([stale, busy, result, call], notices, now);
  assert.deepEqual(
    groups.map((g) => [g.group, g.sessions.map((s) => s.id)]),
    [
      ['attention', ['call']],
      ['results', ['result']],
      ['working', ['busy']],
      ['resting', ['stale']],
    ],
  );
});

test('progress, read and background finals do not create a result to check', () => {
  const s = make('s');
  assert.equal(
    triageGroup(s, [notice('s', { kind: 'progress', phase: 'commentary' })], now),
    'resting',
  );
  assert.equal(triageGroup(s, [notice('s', { seenAt: now })], now), 'resting');
  assert.equal(triageGroup(s, [notice('s', { background: true })], now), 'resting');
  assert.equal(triageGroup(s, [notice('s', { phase: undefined })], now), 'resting');
});

test('an unresolved question on any persona run escalates the colleague', () => {
  const persona = make('a', {
    resident: {
      key: 'actor:x',
      name: 'x',
      sessionIds: ['a', 'b'],
      activeCount: 0,
      backgroundCount: 0,
    },
  });
  const ask = notice('b', { kind: 'attention', phase: undefined });
  assert.equal(triageGroup(persona, [ask], now), 'attention');
  assert.equal(triageGroup(persona, [{ ...ask, resolvedAt: now }], now), 'resting');
  assert.equal(unreadInbox(persona, [ask, notice('c')]).length, 1);
});

test('working time comes from the observed task start and only while working', () => {
  const busy = make('w', {
    status: 'work',
    updatedAt: now - 1_000,
    taskStartedAt: now - 23 * 60_000,
  });
  assert.equal(Math.round(workingFor(busy, now)! / 60_000), 23);
  assert.equal(workingFor({ ...busy, status: 'idle' }, now), null);
  assert.equal(workingFor({ ...busy, taskStartedAt: undefined }, now), null);
});

test('away digest only counts new unread inbox notices after leaving, never bootstrap history', () => {
  const left = now - 60 * 60_000;
  const digest = awayDigest(
    [
      notice('a', { receivedAt: now - 10_000 }),
      notice('b', { kind: 'attention', phase: undefined, receivedAt: now - 5_000 }),
      notice('c', { receivedAt: now - 2 * 3600_000 }),
      notice('d', { bootstrap: true }),
      notice('e', { seenAt: now }),
      notice('f', { kind: 'progress', phase: 'commentary' }),
    ],
    left,
  );
  assert.deepEqual(
    { ...digest, sessionIds: digest.sessionIds.sort() },
    {
      results: 1,
      attention: 1,
      sessionIds: ['a', 'b'],
    },
  );
});

test('away digest is frozen at the moment of return; later news is not "while away"', () => {
  const from = now - 10 * 60_000;
  const back = now - 60 * 60_000 + 11 * 60_000;
  const later = notice('late', { receivedAt: back + 60 * 60_000 });
  assert.equal(awayDigest([later], from - 60 * 60_000, back).results, 0);
  assert.equal(awayDigest([later], from - 60 * 60_000).results, 1);
});
