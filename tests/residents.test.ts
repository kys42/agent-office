import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { demoSnapshot } from '../src/lib/demo.js';
import { officeResidents } from '../src/shared/residents.js';
import { allocateSeats, parentSession, seatKey } from '../src/shared/office.js';
import {
  applyNoticeReceipt,
  bubbleNotice,
  noticeCandidates,
  noticeExposure,
  unreadNoticeCount,
} from '../src/shared/notices.js';
import { parseRecords } from '../server/adapters/normalize.js';
import { mergeSessions } from '../server/adapters/merge.js';
import { readOpenClawDatabases } from '../server/adapters/openclaw.js';
import { OfficeStore } from '../server/store.js';
import type { Session, OfficeNotice } from '../src/shared/types.js';
const now = Date.now();
const make = (id: string, patch: Partial<Session> = {}): Session => ({
  ...demoSnapshot().sessions[0],
  id,
  nativeId: id,
  status: 'idle',
  updatedAt: now,
  startedAt: now - 5000,
  events: [],
  activity: undefined,
  runtime: undefined,
  taskStartedAt: undefined,
  archived: false,
  pinned: false,
  actor: undefined,
  relation: { kind: 'root', parentNativeId: null, source: 'fixture' },
  zone: 'office',
  ...patch,
});
const persona = (id: string, name = 'aki', patch: Partial<Session> = {}) =>
  make(id, {
    provider: 'openclaw',
    agentName: name,
    actor: { id: `openclaw:${name}`, name, source: 'fixture' },
    ...patch,
  });
