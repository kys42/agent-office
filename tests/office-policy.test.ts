import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseRecords, cleanPrompt, cleanTitle } from '../server/adapters/normalize.js';
import { mergeSessions } from '../server/adapters/merge.js';
import { readOpenClawDatabases } from '../server/adapters/openclaw.js';
import { OfficeStore } from '../server/store.js';
import { attachSessions, allocateSeats, benchKey, projectKey } from '../src/shared/office.js';
import { bubbleNotice, noticeCandidates, applyNoticeReceipt } from '../src/shared/notices.js';
import { presentSession } from '../src/shared/presentation.js';
import { freshRequest } from '../src/shared/speech.js';
import type { Session, Provider } from '../src/shared/types.js';
const now = Date.now();
const root = '01a102c7-f8f8-71a0-82a0-aaaa4defdf64';
const fragment = '01a1070e-59e9-7fd1-9d22-470cd3ff062a';
const child = '01a1070f-8147-71f3-9e64-7cba1a70c5b3';
const rec = (type: string, payload: object, at = now) => ({
  type,
  payload,
  timestamp: new Date(at).toISOString(),
});
const opts = { provider: 'codex' as const, sourcePath: '/tmp/rollout.jsonl', mtime: now, now };
const make = (id = root, provider: Provider = 'codex'): Session => ({
  ...parseRecords(
    [
      rec('session_meta', { id, cwd: '/tmp/team', git: { branch: 'main' } }),
      rec('event_msg', { type: 'user_message', message: '사무실을 개선해 주세요' }, now - 1000),
      rec('response_item', {
        type: 'message',
        id: 'progress',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: '연결 구조를 확인하고 있어요.' }],
      }),
    ],
    { ...opts, provider, nativeId: id },
  ),
  zone: 'office',
});

