import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OfficeStore } from '../server/store.js';
import { OfficeService } from '../server/service.js';
import { demoSnapshot } from '../src/lib/demo.js';
import { unreadNoticeCount } from '../src/shared/notices.js';
import {
  RECENT_NOTICES,
  UNREAD_FINALS,
  noticeCursor,
  noticeOrder,
  residentNotices,
} from '../src/shared/notice-pages.js';
import {
  freshConversation,
  mergeLive,
  mergeNewest,
  prependPage,
} from '../src/shared/conversation-pages.js';
import type {
  NoticePageRequest,
  OfficeEvent,
  OfficeNotice,
  Session,
  Snapshot,
} from '../src/shared/types.js';

const now = Date.now();
const base = demoSnapshot().sessions[0];
const session = (id: string, events: OfficeEvent[] = [], project = base.project): Session => ({
  ...base,
  id,
  nativeId: id,
  project,
  events,
  activity: undefined,
  revision: id,
  relation: undefined,
  origin: undefined,
  actor: undefined,
  startedAt: now - 86400_000,
  updatedAt: now - 1000,
});
const events = (n: number): OfficeEvent[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    kind: i % 2 ? 'assistant' : 'user',
    at: now - (n - i) * 1000,
    text: `message ${i}`,
    sourceRef: 'fixture',
  }));