const notice = (id: string, at: number, kind: OfficeNotice['kind'] = 'reply'): OfficeNotice => ({
  id,
  sessionId: 'a',
  eventId: id,
  at,
  kind,
  text: id,
  version: id,
  phase: kind === 'reply' ? 'final' : undefined,
  receivedAt: at,
  bootstrap: false,
  seenAt: null,
  viewedAt: null,
  dismissedAt: null,
  resolvedAt: null,
});
test('Current progress replaces old final; closing or expiring the current bubble never reveals an older one', () => {
  const old = notice('old-final', now - 1000),
    current = notice('new-progress', now, 'progress');
  assert.equal(bubbleNotice([old, current], 3, now)?.id, current.id);
  const closed = applyNoticeReceipt([old, current], [current], 'dismiss', now);
  assert.equal(bubbleNotice(closed, 3, now), undefined);
  assert.equal(unreadNoticeCount(closed), 1);
  assert.equal(bubbleNotice([...closed, notice('next', now + 1)], 3, now + 1)?.id, 'next');
  assert.equal(bubbleNotice([old, current], 3, now + 4 * 3600_000), undefined);
  assert.equal(
    bubbleNotice([old, notice('question', now, 'attention')], 3, now + 4 * 3600_000)?.id,
    'question',
  );
});
test('Opening is version-specific and independent of read and dismissal', () => {
  const n = notice('a', now);
  assert.equal(noticeExposure(n), '처음 도착');
  const viewed = applyNoticeReceipt([n], [n], 'view', now + 1)[0];
  assert.equal(noticeExposure(viewed), '열어봄');
  assert.equal(viewed.seenAt, null);
  assert.equal(viewed.dismissedAt, null);
  assert.equal(applyNoticeReceipt([viewed], [viewed], 'view', now + 2)[0].viewedAt, now + 1);
  assert.equal(noticeExposure(applyNoticeReceipt([viewed], [viewed], 'read', now + 3)[0]), '읽음');
  assert.equal(applyNoticeReceipt([n], [{ ...n, version: 'wrong' }], 'view')[0].viewedAt, null);
});
test('Persona projection keeps one resident per namespace and raw run identities intact', () => {
  const a = persona('manual'),
    cron = persona('cron', 'aki', {
      status: 'work',
      origin: { kind: 'scheduled', source: 'fixture' },
    });
  const other = persona('same-native', 'other');
  const raw = [a, cron, other];
  const result = officeResidents(raw, now).sessions;
  assert.equal(result.length, 2);
  const aki = result.find((s) => s.actor?.name === 'aki')!;
  assert.equal(aki.id, 'cron');
  assert.deepEqual(aki.resident?.sessionIds, ['cron', 'manual']);
  assert.equal(aki.resident?.activeCount, 1);
  assert.equal(aki.resident?.backgroundCount, 1);
  assert.equal(raw.length, 3);
  assert.equal(raw[0].resident, undefined);
  const seats = allocateSeats(result, {});
  const after = officeResidents(
    [{ ...cron, status: 'done' }, { ...a, status: 'work', updatedAt: now + 1 }, other],
    now + 1,
  ).sessions;
  assert.equal(after.find((s) => s.actor?.name === 'aki')?.id, 'manual');
  assert.equal(allocateSeats(after, seats)[seatKey(a)], seats[seatKey(aki)]);
  assert.equal(officeResidents([{ ...cron, status: 'done' }], now).sessions[0].zone, 'waiting');
});
test('Previous-task helpers and internal runs fold away; working helpers, forks and attention stay visible', () => {
  const root = make('root', { taskStartedAt: now }),
    child = make('child', {
      relation: { kind: 'subagent', parentNativeId: 'root', source: 'fixture' },
    });
  const guardian = make('guardian', {
    status: 'work',
    origin: { kind: 'internal', source: 'fixture' },
  });
  const fork = make('fork', { relation: { ...child.relation!, kind: 'fork' } });
  assert.deepEqual(
    officeResidents([root, child, guardian, fork], now).hidden.map((s) => s.id),
    ['child', 'guardian'],
  );
  const active = officeResidents(
    [root, { ...child, status: 'work' }, { ...guardian, status: 'call' }, fork],
    now,
  );
  assert.equal(active.hidden.length, 0);
  assert.equal(active.sessions.find((s) => s.id === 'child')?.attachedTo, 'root');
  assert.equal(
    officeResidents([{ ...child, status: 'work', updatedAt: now - 121_000 }], now).hidden.length,
    0,
  );
  assert.equal(officeResidents([{ ...guardian, pinned: true }], now).hidden.length, 0);
});
test('Native internal metadata distinguishes machinery from a user or ordinary helper named Guardian', () => {
  const parse = (payload: object) =>
    parseRecords([{ type: 'session_meta', payload: { id: 'a', ...payload } }], {
      provider: 'codex',
      sourcePath: '/tmp/a.jsonl',
      mtime: now,
    });
  assert.equal(parse({ source: { internal: 'guardian' } }).origin?.kind, 'internal');
  assert.equal(parse({ source: { subagent: 'review' } }).origin?.kind, 'internal');
  const ordinary = parse({
    source: { subagent: { thread_spawn: { parent_thread_id: 'p', agent_role: 'guardian' } } },
  });
  assert.equal(ordinary.origin?.kind, 'unknown');
  assert.equal(ordinary.relation?.kind, 'subagent');
  assert.equal(parse({ source: 'vscode', title: 'Guardian review' }).origin?.kind, 'unknown');
  assert.equal(
    parse({ thread_source: 'user', source: { internal: 'guardian' } }).origin?.kind,
    'unknown',
  );
});
test('Cross-persona parent links require a unique exact native session key and never share a seat', () => {
  const parent = persona('p', 'main', { sessionKey: 'agent:main:telegram:1' });
  const child = persona('c', 'aki', {
    relation: {
      kind: 'child',
      parentNativeId: null,
      parentSessionKey: parent.sessionKey,
      source: 'fixture',
    },
  });
  assert.equal(parentSession(child, [parent, child])?.id, parent.id);
  const projected = officeResidents([parent, child], now).sessions;
  assert.ok(projected.every((s) => !s.attachedTo));
  assert.equal(new Set(Object.values(allocateSeats(projected, {}))).size, 2);
  assert.equal(parentSession(child, [parent, { ...parent, id: 'ambiguous' }, child]), undefined);
});
test('OpenClaw SQLite optional origin metadata survives a newer transcript fragment', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-personas-'));
  try {
    const folder = path.join(dir, 'aki', 'agent');
    await mkdir(folder, { recursive: true });
    const db = new DatabaseSync(path.join(folder, 'openclaw-agent.sqlite'));
    db.exec(
      'CREATE TABLE session_nodes(session_key TEXT,current_session_id TEXT,entry_json TEXT,updated_at INTEGER,status TEXT,label TEXT,display_name TEXT,parent_session_key TEXT,archived_at INTEGER,created_via TEXT,created_actor_type TEXT); CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT)',
    );
    db.prepare('INSERT INTO session_nodes VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
      'agent:aki:cron:1',
      'cron1',
      '{}',
      now,
      'active',
      'Routine',
      null,
      'agent:main:telegram:1',
      null,
      'cron',
      'system',
    );
    db.close();
    const result = await readOpenClawDatabases(dir, 10, new Map());
    assert.equal(result.errors, 0);
    const s = result.sessions[0];
    assert.equal(s.actor?.id, 'openclaw:aki');
    assert.equal(s.origin?.kind, 'scheduled');
    assert.equal(s.relation?.parentSessionKey, 'agent:main:telegram:1');
    const fragment = {
      ...s,
      updatedAt: now + 1,
      origin: { kind: 'unknown' as const, source: 'JSONL' },
      sessionKey: undefined,
      relation: { kind: 'root' as const, parentNativeId: null, source: 'JSONL' },
    };
    const merged = mergeSessions([s, fragment])[0];
    assert.equal(merged.origin?.kind, 'scheduled');
    assert.equal(merged.sessionKey, s.sessionKey);
    assert.equal(merged.relation?.parentSessionKey, s.relation?.parentSessionKey);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('Persisted views and persona seats survive restart; new content resets exposure and helper finals stay out of inbox', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-receipts-'));
  let store = new OfficeStore(dir);
  try {
    const run = persona('manual', 'aki', {
      events: [
        {
          id: 'stream',
          at: now,
          text: 'Progress',
          kind: 'assistant',
          phase: 'commentary',
          sourceRef: 'fixture',
        },
      ],
    });
    store.upsert([run], 'openclaw');
    store.assignSeats();
    const first = store.noticeList()[0];
    store.noticeReceipt([first], 'view');
    const seat = store.list()[0].officeSeat;
    store.close();
    store = new OfficeStore(dir);
    assert.ok(store.noticeList()[0].viewedAt);
    assert.equal(store.noticeList()[0].seenAt, null);
    assert.equal(store.list()[0].officeSeat, seat);
    store.upsert(
      [
        {
          ...run,
          events: [{ ...run.events[0], text: 'New result', phase: 'final' }],
          revision: 'final',
        },
      ],
      'openclaw',
    );
    assert.equal(store.noticeList()[0].viewedAt, null);
    store.noticeReceipt([first], 'view');
    assert.equal(store.noticeList()[0].viewedAt, null);
    const internal = make('helper', {
      origin: { kind: 'internal', source: 'fixture' },
      events: [{ ...run.events[0], phase: 'final' }],
    });
    store.upsert([internal], internal.provider);
    const helperNotice = store.noticeList().find((n) => n.sessionId === internal.id)!;
    assert.equal(helperNotice.background, true);
    assert.equal(unreadNoticeCount([helperNotice]), 0);
    assert.equal(unreadNoticeCount([{ ...helperNotice, kind: 'attention' }]), 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Completed helpers remain through silence until a parent request, not a tool or late result', () => {
  const parent = make('p', { taskStartedAt: now - 10_000 });
  const child = make('c', {
    taskStartedAt: now - 5_000,
    status: 'done',
    relation: { kind: 'subagent', parentNativeId: 'p', source: 'fixture' },
  });
  const retained = officeResidents([parent, child], now);
  assert.equal(retained.hidden.length, 0);
  assert.equal(retained.sessions[1].attachedTo, 'p');
  const tools = {
    ...parent,
    updatedAt: now + 1,
    events: [
      { id: 'exec', at: now + 1, kind: 'tool' as const, text: 'exec', sourceRef: 'fixture' },
    ],
  };
  assert.equal(officeResidents([tools, child], now + 1).hidden.length, 0);
  const next = { ...parent, taskStartedAt: now + 2 };
  assert.equal(officeResidents([next, child], now + 3).hidden[0].id, 'c');
  assert.equal(
    officeResidents([next, { ...child, updatedAt: now + 4 }], now + 5).hidden[0].id,
    'c',
  );
  assert.equal(
    officeResidents([next, { ...child, updatedAt: now + 4, status: 'work' }], now + 5).hidden
      .length,
    0,
  );
  assert.equal(officeResidents([next, { ...child, status: 'call' }], now + 5).hidden.length, 0);
  assert.equal(
    officeResidents([next, { ...child, taskStartedAt: now + 4 }], now + 5).hidden.length,
    0,
  );
  assert.equal(
    officeResidents([parent, { ...child, zone: 'waiting' }], now).sessions[1].attachedTo,
    'p',
  );
  assert.equal(officeResidents([{ ...parent, zone: 'waiting' }, child], now).hidden[0].id, 'c');
});
test('Nested helpers retire on their main task boundary; uncollected parents retain recent results conservatively', () => {
  const main = make('main', { taskStartedAt: now - 9000 });
  const child = make('child', {
    taskStartedAt: now - 7000,
    relation: { kind: 'subagent', parentNativeId: 'main', source: 'fixture' },
  });
  const nested = make('nested', {
    taskStartedAt: now - 6000,
    relation: { kind: 'subagent', parentNativeId: 'child', source: 'fixture' },
  });
  assert.equal(officeResidents([main, child, nested], now).hidden.length, 0);
  assert.equal(
    officeResidents([{ ...main, taskStartedAt: now }, child, nested], now).hidden.length,
    2,
  );
  assert.equal(officeResidents([nested], now).hidden.length, 0);
  assert.equal(officeResidents([{ ...nested, zone: 'waiting' }], now).hidden.length, 1);
});
