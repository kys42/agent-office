import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateSeats, officeZone, parseArtifact } from '../src/shared/office.js';
import { parseRecords, deriveState } from '../server/adapters/normalize.js';
import { OfficeStore } from '../server/store.js';
import { codexMetadata } from '../server/adapters/codex.js';
import { claudeMetadata } from '../server/adapters/claude.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const now = Date.now();
function session(id: string, project = 'one', age = 0) {
  return parseRecords(
    [
      {
        type: 'session_meta',
        timestamp: new Date(now - age).toISOString(),
        payload: { id, cwd: '/tmp/' + project, git: { branch: 'main' } },
      },
      {
        type: 'event_msg',
        timestamp: new Date(now - age).toISOString(),
        payload: { type: 'task_complete' },
      },
    ],
    { provider: 'codex', sourcePath: '/tmp/' + id + '.jsonl', mtime: now - age, now },
  );
}
test('Seats persist through status, activity ordering and new same-project arrivals', () => {
  const a = session('a'),
    b = session('b', 'two'),
    c = session('c');
  const first = allocateSeats([a, b, c], {});
  assert.deepEqual(Object.values(first).sort(), [0, 1, 2]);
  const next = allocateSeats(
    [{ ...b, updatedAt: now + 100, status: 'work' }, { ...a, status: 'idle' }, c, session('d')],
    first,
  );
  for (const s of [a, b, c]) assert.equal(next[s.id], first[s.id]);
  assert.equal(new Set(Object.values(next)).size, 4);
});
test('Lifecycle moves after hours and days; pinning and explicit return keep a desk', () => {
  const p = { standbyHours: 4, archiveDays: 7 };
  assert.equal(officeZone(session('a', 'one', 3 * 3600_000), p, now), 'office');
  assert.equal(officeZone(session('a', 'one', 5 * 3600_000), p, now), 'waiting');
  assert.equal(officeZone(session('a', 'one', 8 * 86400_000), p, now), 'archive');
  assert.equal(
    officeZone({ ...session('a', 'one', 8 * 86400_000), pinned: true }, p, now),
    'office',
  );
  assert.equal(
    officeZone({ ...session('a', 'one', 8 * 86400_000), returnedAt: now }, p, now),
    'office',
  );
  assert.equal(officeZone({ ...session('a'), archived: true, pinned: true }, p, now), 'archive');
  assert.equal(deriveState('work', now - 20 * 60_000, now).status, 'idle');
});
test('Seat persistence and frequency survive restart without altering source recency', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-seats-'));
  let store = new OfficeStore(dir);
  try {
    const a = session('a'),
      b = session('b', 'other');
    store.upsert([a, b], 'codex');
    store.assignSeats();
    const seats = store.list().map((s) => [s.id, s.officeSeat]);
    store.visit(a.id);
    store.visit(a.id);
    assert.equal(store.get(a.id).openCount, 1);
    assert.equal(store.get(a.id).updatedAt, a.updatedAt);
    store.close();
    store = new OfficeStore(dir);
    store.assignSeats();
    assert.deepEqual(
      store.list().map((s) => [s.id, s.officeSeat]),
      seats,
    );
    assert.equal(store.get(a.id).openCount, 1);
    store.patch(a.id, { archived: true });
    store.assignSeats();
    assert.equal(store.list().find((x) => x.id === a.id)?.officeSeat, undefined);
    store.visit(a.id, true);
    store.assignSeats();
    assert.equal(store.get(a.id).zone, 'office');
    assert.equal(
      store.list().find((x) => x.id === b.id)?.officeSeat,
      seats.find((x) => x[0] === b.id)?.[1],
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('Changing the standby preference re-evaluates original observed state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-policy-'));
  const store = new OfficeStore(dir);
  try {
    store.upsert([session('a', 'one', 5 * 3600_000)], 'codex');
    assert.equal(store.get('codex:a').zone, 'waiting');
    store.preferences({ standbyHours: 8 });
    assert.equal(store.get('codex:a').zone, 'office');
    assert.equal(store.get('codex:a').status, 'idle');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('Codex native name takes precedence over index and first-prompt title', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-name-'));
  try {
    await writeFile(
      path.join(dir, 'session_index.jsonl'),
      JSON.stringify({ id: 'one', thread_name: 'Index title' }) + '\n',
    );
    const db = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT,title TEXT,name TEXT,updated_at INTEGER)');
    db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(
      'one',
      'First prompt',
      '에이전트 사무실',
      1,
    );
    db.close();
    assert.equal((await codexMetadata(dir)).get('one')?.title, '에이전트 사무실');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('Claude named sessions resolve from custom-title and optional index', async () => {
  const s = parseRecords(
    [
      { type: 'user', sessionId: 'one', message: { role: 'user', content: 'First prompt' } },
      { type: 'custom-title', sessionId: 'one', customTitle: '서비스 대화' },
    ],
    { provider: 'claude', sourcePath: '/tmp/one.jsonl', mtime: now, now },
  );
  assert.equal(s.title, '서비스 대화');
  assert.equal(s.nativeTitle, true);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-claude-name-'));
  try {
    await mkdir(path.join(dir, 'project'));
    await writeFile(
      path.join(dir, 'project', 'sessions-index.json'),
      JSON.stringify({
        entries: [{ sessionId: 'one', customTitle: 'Custom name', summary: 'Summary' }],
      }),
    );
    assert.equal((await claudeMetadata(dir)).get('one')?.title, 'Custom name');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('Artifact targets accept only GitHub PR/issue URLs', () => {
  assert.deepEqual(parseArtifact('https://github.com/org/repo/pull/42#discussion'), {
    url: 'https://github.com/org/repo/pull/42',
    repo: 'org/repo',
    kind: 'pull',
    number: 42,
  });
  for (const url of [
    'javascript:alert(1)',
    'https://github.com.evil.test/org/repo/pull/1',
    'https://evil.test/org/repo/issues/1',
    'https://github.com/org/repo/actions',
    'https://github.com@evil.test/org/repo/issues/1',
  ])
    assert.equal(parseArtifact(url), null);
});
