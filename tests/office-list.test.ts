import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from '../src/lib/demo.js';
import { officeListGroups, officeListPrefs } from '../src/shared/office-list.js';

test('list order follows observed activity, including pinned rows, without moving seats', () => {
  const sessions = demoSnapshot().sessions.slice(0, 3);
  sessions[2].pinned = true;
  const before = sessions.map((s) => [s.id, s.officeSeat]);
  const rows = officeListGroups([...sessions].reverse(), 'recent')[0].sessions;
  assert.deepEqual(
    rows.map((s) => s.id),
    sessions.map((s) => s.id),
  );
  assert.deepEqual(
    sessions.map((s) => [s.id, s.officeSeat]),
    before,
  );
});

test('project groups use exact workspace/area identity, not shared display names', () => {
  const [a, b, c, d] = demoSnapshot().sessions.slice(0, 4);
  for (const s of [a, b, c, d]) s.project = 'same-name';
  a.cwd = c.cwd = '/one/repo';
  b.cwd = '/other/repo';
  d.area = { key: 'area:custom', name: 'My zone', ruleId: 'custom', match: 'session' };
  const groups = officeListGroups([d, c, b, a], 'project');
  assert.deepEqual(
    groups.map((g) => g.sessions.map((s) => s.id)),
    [[a.id, c.id], [b.id], [d.id]],
  );
  assert.equal(groups[2].label, 'My zone');
  assert.equal(new Set(groups.map((g) => g.key)).size, 3);
});

test('missing, old and invalid viewer preferences keep the graphic default', () => {
  for (const raw of [
    null,
    'list',
    {},
    { zone: 'office', sort: 'recent' },
    { view: 'bad', order: 'bad' },
  ])
    assert.deepEqual(officeListPrefs(raw), { view: 'graphic', order: 'recent' });
  assert.deepEqual(officeListPrefs({ view: 'list', order: 'project' }), {
    view: 'list',
    order: 'project',
  });
});
