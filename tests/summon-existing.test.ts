import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from '../src/lib/demo.js';
import { buildOfficeModel } from '../src/shared/office-model.js';
import { AWAY_LIMIT, awayColleagues, resumeBlock } from '../src/shared/summon-existing.js';
import type { Session, Snapshot } from '../src/shared/types.js';

const now = Date.now();
const HOUR = 3600_000;
const make = (id: string, patch: Partial<Session> = {}): Session => ({
  ...demoSnapshot().sessions[0],
  id,
  nativeId: `native-${id}`,
  provider: 'claude',
  status: 'idle',
  cwd: '/work/alpha',
  workspace: undefined,
  area: undefined,
  updatedAt: now - 10 * 60_000,
  returnedAt: undefined,
  events: [],
  activity: undefined,
  runtime: undefined,
  taskStartedAt: undefined,
  resident: undefined,
  remote: undefined,
  archived: false,
  pinned: false,
  actor: undefined,
  attachedTo: undefined,
  origin: undefined,
  relation: { kind: 'root', parentNativeId: null, source: 'fixture' },
  zone: undefined,
  ...patch,
});
const model = (sessions: Session[]) =>
  buildOfficeModel({ ...demoSnapshot(), sessions, notices: [] } as Snapshot, now);

test('lists only this project’s lounge and archive colleagues, newest first, with their zone', () => {
  const sessions = [
    make('desk'),
    make('lounge', { updatedAt: now - 6 * HOUR }),
    make('archived', { archived: true, updatedAt: now - 2 * HOUR }),
    make('old', { updatedAt: now - 9 * 86400_000 }),
    make('other-project', { cwd: '/work/beta', updatedAt: now - 6 * HOUR }),
  ];
  const m = model(sessions);
  const { list, total } = awayColleagues(m.zones, [m.view('desk')!.session]);
  assert.deepEqual(
    list.map((c) => [c.session.id, c.zone]),
    [
      ['archived', 'archive'],
      ['lounge', 'waiting'],
      ['old', 'archive'],
    ],
  );
  assert.equal(total, 3);
  assert.ok(list.every((c) => !c.block));
});

test('helpers, background runs and office residents are not offered', () => {
  const sessions = [
    make('desk'),
    make('helper', {
      updatedAt: now - 6 * HOUR,
      relation: { kind: 'subagent', parentNativeId: 'native-desk', source: 'fixture' },
    }),
    make('cron', { updatedAt: now - 6 * HOUR, origin: { kind: 'scheduled' } as Session['origin'] }),
    make('pinned', { updatedAt: now - 6 * HOUR, pinned: true }),
  ];
  const m = model(sessions);
  assert.deepEqual(awayColleagues(m.zones, [m.view('desk')!.session]).list, []);
});

test('a custom area matches by its zone key, not by folder', () => {
  const area = { key: 'area:Review', name: 'Review', ruleId: 'r', match: 'path' as const };
  const sessions = [
    make('desk', { area }),
    make('away', { cwd: '/work/other', area, updatedAt: now - 6 * HOUR }),
    make('same-folder', { updatedAt: now - 6 * HOUR }),
  ];
  const m = model(sessions);
  assert.deepEqual(
    awayColleagues(m.zones, [m.view('desk')!.session]).list.map((c) => c.session.id),
    ['away'],
  );
});

test('rows that cannot be resumed carry the reason', () => {
  assert.equal(resumeBlock(make('a')), undefined);
  assert.equal(resumeBlock(make('a', { provider: 'codex' })), undefined);
  assert.equal(resumeBlock(make('a', { provider: 'openclaw' })), 'provider');
  assert.equal(resumeBlock(make('a', { nativeId: '' })), 'conversation');
  assert.equal(resumeBlock(make('a', { nativeId: '-flag' })), 'conversation');
  assert.equal(resumeBlock(make('a', { cwd: undefined })), 'folder');
  assert.equal(resumeBlock(make('a', { cwd: '~/x' })), 'folder');
  assert.equal(
    resumeBlock(make('a', { remote: { officeId: 'o' } as Session['remote'] })),
    'remote',
  );
});

test('long archives are capped but counted', () => {
  const sessions = [
    make('desk'),
    ...Array.from({ length: AWAY_LIMIT + 5 }, (_, i) =>
      make(`a${i}`, { archived: true, updatedAt: now - (i + 1) * HOUR }),
    ),
  ];
  const m = model(sessions);
  const { list, total } = awayColleagues(m.zones, [m.view('desk')!.session]);
  assert.equal(list.length, AWAY_LIMIT);
  assert.equal(total, AWAY_LIMIT + 5);
  assert.equal(list[0].session.id, 'a0');
});