const notice = (sessionId: string, i: number, over: Partial<OfficeNotice> = {}): OfficeNotice => ({
  id: `${sessionId}::n${i}`,
  sessionId,
  eventId: `n${i}`,
  kind: 'progress',
  phase: 'commentary',
  text: `notice ${i}`,
  at: now - i * 1000,
  receivedAt: now - i * 1000,
  version: `v${i}`,
  seenAt: null,
  viewedAt: null,
  dismissedAt: null,
  resolvedAt: null,
  bootstrap: false,
  ...over,
});
const put = (store: OfficeStore, notices: OfficeNotice[]) => {
  const insert = store.db.prepare('INSERT OR REPLACE INTO notices VALUES(?,?,?,?)');
  store.db.exec('BEGIN');
  for (const n of notices) insert.run(n.id, n.sessionId, n.at, JSON.stringify(n));
  store.db.exec('COMMIT');
};
async function withStore(run: (store: OfficeStore, dir: string) => void | Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-paging-'));
  const store = new OfficeStore(dir);
  try {
    await run(store, dir);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
/** Every page of `request`, followed by cursor. */
function allPages(store: OfficeStore, request: NoticePageRequest) {
  const out: OfficeNotice[] = [];
  let before: NoticePageRequest['before'] = null;
  for (let i = 0; i < 100; i++) {
    const page = store.noticePage({ ...request, before });
    out.push(...page.notices);
    if (!page.more) return out;
    assert.equal(page.notices.length, request.limit);
    before = noticeCursor(page.notices.at(-1)!);
  }
  throw new Error('paging did not end');
}

test('A conversation is read newest page first, then older pages by cursor, to the start', async () => {
  await withStore((store) => {
    store.upsert([session('claude:long', events(100))], 'claude');
    const first = store.detail('claude:long');
    assert.deepEqual(
      first.events.map((e) => e.id),
      Array.from({ length: 40 }, (_, i) => `e${60 + i}`),
    );
    assert.equal(first.olderEvents, true);
    const second = store.detail('claude:long', { before: 'e60' });
    assert.deepEqual([second.events[0].id, second.events.at(-1)!.id], ['e20', 'e59']);
    assert.equal(second.olderEvents, true);
    const last = store.detail('claude:long', { before: 'e20', limit: 40 });
    assert.deepEqual([last.events[0].id, last.events.length], ['e0', 20]);
    assert.equal(last.olderEvents, false, 'the start is detected');
    assert.deepEqual(
      store.detail('claude:long', { limit: 5 }).events.map((e) => e.id),
      ['e95', 'e96', 'e97', 'e98', 'e99'],
    );
    // A cursor that left the source window has nothing older left either.
    const gone = store.detail('claude:long', { before: 'missing' });
    assert.deepEqual([gone.events.length, gone.olderEvents], [0, false]);
    // A short conversation is one page.
    store.upsert([session('claude:short', events(10))], 'claude');
    assert.deepEqual(
      [store.detail('claude:short').events.length, store.detail('claude:short').olderEvents],
      [10, false],
    );
  });
});

test('Conversation pages follow get: decorated, and excluded or unknown sessions refused', async () => {
  await withStore((store) => {
    store.upsert(
      [session('claude:mine', events(50)), session('claude:secret', events(50), 'secret')],
      'claude',
    );
    store.patch('claude:mine', { alias: '나의 동료' });
    assert.equal(store.detail('claude:mine').alias, '나의 동료');
    store.preferences({ excludedProjects: ['secret'] });
    assert.throws(() => store.detail('claude:secret'));
    assert.throws(() => store.detail('claude:secret', { before: 'e20' }));
    assert.throws(() => store.detail('claude:none'));
  });
});

test('Each page brings the notices its excerpts need, the oldest page all earlier ones', async () => {
  await withStore((store) => {
    const evs = events(100);
    store.upsert([session('claude:long', evs)], 'claude');
    // Notices of this session around the events' times, and one far older than any event.
    put(store, [
      notice('claude:long', 0, { at: evs[90].at }),
      notice('claude:long', 1, { at: evs[45].at }),
      notice('claude:long', 2, { at: evs[5].at }),
      notice('claude:long', 3, { at: evs[0].at - 3600_000 }),
      notice('claude:other', 4, { at: evs[90].at }),
    ]);
    // (The store also took in the conversation's own latest message as a notice.)
    const ids = (p: { notices?: OfficeNotice[] }) =>
      (p.notices ?? [])
        .map((n) => n.eventId)
        .filter((id) => id.startsWith('n'))
        .sort();
    assert.deepEqual(ids(store.detail('claude:long')), ['n0']);
    assert.deepEqual(ids(store.detail('claude:long', { before: 'e60' })), ['n1']);
    assert.deepEqual(ids(store.detail('claude:long', { before: 'e20' })), ['n2', 'n3']);
  });
});

test('The snapshot carries what the office needs live; counts and pages cover every notice', async () => {
  await withStore((store) => {
    store.upsert(
      [session('claude:a'), session('claude:b'), session('claude:hidden', [], 'secret')],
      'claude',
    );
    const a = Array.from({ length: 400 }, (_, i) => notice('claude:a', i, { seenAt: now - 1 }));
    // Old news that must stay live: an unread final, an open call, a request to quote.
    a.push(
      notice('claude:a', 500, { kind: 'reply', phase: 'final', text: 'old final' }),
      notice('claude:a', 501, { kind: 'attention', phase: undefined, text: 'old call' }),
      notice('claude:a', 502, { kind: 'request', phase: undefined, seenAt: now - 1 }),
    );
    // Another colleague whose only notice is old: still its bubble / peek.
    const b = [notice('claude:b', 900, { kind: 'reply', phase: 'final', seenAt: now - 1 })];
    const hidden = [notice('claude:hidden', 1, { kind: 'reply', phase: 'final' })];
    // Ties in time are ordered by id, so no cursor skips or repeats one.
    const ties = Array.from({ length: 7 }, (_, i) =>
      notice('claude:a', 600 + i, { at: now - 600_000, seenAt: now - 1 }),
    );
    put(store, [...a, ...b, ...hidden, ...ties]);
    store.preferences({ excludedProjects: ['secret'] });
    const all = store.noticeList();
    assert.equal(all.length, a.length + b.length + ties.length, 'excluded projects never count');
    const view = store.officeView();
    const carried = new Set(view.notices.map((n) => n.id));
    assert.ok(view.notices.length < all.length / 2, 'the snapshot is bounded');
    for (const n of all.slice(0, RECENT_NOTICES)) assert.ok(carried.has(n.id));
    for (const id of ['claude:a::n500', 'claude:a::n501', 'claude:a::n502', 'claude:b::n900'])
      assert.ok(carried.has(id), id);
    assert.deepEqual(view.noticeStats, { unread: unreadNoticeCount(all), total: all.length });
    assert.equal(view.noticeStats.unread, 2);
    // Pages, in snapshot order, reach every notice once.
    const paged = allPages(store, { filter: 'all', includeRead: true, limit: 50 });
    assert.deepEqual(
      paged.map((n) => n.id),
      all.map((n) => n.id),
    );
    assert.deepEqual(paged, [...paged].sort(noticeOrder));
    assert.equal(new Set(paged.map((n) => n.id)).size, paged.length);
    // Kinds, read state and scope match the lists.
    assert.deepEqual(
      store.noticePage({ filter: 'final' }).notices.map((n) => n.id),
      ['claude:a::n500'],
    );
    assert.deepEqual(
      store.noticePage({ filter: 'final', includeRead: true, sessionIds: ['claude:b'] }).notices,
      [all.find((n) => n.id === 'claude:b::n900')],
    );
    assert.deepEqual(store.noticePage({ filter: 'all', sessionIds: ['claude:a'] }).unread, {
      final: 1,
      attention: 1,
      all: 2,
    });
  });
});

test('Receipts and read-all reach notices the snapshot does not carry, and counts follow', async () => {
  await withStore((store) => {
    store.upsert([session('claude:a'), session('claude:b')], 'claude');
    const finals = Array.from({ length: UNREAD_FINALS + 5 }, (_, i) =>
      notice('claude:a', i, { kind: 'reply', phase: 'final' }),
    );
    const progress = Array.from({ length: 200 }, (_, i) =>
      notice('claude:b', 2000 + i, { receivedAt: now - 5000 }),
    );
    put(store, [...finals, ...progress]);
    const view = store.officeView();
    assert.equal(view.noticeStats.unread, UNREAD_FINALS + 5);
    const oldest = finals.at(-1)!;
    assert.ok(!view.notices.some((n) => n.id === oldest.id), 'beyond the cap');
    store.noticeReceipt([{ id: oldest.id, version: oldest.version }], 'read');
    assert.equal(store.officeView().noticeStats.unread, UNREAD_FINALS + 4);
    const read = store
      .noticePage({
        filter: 'final',
        includeRead: true,
        limit: 500,
        before: noticeCursor(finals[600]),
      })
      .notices.find((n) => n.id === oldest.id);
    assert.ok(read?.seenAt);
    store.noticeReceipt([{ id: oldest.id, version: oldest.version }], 'unread');
    assert.equal(store.officeView().noticeStats.unread, UNREAD_FINALS + 5);
    // Read all in one kind: every unread final, carried or not; progress untouched.
    store.noticeReadAll({ filter: 'final' }, now);
    assert.equal(store.officeView().noticeStats.unread, 0);
    assert.equal(store.noticePage({ filter: 'all', limit: 500 }).unread.all, 200);
    // What arrived after the person's reading is left unread, as is another colleague's.
    const late = notice('claude:b', 3000, { receivedAt: now + 60_000, at: now - 2000 });
    put(store, [late]);
    store.noticeReadAll({ filter: 'all', sessionIds: ['claude:b'] }, now);
    const unread = store.noticePage({ filter: 'all', limit: 500 }).notices;
    assert.deepEqual(
      unread.map((n) => n.id),
      [late.id],
    );
  });
});

test('The service validates the paged reads and answers the old detail shape with the newest page', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-paging-service-'));
  const service = new OfficeService(path.join(temp, 'data'), temp);
  try {
    service.store.upsert([session('claude:long', events(100))], 'claude');
    put(service.store, [notice('claude:long', 1, { kind: 'reply', phase: 'final' })]);
    const detail = (await service.call('detail', ['claude:long'])) as Session & {
      olderEvents: boolean;
    };
    assert.deepEqual([detail.events.length, detail.olderEvents], [40, true]);
    const page = (await service.call('detail', [
      'claude:long',
      { before: 'e60', limit: 10 },
    ])) as Session;
    assert.deepEqual([page.events[0].id, page.events.length], ['e50', 10]);
    await assert.rejects(service.call('detail', ['claude:long', { limit: 0 }]));
    await assert.rejects(service.call('detail', ['claude:long', { limit: 201 }]));
    await assert.rejects(service.call('detail', ['claude:long', { from: 'e1' }]));
    await assert.rejects(service.call('noticePage', [{ filter: 'all', limit: 501 }]));
    await assert.rejects(service.call('noticePage', [{ filter: 'unknown' }]));
    const before = (await service.call('snapshot')) as Snapshot;
    assert.equal(before.noticeStats?.unread, 1);
    const after = (await service.call('noticeReadAll', [
      { filter: 'final' },
      Date.now(),
    ])) as Snapshot;
    assert.equal(after.noticeStats?.unread, 0);
  } finally {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  }
});

test('A card keeps the pages it read, joins live events at the newest end, never shows a gap', () => {
  const all = events(100);
  const live = (evs: OfficeEvent[]) => ({ ...session('claude:x'), events: evs });
  const detail = (evs: OfficeEvent[], olderEvents: boolean) => ({ ...live(evs), olderEvents });
  let view = freshConversation(live([all[10], ...all.slice(96)]));
  view = mergeNewest(view, detail(all.slice(60), true));
  assert.deepEqual([view.session.events[0].id, view.older, view.paged], ['e60', true, true]);
  // The snapshot's old request waits for its page; new events join.
  const next = { ...all[99], id: 'e100', at: now };
  view = mergeLive(view, live([all[10], ...all.slice(97), next]));
  assert.deepEqual(
    [view.session.events[0].id, view.session.events.at(-1)!.id, view.session.events.length],
    ['e60', 'e100', 41],
  );
  view = prependPage(view, detail(all.slice(20, 60), true));
  assert.equal(view.session.events[0].id, 'e20');
  // The newest page read again keeps what was read further back while it joins.
  view = mergeNewest(view, detail([...all.slice(61), next], true));
  assert.deepEqual(
    [view.session.events[0].id, view.session.events.length, view.older],
    ['e20', 81, true],
  );
  // More than a page moved on meanwhile: start over from the newest page.
  const later = Array.from({ length: 40 }, (_, i) => ({ ...next, id: `f${i}`, at: now + i + 1 }));
  view = mergeNewest(view, detail(later, true));
  assert.deepEqual([view.session.events[0].id, view.session.events.length], ['f0', 40]);
  // Another colleague starts fresh.
  assert.equal(mergeLive(view, { ...live(all.slice(0, 2)), id: 'claude:y' }).paged, false);
});

test('The carried set keeps each colleague latest bubble, quote and conversation', () => {
  const list = [
    ...Array.from({ length: 150 }, (_, i) => notice('claude:a', i, { seenAt: now })),
    notice('claude:b', 200, { kind: 'progress', seenAt: now }),
    notice('claude:b', 201, { kind: 'reply', phase: 'final', seenAt: now }),
    notice('claude:b', 202, { kind: 'request', phase: undefined, seenAt: now }),
    notice('claude:b', 203, { kind: 'request', phase: undefined, seenAt: now }),
  ].sort(noticeOrder);
  const kept = new Set(residentNotices(list, now).map((n) => n.eventId));
  assert.ok(kept.has('n200') && kept.has('n201') && kept.has('n202'));
  assert.ok(!kept.has('n203'), 'only the latest request');
  assert.ok(!kept.has('n149'), 'old chatter waits for its page');
});
