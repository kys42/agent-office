import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from '../src/lib/demo.js';
import { officeResidents } from '../src/shared/residents.js';
import { triage } from '../src/shared/triage.js';
import { unreadNoticeCount } from '../src/shared/notices.js';
import {
  buildOfficeModel,
  hasNews,
  petSummary,
  PET_FRESH_MS,
  residentLabel,
} from '../src/shared/office-model.js';
import type { OfficeNotice, Session, Snapshot } from '../src/shared/types.js';
const now = Date.now();
const make = (id: string, patch: Partial<Session> = {}): Session => ({
  ...demoSnapshot().sessions[0],
  id,
  nativeId: id,
  status: 'idle',
  updatedAt: now - 10 * 60_000,
  events: [],
  activity: undefined,
  runtime: undefined,
  taskStartedAt: undefined,
  resident: undefined,
  archived: false,
  pinned: false,
  actor: undefined,
  attachedTo: undefined,
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

test('the model keeps the same projection and seat order the big office used', () => {
  const s = demoSnapshot();
  const model = buildOfficeModel(s, now);
  const expected = officeResidents(s.sessions, now)
    .sessions.filter((x) => x.zone === 'office')
    .sort((a, b) => (a.officeSeat ?? 0) - (b.officeSeat ?? 0));
  assert.deepEqual(
    model.bySeat.map((x) => x.id),
    expected.map((x) => x.id),
  );
  assert.deepEqual(
    model.seats.map((v) => v.session.officeSeat),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(model.zones.waiting.length, 1);
  assert.equal(model.zones.archive.length, 1);
  assert.equal(model.unread, unreadNoticeCount(s.notices ?? []));
});

test('every view reads the same triage groups as the roster', () => {
  const sessions = [
    make('rest', { officeSeat: 0 }),
    make('busy', { officeSeat: 1, status: 'work', updatedAt: now - 5_000 }),
    make('call', { officeSeat: 2, status: 'call' }),
    make('result', { officeSeat: 3 }),
  ];
  const notices = [notice('result')];
  const model = buildOfficeModel(snap(sessions, notices), now);
  const roster = Object.fromEntries(
    triage(sessions, notices, now).flatMap((g) => g.sessions.map((s) => [s.id, g.group])),
  );
  for (const v of model.seats) assert.equal(v.group, roster[v.session.id]);
  assert.deepEqual(model.counts, { attention: 1, results: 1, working: 1, resting: 1 });
});

test('the pet speaks for the most urgent colleague, falling back to seat order', () => {
  // Old news: a just-arrived notice would take over the pet (covered in veil.test.ts).
  const old = { receivedAt: now - PET_FRESH_MS - 1 };
  const quiet = buildOfficeModel(
    snap([make('b', { officeSeat: 1 }), make('a', { officeSeat: 0 })]),
    now,
  );
  assert.equal(petSummary(quiet).lead?.session.id, 'a');
  assert.deepEqual(
    [petSummary(quiet).group, petSummary(quiet).label, petSummary(quiet).count],
    ['resting', '쉬는 중', 2],
  );
  const busy = buildOfficeModel(
    snap(
      [
        make('a', { officeSeat: 0 }),
        make('w', { officeSeat: 1, status: 'work', updatedAt: now - 5_000 }),
        make('r', { officeSeat: 2 }),
      ],
      [notice('r', old)],
    ),
    now,
  );
  assert.equal(petSummary(busy).lead?.session.id, 'r');
  assert.equal(petSummary(busy).label, '새 소식');
  assert.equal(petSummary(busy).calling, false);
  const calling = buildOfficeModel(
    snap(
      [make('r', { officeSeat: 0 }), make('c', { officeSeat: 1, status: 'call' })],
      [notice('r', old)],
    ),
    now,
  );
  assert.equal(petSummary(calling).lead?.session.id, 'c');
  assert.equal(petSummary(calling).group, 'attention');
  assert.equal(petSummary(calling).calling, true);
  assert.equal(petSummary(buildOfficeModel(null, now)).lead, undefined);
});

test('a helper that needs the person makes the pet call, like the roster', () => {
  const host = make('host', { officeSeat: 0 });
  const other = make('other', { officeSeat: 1, status: 'work', updatedAt: now - 5_000 });
  const helper = make('helper', {
    relation: { kind: 'subagent', parentNativeId: 'host', source: 'fixture' },
    parentId: 'host',
    status: 'error',
    updatedAt: now - 5_000,
  });
  // Real stores mark helper news as background: finals drop out, questions/errors stay.
  const notices = [
    notice('helper', { kind: 'error', phase: undefined, background: true }),
    notice('helper', { background: true }),
  ];
  const model = buildOfficeModel(snap([host, other, helper], notices), now);
  const seat = model.seats.find((v) => v.session.id === 'host')!;
  assert.equal(model.seats.length, 2, 'helpers sit beside their host, not at their own desk');
  assert.deepEqual(
    seat.helpers.map((v) => v.session.id),
    ['helper'],
  );
  assert.equal(seat.unread.length, 0);
  assert.equal(seat.helperUnread.length, 1, 'background finals are not important news');
  assert.ok(hasNews(seat));
  const roster = Object.fromEntries(
    triage(model.bySeat, notices, now).flatMap((g) => g.sessions.map((s) => [s.id, g.group])),
  );
  assert.equal(roster.helper, 'attention');
  assert.equal(model.counts.attention, 1);
  const pet = petSummary(model);
  assert.equal(pet.group, 'attention');
  assert.equal(pet.calling, true);
  assert.equal(pet.lead?.session.id, 'helper');
  assert.equal(model.ownerOf('host')?.id, 'host');
});

test('actor members resolve to the resident that owns the desk', () => {
  const actor = { id: 'butler', name: '집사', source: 'fixture' } as Session['actor'];
  const model = buildOfficeModel(
    snap([
      make('m1', { actor, officeSeat: 0, status: 'work', updatedAt: now - 1_000 }),
      make('m2', { actor, officeSeat: 2 }),
    ]),
    now,
  );
  assert.equal(model.seats.length, 1);
  assert.equal(model.view('m2')?.session.id, 'm1');
  assert.deepEqual(model.view('m2')?.session.resident?.sessionIds, ['m1', 'm2']);
});

test('screen sharing masks names, projects and activity in one place', () => {
  const s = make('x', { alias: '코코', project: 'secret-project' });
  assert.deepEqual(residentLabel(s, true), {
    name: s.provider,
    project: '프로젝트',
    detail: undefined,
  });
  const open = residentLabel(s, false);
  assert.equal(open.name, '코코');
  assert.equal(open.project, 'secret-project');
  assert.match(open.detail ?? '', / · /);
});
