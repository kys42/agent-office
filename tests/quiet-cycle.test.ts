import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficeService } from '../server/service.js';
import { OfficeStore } from '../server/store.js';
import { workspaceSignature } from '../server/workspaces.js';
import { parseRecords } from '../server/adapters/normalize.js';
import { SnapshotDelivery, type Viewer } from '../desktop/delivery.js';
import { CANONICAL } from '../src/shared/canonical.js';
import type { Snapshot, WorkspaceIdentity } from '../src/shared/types.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });

/** A Claude session working in a real Git repository, under a temporary home. */
async function office() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-quiet-'));
  const repo = path.join(temp, 'repo');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const project = path.join(temp, 'claude', 'projects', 'repo');
  await mkdir(project, { recursive: true });
  const id = 'aaaa1111-0000-0000-0000-000000000001';
  const at = Date.now() - 60_000;
  const file = path.join(project, `${id}.jsonl`);
  await writeFile(
    file,
    [
      {
        type: 'user',
        sessionId: id,
        timestamp: new Date(at).toISOString(),
        cwd: repo,
        message: { role: 'user', content: '작업해 줘' },
      },
      {
        type: 'assistant',
        sessionId: id,
        timestamp: new Date(at + 1000).toISOString(),
        message: {
          id: 'm-1',
          role: 'assistant',
          content: [{ type: 'text', text: '끝났어요' }],
          stop_reason: 'end_turn',
        },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  await utimes(file, at / 1000, at / 1000);
  const service = new OfficeService(path.join(temp, 'data'), temp);
  service.roots.claude = path.join(temp, 'claude', 'projects');
  service.store.preferences({ enabledProviders: ['claude'] });
  const changes = () =>
    (service.store.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  return { temp, repo, service, changes };
}

test('Only what a workspace means goes into the revision, not when it was checked', () => {
  const at = (observedAt: number, branch = 'main'): WorkspaceIdentity => ({
    key: 'git:/r/.git',
    name: 'r',
    root: '/r',
    worktree: '/r',
    evidence: 'git-common-dir',
    git: { branch, commit: 'abc', state: 'branch', observedAt },
  });
  assert.equal(workspaceSignature(at(1)), workspaceSignature(at(2)));
  assert.notEqual(workspaceSignature(at(1)), workspaceSignature(at(1, 'feature')));
  assert.equal(workspaceSignature(undefined), '');
});

test('Re-checking Git writes nothing when nothing changed; a new branch still shows', async (t) => {
  const { temp, repo, service, changes } = await office();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const first = (await service.refresh()) as Snapshot;
    const revision = first.sessions[0].revision;
    for (let i = 0; i < 3; i++) {
      // Past the 15s Git cache: the workspace is checked again and gets a new `observedAt`.
      t.mock.timers.tick(16_000);
      const before = changes();
      const again = (await service.refresh()) as Snapshot;
      assert.equal(again.sessions[0].revision, revision);
      assert.equal(changes() - before, 0, 'a quiet cycle writes nothing');
    }
    git(repo, 'checkout', '-q', '-b', 'feature');
    t.mock.timers.tick(16_000);
    const moved = (await service.refresh()) as Snapshot;
    assert.notEqual(moved.sessions[0].revision, revision);
    assert.equal(moved.sessions[0].workspace?.git?.branch, 'feature');
  } finally {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  }
});

test('The office goes out only when it changed; check times alone once a minute', async (t) => {
  const { temp, service } = await office();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const sent: Snapshot[] = [];
  service.on('snapshot', (s: Snapshot) => sent.push(s));
  try {
    const first = (await service.refresh()) as Snapshot;
    assert.equal(sent.length, 1);
    t.mock.timers.tick(5_000);
    const quiet = (await service.refresh()) as Snapshot;
    assert.equal(sent.length, 1, 'nothing changed, nothing sent');
    assert.equal(quiet.version, first.version);
    // A poller holding the latest version gets a short answer; another run's version does not.
    assert.deepEqual(await service.call('snapshot', [first.epoch, first.version]), {
      unchanged: true,
      epoch: first.epoch,
      version: first.version,
    });
    assert.equal(
      ((await service.call('snapshot', ['other-run', first.version])) as Snapshot).sessions.length,
      1,
    );
    // A change by the person goes out at once.
    const pinned = (await service.call('pin', [[first.sessions[0].id], true])) as Snapshot;
    assert.equal(sent.length, 2);
    assert.equal(pinned.version, first.version + 1);
    assert.equal(pinned.sessions[0].pinned, true);
    // Only the check time moved: it goes out after a minute.
    t.mock.timers.tick(61_000);
    await service.refresh();
    assert.equal(sent.length, 3);
    assert.ok(sent[2].lastSync! > sent[1].lastSync!);
  } finally {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  }
});

test('The office view is what seats, notices and list give in turn, from one read', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-view-'));
  const store = new OfficeStore(dir);
  try {
    const sessions = ['a', 'b', 'c'].map((id) =>
      parseRecords(
        [
          { type: 'session_meta', payload: { id, cwd: '/test/p' } },
          {
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: id }] },
          },
        ],
        { provider: 'codex', sourcePath: `/test/${id}.jsonl`, mtime: Date.now() },
      ),
    );
    store.upsert(sessions, 'codex');
    const view = store.officeView(CANONICAL);
    store.assignSeats();
    assert.deepEqual(view.notices, store.noticeList(CANONICAL));
    assert.deepEqual(view.sessions, store.list(false, CANONICAL));
    assert.ok(view.sessions.some((s) => s.officeSeat !== undefined));
  } finally {
    store.close();
    await rm(dir, { recursive: true });
  }
});

