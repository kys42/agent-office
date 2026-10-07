import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { demoSnapshot } from '../src/lib/demo.js';
import {
  layoutOffice,
  layoutSignature,
  STATION_WIDTH,
  STATION_HEIGHT,
} from '../src/shared/office-layout.js';
import { allocateSeats, benchKey } from '../src/shared/office.js';
import { branchInfo } from '../src/shared/branch.js';
import { resolveWorkspace, enrichWorkspaces } from '../server/workspaces.js';
import { parseRecords } from '../server/adapters/normalize.js';
import type { Session } from '../src/shared/types.js';
import { setLocale } from '../src/shared/i18n/index.js';
// These tests assert the original Korean copy: pin the language so results never depend on the
// machine (services resolve `auto` through AGENT_OFFICE_LOCALE first).
process.env.AGENT_OFFICE_LOCALE = 'ko';
setLocale('ko');
const base = demoSnapshot().sessions[0];
function session(i: number, project = 'team'): Session {
  return {
    ...base,
    id: `fixture:${i}`,
    nativeId: `${i}`,
    project,
    cwd: `/tmp/${project}`,
    officeSeat: i * 6,
    branch: 'main',
  };
}
test('Sparse legacy seat tokens occupy only actual desks, grouped by project and bench', () => {
  const sessions = [
    session(0),
    session(1, 'other'),
    session(2),
    { ...session(3), branch: 'feature' },
  ];
  const l = layoutOffice(sessions, 2);
  assert.equal(l.projects.length, 2);
  assert.equal(l.projects.flatMap((p) => p.stations).length, 4);
  const team = l.projects.find((p) => p.name === 'team')!;
  assert.equal(team.stations.length, 3);
  assert.equal(team.benches.find((b) => b.key === benchKey(sessions[0]))?.members.length, 2);
  const [a, b] = team.stations;
  assert.equal(b.x - a.x, STATION_WIDTH);
  assert.equal(a.y, b.y);
  assert.ok(l.width < 1600 && l.height < 900, 'legacy tokens do not make distant floors');
  const previous = Object.fromEntries(sessions.map((s) => [s.id, s.officeSeat!]));
  assert.equal(allocateSeats([...sessions, session(4)], previous)['fixture:4'], 1);
});
test('Furniture topology stays fixed when timestamps, state, pin and input order change', () => {
  const sessions = Array.from({ length: 18 }, (_, i) => session(i, `team${i % 4}`));
  const updated = sessions
    .toReversed()
    .map((s) => ({ ...s, status: 'think' as const, updatedAt: Date.now() + 10000, pinned: true }));
  assert.equal(layoutSignature(sessions), layoutSignature(updated));
  assert.deepEqual(layoutOffice(sessions), layoutOffice(updated));
});
test('Every desk and helper stays in a nonoverlapping project area at dense and narrow sizes', () => {
  for (const count of [1, 7, 24, 120])
    for (const aspect of [0.7, 1.4, 2.5]) {
      const roots = Array.from({ length: count }, (_, i) => session(i, `team${i % 5}`));
      const helpers = Array.from({ length: 5 }, (_, i) => ({
        ...session(count + i),
        attachedTo: roots[0].id,
      }));
      const all = [...roots, ...helpers],
        l = layoutOffice(all, aspect);
      const ids = l.projects.flatMap((p) =>
        p.stations.flatMap((s) => [s.id, ...s.children.map((c) => c.id)]),
      );
      assert.deepEqual(ids.sort(), all.map((s) => s.id).sort());
      for (const p of l.projects) {
        assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.width <= l.width && p.y + p.height <= l.height);
        for (const s of p.stations) {
          assert.ok(s.x + STATION_WIDTH <= p.width && s.y + STATION_HEIGHT <= p.height);
          for (const c of s.children) {
            assert.ok(c.x + 68 <= p.width && c.y + 68 <= p.height);
            assert.ok(c.y >= s.y + STATION_HEIGHT - 4);
          }
        }
        for (const q of l.projects.filter((q) => q !== p))
          assert.ok(
            p.x + p.width <= q.x ||
              q.x + q.width <= p.x ||
              p.y + p.height <= q.y ||
              q.y + q.height <= p.y,
          );
      }
    }
});
test('Named branch, recorded commit, current checkout and unknown have distinct provenance', () => {
  const s = session(0);
  const workspace = {
    key: 'git:repo',
    name: 'team',
    root: '/tmp/team',
    worktree: '/tmp/team',
    evidence: 'git-common-dir' as const,
    git: {
      branch: 'current-branch',
      commit: 'b'.repeat(40),
      state: 'branch' as const,
      observedAt: Date.now(),
    },
  };
  assert.equal(branchInfo({ ...s, workspace }).label, 'main');
  assert.equal(branchInfo({ ...s, branch: null, workspace }).label, 'current-branch · 현재');
  assert.equal(
    branchInfo({ ...s, branch: null, gitCommit: 'a'.repeat(40), workspace }).label,
    '커밋 · aaaaaaa',
  );
  assert.equal(
    branchInfo({
      ...s,
      branch: null,
      workspace: { ...workspace, git: { ...workspace.git, state: 'detached', branch: null } },
    }).label,
    'HEAD · bbbbbbb',
  );
  assert.equal(branchInfo({ ...s, branch: null }).key, null);
  assert.notEqual(benchKey({ ...s, branch: null }), benchKey({ ...session(1), branch: null }));
});
test('Real Git worktrees resolve named, detached and unborn HEAD without overwriting recorded history', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-branches-'));
  const exec = promisify(execFile);
  const git = (...args: string[]) => exec('git', args);
  try {
    const repo = path.join(dir, 'repo'),
      detached = path.join(dir, 'detached'),
      unborn = path.join(dir, 'unborn');
    await git('init', '-b', 'main', repo);
    await git(
      '-C',
      repo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    );
    await git('-C', repo, 'worktree', 'add', '--detach', detached);
    await git('init', '-b', 'new-project', unborn);
    const a = await resolveWorkspace(repo, 'a'),
      b = await resolveWorkspace(detached, 'b'),
      c = await resolveWorkspace(unborn, 'c');
    assert.equal(a.key, b.key);
    assert.equal(a.git?.branch, 'main');
    assert.equal(b.git?.state, 'detached');
    assert.equal(b.git?.branch, null);
    assert.equal(b.git?.commit, a.git?.commit);
    assert.equal(c.git?.state, 'unborn');
    assert.equal(c.git?.branch, 'new-project');
    const [historical] = await enrichWorkspaces([
      { ...session(0), cwd: repo, branch: 'old-branch' },
    ]);
    assert.equal(historical.branch, 'old-branch');
    assert.equal(branchInfo(historical).label, 'old-branch');
    const noRepo = path.join(dir, 'folder');
    await mkdir(noRepo);
    const folder = await resolveWorkspace(noRepo, 'folder');
    assert.equal(branchInfo({ ...session(0), branch: null, workspace: folder }).label, '작업 폴더');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('Codex metadata with only a commit retains the value for detached worktrees', () => {
  const s = parseRecords(
    [
      {
        type: 'session_meta',
        payload: { id: 'one', cwd: '/tmp/team', git: { commit_hash: '7b880ba123456' } },
      },
    ],
    { provider: 'codex', sourcePath: '/tmp/one.jsonl', mtime: Date.now() },
  );
  assert.equal(s.branch, null);
  assert.equal(s.gitCommit, '7b880ba123456');
  assert.equal(branchInfo(s).label, '커밋 · 7b880ba');
});
