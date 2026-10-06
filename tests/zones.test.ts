import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { demoSnapshot } from '../src/lib/demo.js';
import { layoutOffice, layoutSignature } from '../src/shared/office-layout.js';
import { benchKey, projectKey } from '../src/shared/office.js';
import {
  applyZone,
  matchZone,
  sendToZone,
  zoneCandidates,
  zoneLabel,
  zoneOptions,
} from '../src/shared/zones.js';
import { OfficeService } from '../server/service.js';
import { parseRecords } from '../server/adapters/normalize.js';
import type { Session, ZoneRule } from '../src/shared/types.js';

const base = demoSnapshot().sessions[0];
const REPO = 'git:/work/mono/.git';
function session(
  i: number,
  cwd: string,
  worktree: string,
  branch: string | null = 'main',
): Session {
  return {
    ...base,
    id: `zone:${i}`,
    nativeId: `${i}`,
    project: 'mono',
    cwd,
    branch,
    officeSeat: i,
    attachedTo: undefined,
    workspace: {
      key: REPO,
      name: 'mono',
      root: '/work/mono',
      worktree,
      evidence: 'git-common-dir',
    },
  };
}
const rule = (id: string, name: string, match: ZoneRule['match'], value: string, repo = REPO) =>
  ({ id, name, match, value, repo }) as ZoneRule;

test('Zone rules match explicitly and the most specific rule wins', () => {
  const lab = session(
    1,
    '/work/mono/.claude/worktrees/lab/apps/lab',
    '/work/mono/.claude/worktrees/lab',
    'kys42/lab-lead',
  );
  const rules = [
    rule('b', 'lab-branches', 'branch', 'kys42/lab-*'),
    rule('p', 'apps', 'path', '/work/mono/.claude/worktrees/lab'),
    rule('w', 'lab', 'worktree', '/work/mono/.claude/worktrees/lab/'),
  ];
  assert.equal(matchZone(lab, rules)?.id, 'w', 'worktree beats folder and branch');
  assert.equal(matchZone(lab, [...rules, rule('s', 'solo', 'session', lab.id)])?.id, 's');
  assert.equal(matchZone(lab, rules.slice(0, 2))?.id, 'p', 'folder beats branch');
  assert.equal(
    matchZone(lab, [
      rule('b', 'x', 'branch', 'kys42/lab-*'),
      rule('e', 'y', 'branch', 'kys42/lab-lead'),
    ])?.id,
    'e',
    'exact/longer branch pattern beats a prefix',
  );
});

test('Folder rules respect path boundaries; repo scope keeps other clones out', () => {
  const sibling = session(2, '/work/mono/apps/lab2', '/work/mono');
  const inside = session(3, '/work/mono/apps/lab/src', '/work/mono');
  const r = rule('p', 'lab', 'path', '/work/mono/apps/lab');
  assert.equal(matchZone(sibling, [r]), undefined);
  assert.equal(matchZone(inside, [r])?.id, 'p');
  const otherClone = {
    ...inside,
    workspace: { ...inside.workspace!, key: 'git:/elsewhere/mono/.git' },
  };
  assert.equal(matchZone(otherClone, [r]), undefined);
  assert.equal(
    matchZone({ ...inside, branch: null, workspace: { ...inside.workspace!, git: undefined } }, [
      rule('b', 'x', 'branch', 'main'),
    ]),
    undefined,
    'unknown branch never matches',
  );
});

test('Custom areas split one monorepo floor without touching unrelated sessions', () => {
  const sessions = [
    session(0, '/work/mono', '/work/mono'),
    session(1, '/work/mono/wt/lab', '/work/mono/wt/lab', 'kys42/lab-lead'),
    session(2, '/work/mono/wt/lab', '/work/mono/wt/lab', 'kys42/lab-lead'),
    session(3, '/work/mono/wt/golden', '/work/mono/wt/golden', 'kys42/lab-golden'),
    { ...session(4, '/work/other', '/work/other'), project: 'other', workspace: undefined },
  ];
  const before = layoutOffice(sessions);
  assert.deepEqual(before.projects.map((p) => p.name).sort(), ['mono', 'other']);
  const rules = [
    rule('w', 'agent-lab', 'worktree', '/work/mono/wt/lab'),
    rule('b', 'agent-lab', 'branch', 'kys42/lab-golden'),
  ];
  const zoned = sessions.map((s) => applyZone(s, rules));
  const after = layoutOffice(zoned);
  assert.deepEqual(after.projects.map((p) => p.name).sort(), ['agent-lab', 'mono', 'other']);
  const lab = after.projects.find((p) => p.name === 'agent-lab')!;
  assert.equal(lab.stations.length, 3);
  assert.deepEqual(lab.custom, ['mono']);
  assert.equal(after.projects.find((p) => p.name === 'mono')!.custom, undefined);
  // Same worktree + branch still shares one long bench inside the custom area.
  assert.equal(lab.benches.find((b) => b.key === benchKey(zoned[1]))?.members.length, 2);
  assert.notEqual(layoutSignature(sessions), layoutSignature(zoned), 'area changes re-layout');
  assert.equal(zoneLabel(zoned[1]), 'agent-lab');
  assert.equal(zoneLabel(zoned[0]), 'mono');
  assert.equal(projectKey(applyZone(zoned[1], [])), REPO, 'removing the rule returns the session');
});