test('Parsed rows are reused until another connection writes the same data', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-rows-'));
  const ours = new OfficeStore(dir);
  const theirs = new OfficeStore(dir);
  const record = (title: string) =>
    parseRecords(
      [
        { type: 'session_meta', payload: { id: 'one', cwd: '/test/p' } },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: title }],
          },
        },
      ],
      { provider: 'codex', sourcePath: '/test/one.jsonl', mtime: Date.now() },
    );
  try {
    ours.upsert([record('첫 요청')], 'codex');
    assert.match(ours.list(false, CANONICAL)[0].title, /첫 요청/);
    // A dev server or second app on the same data dir rewrites the record.
    theirs.upsert([{ ...record('다른 요청'), revision: 'changed' }], 'codex');
    assert.match(ours.list(false, CANONICAL)[0].title, /다른 요청/);
    // Our own rewrite is picked up too.
    ours.upsert([{ ...record('세 번째'), revision: 'third' }], 'codex');
    assert.match(ours.list(false, CANONICAL)[0].title, /세 번째/);
    ours.upsert([], 'codex');
    assert.equal(ours.list(false, CANONICAL).length, 0);
  } finally {
    ours.close();
    theirs.close();
    await rm(dir, { recursive: true });
  }
});

test('Hidden windows get nothing; on showing they get the latest once', () => {
  const office = (version: number) => ({ version, epoch: 'run' }) as Snapshot;
  const got: Record<number, number[]> = { 1: [], 2: [] };
  let hidden = true;
  const viewers: Viewer[] = [
    { id: 1, shown: () => true, send: (s) => got[1].push(s.version) },
    { id: 2, shown: () => !hidden, send: (s) => got[2].push(s.version) },
  ];
  const delivery = new SnapshotDelivery();
  delivery.publish(office(1), viewers);
  delivery.publish(office(2), viewers);
  delivery.publish(office(3), viewers);
  assert.deepEqual(got, { 1: [1, 2, 3], 2: [] });
  hidden = false;
  delivery.reveal(viewers[1]);
  delivery.reveal(viewers[1]);
  assert.deepEqual(got[2], [3], 'only the latest, only once');
  delivery.publish(office(4), viewers);
  assert.deepEqual(got[2], [3, 4]);
});