test('Continuation files are one native conversation, while a real subagent owns a separate ID', () => {
  const a = parseRecords(
    [
      rec('session_meta', { id: root, history_base: { thread_id: root }, source: 'vscode' }),
      rec('event_msg', { type: 'user_message', message: '다음 작업' }),
    ],
    { ...opts, sourcePath: `/tmp/rollout-${fragment}.jsonl` },
  );
  assert.equal(a.id, `codex:${root}`);
  assert.equal(a.relation?.kind, 'root');
  const b = parseRecords(
    [
      rec('session_meta', {
        id: child,
        thread_source: 'subagent',
        parent_thread_id: root,
        agent_path: '/root/helper',
      }),
      rec('event_msg', { type: 'user_message', message: '상속된 부모 요청' }, now - 10_000),
      rec('response_item', { type: 'function_call', name: 'read', call_id: 'own' }, now + 1),
    ],
    { ...opts, sourcePath: `/tmp/rollout-${child}.jsonl` },
  );
  assert.equal(b.id, `codex:${child}`);
  assert.equal(b.relation?.kind, 'subagent');
  assert.equal(b.parentId, root);
  assert.equal(
    b.events.some((e) => e.text.includes('상속된')),
    false,
  );
  const merged = mergeSessions([make(), a, b]);
  assert.equal(merged.length, 2);
  assert.equal(
    merged.find((s) => s.nativeId === root)?.events.some((e) => e.text === '다음 작업'),
    true,
  );
});
test('Ambient browser wrappers do not become titles, requests, or activity', () => {
  const wrapper =
    '<in-app-browser-context source="ambient-ui-state">This automatically supplied context</in-app-browser-context>';
  assert.equal(cleanPrompt(wrapper), '');
  assert.equal(cleanPrompt(wrapper + '\n## My request:\n실제 요청'), '실제 요청');
  assert.equal(cleanTitle('<in-app-browser-context source="ambient-ui-state"> This'), '');
  const s = parseRecords(
    [
      rec('session_meta', { id: root }),
      rec('event_msg', { type: 'user_message', message: wrapper }),
    ],
    opts,
  );
  assert.equal(s.events.length, 0);
  assert.equal(s.status, 'idle');
  assert.equal(noticeCandidates(s).length, 0);
});
test('Claude sidechain path creates an independent subagent, never a parentUuid session', () => {
  const rows = [
    {
      type: 'user',
      sessionId: root,
      agentId: 'a17',
      parentUuid: 'message-uuid',
      isSidechain: true,
      cwd: '/tmp/team',
      gitBranch: 'main',
      timestamp: new Date(now).toISOString(),
      message: { role: 'user', content: '확인을 맡아 주세요' },
    },
  ];
  const s = parseRecords(rows, {
    ...opts,
    provider: 'claude',
    sourcePath: `/tmp/projects/repo/${root}/subagents/agent-a17.jsonl`,
  });
  assert.equal(s.nativeId, `subagent:${root}:a17`);
  assert.equal(s.parentId, root);
  assert.equal(s.relation?.kind, 'subagent');
  const normal = parseRecords(
    rows.map((r) => ({ ...r, isSidechain: false, agentId: undefined })),
    { ...opts, provider: 'claude' },
  );
  assert.equal(normal.nativeId, root);
  assert.equal(normal.parentId, null);
});
test('Confirmed branch and worktree define benches across providers; ordering tokens stay fixed', () => {
  const a = make('a', 'claude'),
    b = make('b', 'codex'),
    c = { ...make('c', 'openclaw'), branch: 'other' };
  assert.equal(benchKey(a), benchKey(b));
  const seats = allocateSeats([a, b, c], {});
  assert.notEqual(benchKey(a), benchKey(c));
  assert.deepEqual(Object.values(seats).sort(), [0, 1, 2]);
  assert.deepEqual(
    allocateSeats([c, { ...b, updatedAt: now + 100, branch: 'changed' }, a], seats),
    Object.fromEntries([c, b, a].map((s) => [s.id, seats[s.id]])),
  );
  assert.notEqual(benchKey({ ...a, branch: null }), benchKey({ ...b, branch: null }));
  assert.notEqual(benchKey(a), benchKey({ ...b, cwd: '/tmp/other-worktree' }));
  assert.notEqual(projectKey(a), projectKey({ ...a, cwd: '/unrelated/team' }));
});
test('Subagents use their parent seat; forks, missing parents, cycles do not consume it', () => {
  const a = { ...make('a'), officeSeat: 4 };
  const b = {
    ...make('b'),
    parentId: 'a',
    relation: { kind: 'subagent' as const, parentNativeId: 'a', source: 'fixture' },
  };
  const linked = attachSessions([a, b]);
  assert.equal(linked[1].attachedTo, a.id);
  assert.equal(linked[1].officeSeat, 4);
  assert.deepEqual(allocateSeats([a, b], { [a.id]: 4 }), { [a.id]: 4 });
  assert.equal(attachSessions([b])[0].attachedTo, undefined);
  assert.equal(attachSessions([{ ...a, zone: 'archive' }, b])[1].attachedTo, undefined);
  assert.equal(
    attachSessions([a, { ...b, relation: { ...b.relation, kind: 'fork' } }])[1].attachedTo,
    undefined,
  );
  assert.ok(
    attachSessions([{ ...a, relation: { ...b.relation, parentNativeId: 'b' } }, b]).every(
      (s) => !s.attachedTo,
    ),
  );
});
test('Same common observation has the same runtime and presentation on all three providers', () => {
  const s = make();
  const poses = (['claude', 'codex', 'openclaw'] as Provider[]).map((provider) =>
    presentSession({ ...s, provider, id: 'same-semantic-session' }, now),
  );
  assert.deepEqual(poses[0], poses[1]);
  assert.deepEqual(poses[1], poses[2]);
  const stale = presentSession({ ...s, status: 'idle', updatedAt: now - 5 * 60_000 }, now);
  assert.equal(stale.stale, true);
  assert.equal(stale.runtime.phase, s.runtime?.phase);
  assert.equal(stale.decorative, true);
});
test('Read is version-specific; dismiss does not mean read; expired unread remains in inbox', () => {
  const candidates = noticeCandidates(make(), now);
  const n = candidates.at(-1)!;
  assert.equal(candidates.length, 2);
  assert.equal(applyNoticeReceipt([n], [{ id: n.id, version: 'older' }], 'read')[0].seenAt, null);
  const read = applyNoticeReceipt([n], [n], 'read', now)[0];
  assert.ok(read.seenAt);
  assert.equal(bubbleNotice([read], 3, now)?.id, n.id);
  const dismissed = applyNoticeReceipt([n], [n], 'dismiss', now)[0];
  assert.equal(dismissed.seenAt, null);
  assert.equal(bubbleNotice([dismissed], 3, now), undefined);
  assert.equal(bubbleNotice([n], 3, now + 4 * 3600_000), undefined);
  assert.equal(n.seenAt, null);
  assert.ok(bubbleNotice([{ ...n, kind: 'attention' }], 3, now + 4 * 3600_000));
});
/** The same conversation, as if it had happened `ms` earlier. */
const aged = (s: Session, ms: number): Session => ({
  ...s,
  startedAt: s.startedAt - ms,
  updatedAt: s.updatedAt - ms,
  events: s.events.map((e) => ({ ...e, at: e.at - ms })),
  activity: s.activity && { ...s.activity, at: s.activity.at - ms },
});
test('Notice store bootstraps once, tracks only public changes, and persists receipts through restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-news-'));
  let store = new OfficeStore(dir);
  try {
    // An older conversation found on the first scan is history.
    const s = aged(make(), 10 * 60_000);
    store.upsert([s], 'codex');
    assert.equal(store.noticeList().length, 1);
    assert.equal(store.noticeList()[0].bootstrap, true);
    const first = store.noticeList()[0];
    store.noticeReceipt([first], 'read');
    store.close();
    store = new OfficeStore(dir);
    store.upsert([s], 'codex');
    assert.ok(store.noticeList()[0].seenAt);
    const tool = {
      id: 'tool',
      at: now + 20000,
      kind: 'tool' as const,
      text: 'exec 실행',
      tool: 'exec',
      sourceRef: 'fixture',
    };
    store.upsert(
      [{ ...s, events: [...s.events, tool], updatedAt: tool.at, revision: 'tool' }],
      'codex',
    );
    assert.equal(store.noticeList().length, 1);
    // A streaming update may retain its original time, older than the latest tool timestamp.
    const updated = {
      ...s,
      events: s.events.map((e) =>
        e.id === 'progress' ? { ...e, text: '연결 구조를 확인했고 다음 검증을 진행합니다.' } : e,
      ),
      updatedAt: tool.at,
      revision: 'stream',
    };
    store.upsert([updated], 'codex');
    assert.equal(store.noticeList().length, 1);
    assert.equal(store.noticeList()[0].seenAt, null);
    store.noticeReceipt([first], 'read');
    assert.equal(store.noticeList()[0].seenAt, null);
    const current = store.noticeList()[0];
    store.noticeReceipt([current], 'dismiss');
    assert.equal(store.noticeList()[0].seenAt, null);
    assert.ok(store.noticeList()[0].dismissedAt);
    store.preferences({ excludedProjects: ['team'] });
    assert.equal(store.noticeList().length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('A conversation first seen right after it starts is live: its first request is news and arrives', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-born-'));
  const store = new OfficeStore(dir);
  try {
    store.upsert([make()], 'codex');
    const notices = store.noticeList();
    assert.ok(notices.length >= 2, 'every recent notice is kept, not only the last one');
    assert.ok(notices.every((n) => !n.bootstrap));
    const request = notices.find((n) => n.kind === 'request');
    assert.ok(request);
    assert.equal(freshRequest(notices, Date.now())?.id, request.id, 'the first request plays');
    // A request written long before it was collected never replays as new.
    assert.equal(
      freshRequest([{ ...request, at: Date.now() - 10 * 60_000 }], Date.now()),
      undefined,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('OpenClaw parent_session_key is resolved to the native session ID in its own agent namespace', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-claw-parent-'));
  try {
    const folder = path.join(dir, 'butler', 'agent');
    await mkdir(folder, { recursive: true });
    const db = new DatabaseSync(path.join(folder, 'openclaw-agent.sqlite'));
    db.exec(
      'CREATE TABLE session_nodes(session_key TEXT,current_session_id TEXT,entry_json TEXT,updated_at INTEGER,status TEXT,label TEXT,display_name TEXT,parent_session_key TEXT,archived_at INTEGER); CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT)',
    );
    const put = db.prepare('INSERT INTO session_nodes VALUES(?,?,?,?,?,?,?,?,?)');
    put.run('key-parent', 'native-parent', '{}', now, 'active', 'Parent', null, null, null);
    put.run('key-child', 'native-child', '{}', now, 'active', 'Child', null, 'key-parent', null);
    db.close();
    const result = await readOpenClawDatabases(dir, 10, new Map());
    assert.equal(result.errors, 0);
    const child = result.sessions.find((s) => s.nativeId === 'native-child')!;
    assert.equal(child.parentId, 'native-parent');
    assert.equal(child.relation?.kind, 'child');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Git worktrees share a project identity while keeping different working locations', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const { resolveWorkspace } = await import('../server/workspaces.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-workspace-'));
  try {
    const repo = path.join(dir, 'repo'),
      worktree = path.join(dir, 'branch-worktree');
    await exec('git', ['init', repo]);
    await exec('git', [
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
    ]);
    await exec('git', ['-C', repo, 'worktree', 'add', '-b', 'feature', worktree]);
    const a = await resolveWorkspace(repo, 'a'),
      b = await resolveWorkspace(worktree, 'b');
    assert.equal(a.evidence, 'git-common-dir');
    assert.equal(a.key, b.key);
    assert.equal(a.name, b.name);
    assert.notEqual(a.worktree, b.worktree);
    const unknown = await resolveWorkspace(null, 'unknown');
    assert.equal(unknown.evidence, 'unknown');
    assert.equal(unknown.root, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