test('Inspector offers worktree, sub-folder, branch and session scopes in that order', () => {
  const s = session(5, '/work/mono/wt/lab/apps/api', '/work/mono/wt/lab', 'feat/x');
  assert.deepEqual(
    zoneCandidates(s).map((c) => [c.match, c.value, c.repo]),
    [
      ['worktree', '/work/mono/wt/lab', REPO],
      ['path', '/work/mono/wt/lab/apps/api', REPO],
      ['branch', 'feat/x', REPO],
      ['session', s.id, undefined],
    ],
  );
  const plain = { ...s, cwd: '/work/mono/wt/lab', branch: null };
  assert.deepEqual(
    zoneCandidates(plain).map((c) => c.match),
    ['worktree', 'session'],
  );
});

test('Zone rules persist through preferences, validate, and decorate stored sessions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-zones-'));
  const service = new OfficeService(dir);
  try {
    const s = parseRecords(
      [{ type: 'session_meta', payload: { id: 'z1', cwd: '/test/mono/apps/lab' } }],
      { provider: 'codex', sourcePath: '/test/z1.jsonl', mtime: Date.now() },
    );
    service.store.upsert([s], 'codex');
    const snap = (await service.call('preferences', [
      { zoneRules: [{ id: 'r1', name: ' lab ', match: 'path', value: '/test/mono/apps' }] },
    ])) as { sessions: Session[] };
    assert.equal(snap.sessions[0].area?.name, 'lab', 'names are trimmed and applied');
    assert.equal(service.store.get(s.id).area?.ruleId, 'r1');
    await assert.rejects(
      service.call('preferences', [
        { zoneRules: [{ id: 'r2', name: '', match: 'path', value: '/x' }] },
      ]),
    );
    await assert.rejects(
      service.call('preferences', [
        { zoneRules: [{ id: 'r3', name: 'x', match: 'regex', value: '.*' }] },
      ]),
    );
    service.store.preferences({ zoneRules: [] });
    assert.equal(service.store.get(s.id).area, undefined);
  } finally {
    service.store.close();
    await rm(dir, { recursive: true });
  }
});

test('Sending to an existing zone: custom areas, joining a project zone, and coming home', () => {
  let n = 0;
  const id = () => `r${++n}`;
  const lab = session(1, '/work/mono/wt/lab', '/work/mono/wt/lab', 'kys42/lab-lead');
  const other = {
    ...session(2, '/work/app', '/work/app'),
    project: 'app',
    workspace: { ...lab.workspace!, key: 'git:/work/app/.git', worktree: '/work/app' },
  };
  const worktree = zoneCandidates(lab)[0];
  // New custom area by worktree.
  let rules = sendToZone(lab, [], worktree, { key: 'area:agent-lab', name: 'agent-lab' }, id);
  assert.deepEqual(rules, [{ id: 'r1', name: 'agent-lab', ...worktree }]);
  // Same scope again just re-points the existing rule, no duplicates.
  rules = sendToZone(lab, rules, worktree, { key: 'area:lab', name: 'lab' }, id);
  assert.equal(rules.length, 1);
  assert.equal(applyZone(lab, rules).area?.key, 'area:lab');
  // Joining another project's zone uses its key, not a lookalike custom area.
  const joined = sendToZone(lab, rules, worktree, { key: 'git:/work/app/.git', name: 'app' }, id);
  const moved = applyZone(lab, joined);
  assert.equal(projectKey(moved), projectKey(other));
  const layout = layoutOffice([moved, applyZone(other, joined)]);
  assert.equal(layout.projects.length, 1);
  assert.equal(layout.projects[0].custom, undefined, 'a joined project zone stays a project zone');
  // Back home by the same scope removes the rule entirely.
  assert.deepEqual(sendToZone(lab, rules, worktree, { key: REPO, name: 'mono' }, id), []);
  // Back home for one session while a broader rule remains adds an override.
  const solo = zoneCandidates(lab).at(-1)!;
  const override = sendToZone(lab, rules, solo, { key: REPO, name: 'mono' }, id);
  assert.equal(override.length, 2);
  assert.equal(applyZone(lab, override).area, undefined);
  assert.equal(projectKey(applyZone(lab, override)), REPO);
});

test('Zone options list custom areas first, then project zones, with seated counts', () => {
  const rules = [
    rule('w', 'agent-lab', 'worktree', '/work/mono/wt/lab'),
    rule('e', 'empty', 'branch', 'nope'),
  ];
  const sessions = [
    session(0, '/work/mono', '/work/mono'),
    session(1, '/work/mono/wt/lab', '/work/mono/wt/lab'),
    session(2, '/work/mono/wt/lab', '/work/mono/wt/lab'),
  ].map((s) => ({ ...applyZone(s, rules), zone: 'office' as const }));
  assert.deepEqual(
    zoneOptions(sessions, rules).map((z) => [z.name, z.custom, z.count]),
    [
      ['agent-lab', true, 2],
      ['empty', true, 0],
      ['mono', false, 1],
    ],
  );
});
