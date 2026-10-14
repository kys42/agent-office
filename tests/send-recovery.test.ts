import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { demoSnapshot } from '../src/lib/demo.js';
import { recoverWorkspaces } from '../src/shared/workspace-recovery.js';
import { projectKey } from '../src/shared/office.js';
import { OfficeStore } from '../server/store.js';
import { settleSends, type PendingSend } from '../src/lib/pendingSends.js';

test('Receipt matching handles input normalization and identical event ids in different sessions', () => {
  const taken = new Set<string>();
  const list: PendingSend[] = ['a', 'b'].map((sessionId) => ({
    id: sessionId,
    sessionId,
    at: 1000,
    text: '반가워요'.normalize('NFD') + '\u200b',
  }));
  const event = { id: 'u1', kind: 'user', at: 2000, text: '반가워요' };
  const first = settleSends(list, 'a', [event], taken, 3000);
  assert.deepEqual(
    first.map((p) => p.id),
    ['b'],
  );
  assert.deepEqual(settleSends(first, 'b', [event], taken, 3000), []);
});

const peers = () => {
  const s = demoSnapshot().sessions[0];
  const git = {
    ...s,
    id: 'git',
    workspace: {
      key: 'git:/repo/.git',
      name: 'repo',
      root: '/repo',
      worktree: '/repo',
      evidence: 'git-common-dir' as const,
      git: { branch: 'main', commit: 'abc', state: 'branch' as const, observedAt: 1 },
    },
  };
  const fallback = {
    ...s,
    id: 'fallback',
    workspace: {
      key: 'path:/repo',
      name: 'repo',
      root: '/repo',
      worktree: '/repo',
      evidence: 'record-path' as const,
    },
  };
  return { git, fallback };
};

test('The exact same worktree recovers its repository identity without borrowing HEAD or changing source records', () => {
  const { git, fallback } = peers();
  const [g, f] = recoverWorkspaces([git, fallback]);
  assert.equal(projectKey(f), projectKey(g));
  assert.equal(f.workspace!.git, undefined);
  assert.equal(fallback.workspace.evidence, 'record-path');
  assert.equal(fallback.workspace.key, 'path:/repo');
});

test('Same names, prefixes, unrelated clones, ambiguous evidence and explicit areas never merge by inference', () => {
  const { git, fallback } = peers();
  for (const root of ['/other/repo', '/repo/sub', '/repo-copy']) {
    const candidate = {
      ...fallback,
      workspace: { ...fallback.workspace, root, worktree: root, key: `path:${root}` },
    };
    assert.equal(recoverWorkspaces([git, candidate])[1], candidate);
  }
  const ambiguous = {
    ...git,
    id: 'ambiguous',
    workspace: { ...git.workspace, key: 'git:/different/.git' },
  };
  assert.equal(recoverWorkspaces([git, ambiguous, fallback])[2], fallback);
  const custom = {
    ...fallback,
    area: { key: 'area:my room', name: 'my room', ruleId: 'own', match: 'session' as const },
  };
  assert.equal(projectKey(recoverWorkspaces([git, custom])[1]), 'area:my room');
});

test('Snapshot and detail group a path-only colleague with its visible Git peer; stored rows and explicit rules stay intact', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-workspace-recovery-'));
  const store = new OfficeStore(path.join(temp, 'office.sqlite'));
  try {
    const { git, fallback } = peers();
    store.upsert([git, fallback], git.provider);
    assert.equal(new Set(store.list().map(projectKey)).size, 1);
    assert.equal(projectKey(store.get(fallback.id)), projectKey(store.get(git.id)));
    assert.equal(projectKey(store.officeRow(fallback.id)!), projectKey(store.get(git.id)));
    assert.equal(
      store.storedRecords(git.provider).find((s) => s.id === fallback.id)!.workspace!.evidence,
      'record-path',
    );
    store.preferences({
      zoneRules: [{ id: 'custom', name: 'my room', match: 'session', value: fallback.id }],
    });
    assert.equal(projectKey(store.get(fallback.id)), 'area:my room');
    assert.equal(new Set(store.list().map(projectKey)).size, 2);
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});
