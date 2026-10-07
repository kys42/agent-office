import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseRecords } from '../server/adapters/normalize.js';
import { OfficeStore } from '../server/store.js';
import {
  conversationKind,
  conversationEvents,
  retainedConversation,
} from '../src/shared/conversation.js';
import {
  noticeCandidates,
  unreadNoticeCount,
  isFinalNotice,
  noticeVersion,
} from '../src/shared/notices.js';
import { demoSnapshot } from '../src/lib/demo.js';
import type { OfficeEvent, OfficeNotice, Session } from '../src/shared/types.js';
const now = Date.now();
const event = (
  id: string,
  kind: OfficeEvent['kind'],
  phase?: OfficeEvent['phase'],
): OfficeEvent => ({ id, kind, phase, at: now, text: id, sourceRef: 'fixture' });
const session = (events: OfficeEvent[]): Session => ({
  ...demoSnapshot().sessions[0],
  events,
  activity: undefined,
});

test('Conversation separates requests, progress, explicit finals and unknown responses without phase-blind deduplication', () => {
  const events = [
    event('request', 'user'),
    event('progress', 'assistant', 'commentary'),
    event('final', 'assistant', 'final'),
    event('unknown', 'assistant'),
    event('tool', 'tool'),
  ];
  assert.deepEqual(events.map(conversationKind), [
    'request',
    'progress',
    'reply',
    'message',
    'work',
  ]);
  const repeated = [
    { ...events[1], text: 'same' },
    { ...events[2], text: 'same' },
    { ...events[2], id: 'duplicate', text: 'same', at: now + 100 },
  ];
  assert.equal(conversationEvents(repeated).length, 2);
});
test('All providers map public progress and final evidence into the same categories', () => {
  const codex = parseRecords(
    [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: '진행' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: '결과' }],
        },
      },
    ],
    { provider: 'codex', sourcePath: '/tmp/codex.jsonl', mtime: now },
  );
  assert.deepEqual(codex.events.map(conversationKind), ['progress', 'reply']);
  for (const provider of ['claude', 'openclaw'] as const) {
    const s = parseRecords(
      [
        {
          type: 'message',
          id: 'p',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: '진행' },
              { type: 'tool_use', name: 'Bash', id: 'tool' },
            ],
            stop_reason: 'tool_use',
          },
        },
        {
          type: 'message',
          id: 'f',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '결과' }],
            ...(provider === 'claude' ? { stop_reason: 'end_turn' } : { stopReason: 'stop' }),
          },
        },
        {
          type: 'message',
          id: 'u',
          message: { role: 'assistant', content: [{ type: 'text', text: '구분 없는 메시지' }] },
        },
      ],
      { provider, sourcePath: '/tmp/fixture.jsonl', mtime: now },
    );
    assert.deepEqual(s.events.filter((e) => e.kind === 'assistant').map(conversationKind), [
      'progress',
      'reply',
      'message',
    ]);
  }
});
test('Only explicit finals and unresolved attention contribute to notification counts', () => {
  const s = session([
    event('request', 'user'),
    event('progress', 'assistant', 'commentary'),
    event('final', 'assistant', 'final'),
    event('unknown', 'assistant'),
    { ...event('question', 'tool'), intent: 'request-input' },
  ]);
  const news = noticeCandidates(s, now);
  assert.equal(news.length, 5);
  assert.equal(unreadNoticeCount(news), 2);
  assert.equal(
    unreadNoticeCount(news.map((n) => (n.kind === 'attention' ? { ...n, resolvedAt: now } : n))),
    1,
  );
  assert.equal(unreadNoticeCount(news.map((n) => ({ ...n, seenAt: now }))), 0);
  assert.equal(
    isFinalNotice({ ...news.find((n) => n.kind === 'reply')!, phase: undefined }),
    false,
  );
  assert.equal(unreadNoticeCount([{ ...news[2], phase: undefined }]), 0);
});
test('Legacy classification migration preserves receipts; stale unknown replies stay out of the important inbox', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-news-classify-'));
  let store = new OfficeStore(dir);
  try {
    const s = session([event('final', 'assistant', 'final'), event('unknown', 'assistant')]);
    store.upsert([s], 'claude');
    const candidates = noticeCandidates(s, now);
    for (const candidate of candidates) {
      const legacy: OfficeNotice = {
        ...candidate,
        kind: 'reply',
        phase: undefined,
        seenAt: now - 20,
        dismissedAt: now - 10,
        version: noticeVersion(`reply:${candidate.text}:${candidate.at}`),
      };
      store.db
        .prepare('INSERT OR REPLACE INTO notices VALUES(?,?,?,?)')
        .run(legacy.id, s.id, legacy.at, JSON.stringify(legacy));
    }
    const orphan = {
      ...candidates[0],
      id: 'older-window',
      eventId: 'older-window',
      phase: undefined,
      seenAt: null,
    };
    store.db
      .prepare('INSERT OR REPLACE INTO notices VALUES(?,?,?,?)')
      .run(orphan.id, s.id, orphan.at, JSON.stringify(orphan));
    // A newer collector starts on rows an older version wrote, and takes every session in once.
    store.close();
    store = new OfficeStore(dir);
    store.upsert([s], 'claude');
    const rows = store.noticeList();
    assert.equal(rows.find((n) => n.eventId === 'final')?.phase, 'final');
    assert.equal(rows.find((n) => n.eventId === 'unknown')?.kind, 'message');
    for (const n of rows.filter((n) => n.id !== 'older-window')) {
      assert.ok(n.seenAt);
      assert.ok(n.dismissedAt);
    }
    assert.equal(unreadNoticeCount(rows), 0);
    assert.equal(rows.length, 3);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('A new final phase or updated response remains unread while identical polling preserves receipts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-news-final-'));
  const store = new OfficeStore(dir);
  try {
    const e = event('stream', 'assistant', 'commentary'),
      s = session([e]);
    store.upsert([s], 'claude');
    const n = store.noticeList()[0];
    store.noticeReceipt([n], 'read');
    store.upsert([s], 'claude');
    assert.ok(store.noticeList()[0].seenAt);
    store.upsert([{ ...s, events: [{ ...e, phase: 'final' }], revision: 'final' }], 'claude');
    assert.equal(unreadNoticeCount(store.noticeList()), 1);
    assert.equal(store.noticeList()[0].seenAt, null);
    store.noticeReceipt([n], 'read');
    assert.equal(
      unreadNoticeCount(store.noticeList()),
      1,
      'old version cannot mark a new final read',
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Legacy observed-only messages are reclassified without historical notification backfill', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-news-cursor-'));
  const store = new OfficeStore(dir);
  try {
    const s = session([]);
    store.upsert([s], 'claude');
    const e = { ...event('previously-observed', 'assistant'), at: now - 600_000 };
    const n = noticeCandidates(session([e]), now)[0];
    store.db
      .prepare('INSERT OR REPLACE INTO notice_observed VALUES(?,?,?)')
      .run(s.id, e.id, noticeVersion(`reply:${n.text}:${n.at}`));
    store.upsert([{ ...s, events: [e], revision: 'classified' }], 'claude');
    assert.equal(store.noticeList().length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Retained final excerpts fill source gaps without replacing or duplicating full messages', () => {
  const full = event('whole', 'assistant', 'final');
  const gap = event('gap', 'assistant', 'final');
  const notices = noticeCandidates(session([full, gap]), now);
  const combined = retainedConversation([full], notices);
  assert.equal(combined.length, 2);
  assert.equal(combined.find((e) => e.id === 'whole')?.excerpt, undefined);
  assert.equal(combined.find((e) => e.id === 'gap')?.excerpt, true);
  assert.equal(conversationKind(combined.find((e) => e.id === 'gap')!), 'reply');
  assert.equal(retainedConversation([full, gap], notices).filter((e) => e.excerpt).length, 0);
});
