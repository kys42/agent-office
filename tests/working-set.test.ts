import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { OfficeService } from '../server/service.js';
import { OfficeStore } from '../server/store.js';
import { BoundedCache } from '../server/bounded-cache.js';
import { LatestTask } from '../src/lib/latest-task.js';
import { demoSnapshot } from '../src/lib/demo.js';
import type { OfficeNotice, Session } from '../src/shared/types.js';
import { residentNotices } from '../src/shared/notice-pages.js';
import {
  freshConversation,
  mergeNewest,
  mergeLive,
  prependPage,
  LOADED_EVENTS,
} from '../src/shared/conversation-pages.js';
import { unreadNoticeCount } from '../src/shared/notices.js';
import { summarizeCost } from '../server/pricing.js';
const now = Date.now();
const base = demoSnapshot().sessions[0];
const session = (id = 'claude:test'): Session => ({
  ...base,
  id,
  nativeId: id,
  revision: 'first',
  events: [],
  activity: undefined,
  relation: undefined,
  origin: undefined,
  actor: undefined,
  startedAt: now - 86400000,
  updatedAt: now,
});
const notice = (i: number, over: Partial<OfficeNotice> = {}): OfficeNotice => ({
  id: `notice-${String(i).padStart(8, '0')}`,
  sessionId: 'claude:test',
  eventId: `event-${String(i).padStart(8, '0')}`,
  kind: 'reply',
  phase: 'final',
  text: `unique archived reply ${i}`,
  at: now - i,
  receivedAt: now - i,
  version: `v${i}`,
  seenAt: null,
  viewedAt: null,
  dismissedAt: null,
  resolvedAt: null,
  bootstrap: false,
  ...over,
});
async function fixture(run: (store: OfficeStore, dir: string) => void | Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-working-set-'));
  const store = new OfficeStore(dir);
  try {
    store.upsert([session()], 'claude');
    await run(store, dir);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
function insert(store: OfficeStore, list: OfficeNotice[]) {
  const put = store.db.prepare('INSERT OR REPLACE INTO notices VALUES(?,?,?,?)');
  store.db.exec('BEGIN');
  try {
    for (const n of list) put.run(n.id, n.sessionId, n.at, JSON.stringify(n));
    store.db.exec('COMMIT');
  } catch (e) {
    store.db.exec('ROLLBACK');
    throw e;
  }
}
test('Indexed live view and pages preserve counts, receipts, exclusions and background semantics', async () =>
  fixture((store) => {
    const helper = {
      ...session('claude:helper'),
      origin: { kind: 'internal' as const, source: 'test' },
    };
    store.upsert([session(), helper], 'claude');
    insert(
      store,
      Array.from({ length: 360 }, (_, i) =>
        notice(i, {
          sessionId: i % 3 ? 'claude:test' : 'claude:helper',
          kind:
            i % 7 === 0
              ? 'attention'
              : i % 5 === 0
                ? 'request'
                : i % 4 === 0
                  ? 'progress'
                  : 'reply',
          phase: i % 4 === 0 ? 'commentary' : 'final',
          seenAt: i % 6 === 0 ? now - 40 * 86400000 : i % 2 === 0 ? now : null,
          resolvedAt: i % 11 === 0 ? now : null,
        }),
      ),
    );
    const all = store.noticeList();
    const view = store.noticeView();
    assert.deepEqual(view.notices, residentNotices(all));
    assert.deepEqual(view.noticeStats, { unread: unreadNoticeCount(all), total: all.length });
    const first = view.notices[0];
    store.noticeReceipt([first], 'read');
    assert.deepEqual(store.noticeView().notices, residentNotices(store.noticeList()));
    assert.equal(store.noticeView().noticeStats.unread, unreadNoticeCount(store.noticeList()));
  }));
test('Thousands of retained excerpts, including equal timestamps, are read exactly once by cursor', async () =>
  fixture((store) => {
    const count = 1600;
    insert(
      store,
      Array.from({ length: count }, (_, i) =>
        notice(i, { at: now - Math.floor(i / 700), text: `archive ${i}` }),
      ),
    );
    let page = store.detail('claude:test');
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      assert.ok(page.events.length <= 40);
      assert.ok((page.notices?.length ?? 0) <= 41);
      for (const event of page.events) {
        assert.ok(!ids.has(event.id), `duplicate ${event.id}`);
        ids.add(event.id);
        assert.ok(event.excerpt);
      }
      if (!page.olderEvents) break;
      assert.ok(page.events.length, 'a nonterminal page must advance');
      const first = page.events[0];
      page = store.detail('claude:test', { before: first.id, beforeAt: first.at });
    }
    assert.equal(ids.size, count, 'all history remains accessible without loading it at once');
  }));
test('Hot staging retains only touched observations, notices and ledger entries, not history', async () =>
  fixture((store) => {
    insert(
      store,
      Array.from({ length: 12000 }, (_, i) => notice(i, { kind: 'progress', phase: 'commentary' })),
    );
    const put = store.db.prepare('INSERT OR REPLACE INTO notice_observed VALUES(?,?,?)');
    const usage = store.db.prepare('INSERT OR REPLACE INTO usage_ledger VALUES(?,?,?)');
    store.db.exec('BEGIN');
    for (let i = 0; i < 12000; i++) {
      put.run('claude:test', `old-${i}`, `v${i}`);
      usage.run(
        'claude:test',
        `response:${i}`,
        JSON.stringify({
          id: `response:${i}`,
          model: 'gpt-6.1-sol',
          at: now - i,
          input: 1,
          output: 1,
          cached: 0,
          cacheWrite: 0,
          cacheWriteHour: 0,
        }),
      );
    }
    store.db.exec('COMMIT');
    store.stage(
      [
        {
          ...session(),
          revision: 'streaming',
          events: [
            { id: 'new', kind: 'user', at: now + 1, text: 'new request', sourceRef: 'fixture' },
          ],
        },
      ],
      'claude',
    );
    const staged = (store as any).staged.get('claude:test');
    assert.ok(staged.disk.size <= 2);
    assert.ok(staged.versions.size <= 2);
    assert.ok(staged.ledger.entries.size <= 2);
    assert.equal(store.get('claude:test').cost?.priced, 12000);
    assert.equal(store.noticeView().noticeStats.total, 12001);
    assert.ok(store.noticeView().notices.length < 200);
  }));
test('Migration backfills derived metadata and a legacy writer keeps it current', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-index-migration-'));
  let store: OfficeStore | undefined;
  let other: DatabaseSync | undefined;
  try {
    const db = new DatabaseSync(path.join(dir, 'office.sqlite'));
    db.exec(
      'CREATE TABLE notices(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL)',
    );
    const n = notice(1);
    db.prepare('INSERT INTO notices VALUES(?,?,?,?)').run(
      n.id,
      n.sessionId,
      n.at,
      JSON.stringify(n),
    );
    db.close();
    store = new OfficeStore(dir);
    store.upsert([session()], 'claude');
    assert.equal(store.noticeView().noticeStats.unread, 1);
    other = new DatabaseSync(path.join(dir, 'office.sqlite'));
    other
      .prepare('INSERT OR REPLACE INTO notices VALUES(?,?,?,?)')
      .run(n.id, n.sessionId, n.at, JSON.stringify({ ...n, seenAt: now, text: 'legacy changed' }));
    assert.equal(store.noticeView().noticeStats.unread, 0);
    assert.equal(store.noticeView().notices[0].text, 'legacy changed');
    const ro = new OfficeStore(dir, true);
    assert.equal(ro.noticeView().noticeStats.total, 1);
    ro.close();
    other.prepare('DELETE FROM notices WHERE id=?').run(n.id);
    assert.equal(store.noticeView().noticeStats.total, 0);
  } finally {
    other?.close();
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('Past-page working set stays bounded, holds its reading range through live updates, and can return', () => {
  const events = Array.from({ length: 2000 }, (_, i) => ({
    id: `e${i}`,
    kind: 'user' as const,
    text: `message ${i}`,
    at: i,
    sourceRef: 'fixture',
  }));
  let view = mergeNewest(freshConversation(session()), {
    ...session(),
    events: events.slice(-40),
    olderEvents: true,
  });
  for (let end = 1960; end > 0; end -= 40) {
    view = prependPage(view, {
      ...session(),
      events: events.slice(Math.max(0, end - 40), end),
      olderEvents: end > 40,
    });
    assert.ok(view.session.events.length <= LOADED_EVENTS);
  }
  assert.equal(view.session.events[0].id, 'e0');
  assert.equal(view.newer, true);
  const first = view.session.events[0];
  view = mergeLive(view, { ...session(), revision: 'live', events: events.slice(-4) });
  view = mergeNewest(view, { ...session(), events: events.slice(-40), olderEvents: true });
  assert.equal(view.session.events[0], first);
  view = mergeNewest(freshConversation(session()), {
    ...session(),
    events: events.slice(-40),
    olderEvents: true,
  });
  assert.equal(view.session.events.at(-1)?.id, 'e1999');
  assert.ok(!view.newer);
});
test('A stalled detail transport keeps only the latest replacement, and failures do not poison it', async () => {
  const tasks = new LatestTask<number>();
  let finish!: (n: number) => void;
  let runs = 0;
  const first = tasks.request(() => {
    runs++;
    return new Promise((resolve) => (finish = resolve));
  });
  const pending = [];
  for (let i = 0; i < 1000; i++)
    pending.push(
      tasks.request(async () => {
        runs++;
        return i;
      }),
    );
  first.cancel();
  finish(1);
  assert.equal(await pending.at(-1)!.promise, 999);
  await Promise.all(pending.map((p) => p.promise));
  assert.equal(runs, 2);
  assert.equal(await first.promise, undefined);
  await assert.rejects(
    tasks.request(async () => {
      throw new Error('offline');
    }).promise,
  );
  assert.equal(await tasks.request(async () => 3).promise, 3);
});
test('Byte-budgeted caches evict LRU and oversized values without retaining their payload', () => {
  const cache = new BoundedCache<string, string>(12, 3, (s) => s.length);
  cache.set('a', '1234').set('b', '1234').set('c', '1234');
  cache.get('a');
  cache.set('d', '1234');
  assert.equal(cache.has('b'), false);
  assert.equal(cache.bytes, 12);
  cache.set('a', 'x'.repeat(100));
  assert.equal(cache.has('a'), false);
  assert.equal(cache.bytes, 8);
  cache.clear();
  assert.equal(cache.bytes, 0);
  assert.equal(cache.size, 0);
});
test('Cost aggregation accepts a large iterator without an argument/array growth limit', () => {
  function* entries() {
    for (let i = 0; i < 150000; i++)
      yield {
        id: `e${i}`,
        at: i,
        model: 'gpt-6.1-sol',
        input: 1,
        output: 1,
        cached: 0,
        cacheWrite: 0,
        cacheWriteHour: 0,
      };
  }
  const cost = summarizeCost(entries());
  assert.equal(cost.priced, 150000);
  assert.equal(cost.tokens, 300000);
  assert.equal(cost.since, 0);
});

test('An archived message can be bookmarked and reached without loading intervening history', async () =>
  fixture((store) => {
    insert(
      store,
      Array.from({ length: 1600 }, (_, i) => notice(i)),
    );
    const target = notice(1500);
    const saved = store.bookmark(target.sessionId, target.eventId);
    assert.equal(saved.text, target.text);
    const reached = store.detail(target.sessionId, { reach: target.eventId });
    assert.equal(reached.newerEvents, true);
    assert.ok(reached.events.length <= 40);
    assert.ok(reached.events.some((e) => e.id === target.eventId));
  }));

test('Byte-heavy patch history evicts old baselines and pollers recover a whole snapshot', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-patch-budget-'));
  const service = new OfficeService(dir, dir);
  try {
    service.store.upsert([session()], 'claude');
    const first = service.emitSnapshot();
    await service.call('snapshot', [first.epoch, first.version]);
    for (let i = 0; i < 60; i++) {
      // Stress publisher payloads independently of provider text clipping.
      const s = {
        ...first,
        sessions: [{ ...first.sessions[0], title: `${i} ${'x'.repeat(100000)}` }],
        version: i + first.version + 1,
      };
      const internal = service as any;
      const index = (await import('../src/shared/snapshot-patch.js')).indexSnapshot(s);
      internal.publish(s, index, { sessions: s.sessions });
      assert.ok(internal.patchBytes <= 8 * 1048576);
    }
    assert.ok((service as any).patches.length < 60);
    const recovered = (await service.call('snapshot', [first.epoch, first.version])) as any;
    assert.ok(Array.isArray(recovered.sessions));
    assert.equal(recovered.sessions[0].title.startsWith('59 '), true);
  } finally {
    service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('A blocked disk checkpoint stops an oversized hot overlay growing without losing it', async () =>
  fixture((store) => {
    const hot = { ...session(), revision: 'hot' };
    store.stage([hot], 'claude');
    const x = (store as any).staged.get(hot.id);
    for (let i = 0; i < 4096; i++) x.notices.set(`buffer-${i}`, notice(i));
    const checkpoint = store.persistStaged.bind(store);
    store.persistStaged = () => {
      throw new Error('fixture disk unavailable');
    };
    try {
      assert.throws(
        () => store.stage([{ ...hot, revision: 'next' }], 'claude'),
        /fixture disk unavailable/,
      );
      assert.equal(x.notices.size, 4096);
      assert.equal(x.row.revision, 'hot');
    } finally {
      store.persistStaged = checkpoint;
    }
  }));

test('Compressed overflow avoids sequential-scan reparsing and respects stamps, corruption and pruning', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-cold-cache-'));
  const service = new OfficeService(dir, dir);
  let reads = 0;
  (service.cache as any).maxEntries = 1;
  service.windows.read = async (file: any) => {
    reads++;
    return {
      records: [
        { type: 'session_meta', payload: { id: file.path, cwd: '/tmp/fixture' } },
        {
          type: 'response_item',
          timestamp: new Date(now).toISOString(),
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `request ${file.path}` }],
          },
        },
      ],
      partial: false,
      mode: 'full',
    };
  };
  const files = [0, 1, 2].map((i) => ({
    path: `/tmp/cold-fixture-${i}.jsonl`,
    size: 100,
    mtime: now,
  }));
  const read = (file: any) => (service as any).readSession('codex', file, new Map());
  try {
    const initial = [];
    for (const file of files) initial.push(await read(file));
    assert.equal(reads, 3);
    assert.equal(service.coldCache.size, 2);
    for (let pass = 0; pass < 5; pass++)
      for (let i = 0; i < files.length; i++) assert.deepEqual(await read(files[i]), initial[i]);
    assert.equal(reads, 3, 'unchanged oversized working set never rereads the raw log');
    await read({ ...files[0], size: 101 });
    assert.equal(reads, 4, 'changed source invalidates compressed stamp');
    service.coldCache.set(files[1].path, {
      stamp: `office-v11:100:${now}`,
      provider: 'codex',
      data: Buffer.from('broken'),
    });
    await read(files[1]);
    assert.equal(reads, 5, 'a corrupt cache falls back to the source');
    (service as any).forget('codex', new Set());
    assert.equal(service.cache.size, 0);
    assert.equal(service.coldCache.size, 0);
  } finally {
    service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
