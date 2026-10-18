import test from 'node:test';
import assert from 'node:assert/strict';
import { DetailCache } from '../server/federation/detail-cache.js';
import {
  boundMobileDetail,
  MOBILE_EVENT_LIMIT,
  MOBILE_TEXT_LIMIT,
} from '../src/shared/mobile-detail.js';
import { detailPage } from '../src/shared/conversation-pages.js';
import { demoSnapshot } from '../src/lib/demo.js';
import type { MobileDetail } from '../src/shared/mobile.js';

const event = (n: number, text = 'reply') => ({
  id: `e${n}`,
  at: n,
  kind: 'assistant' as const,
  sourceRef: '',
  text,
});
test('detail cache bounds repeated writes, LRU and expiry by bytes and count', () => {
  let now = 0;
  const cache = new DetailCache<string>(() => now, 100, 3, 60);
  for (let i = 0; i < 10000; i++) {
    cache.set(String(i), 'x'.repeat(30));
    assert.ok(cache.size <= 3);
    assert.ok(cache.byteSize <= 100);
  }
  assert.equal(cache.get('9996'), undefined);
  assert.ok(cache.get('9997'));
  cache.set('next', 'x'.repeat(30));
  assert.equal(cache.get('9998'), undefined, 'least recently used evicted');
  cache.set('huge', 'x'.repeat(101));
  assert.equal(cache.get('huge'), undefined);
  now = 60;
  cache.prune();
  assert.equal(cache.size, 0);
  assert.equal(cache.byteSize, 0);
});
test('a chat left open keeps a bounded recent window, including long tool output', () => {
  let detail: MobileDetail = { id: 'chat', events: [], older: false };
  for (let i = 0; i < 10000; i++) {
    detail = boundMobileDetail({ ...detail, events: [...detail.events, event(i)] });
    assert.ok(detail.events.length <= MOBILE_EVENT_LIMIT);
  }
  assert.equal(detail.events.at(-1)?.id, 'e9999');
  assert.equal(detail.older, true);
  assert.equal(detail.capped, true);
  detail = boundMobileDetail({
    id: 'chat',
    older: false,
    events: Array.from({ length: 100 }, (_, i) => event(i, '가'.repeat(64000))),
  });
  assert.ok(detail.events.reduce((n, e) => n + e.text.length, 0) <= MOBILE_TEXT_LIMIT);
  assert.equal(detail.events.at(-1)?.id, 'e99');
  assert.equal(detail.capped, true);
});
test('conversation view pages requests, progress and final replies before removing tools', () => {
  const session = {
    ...demoSnapshot().sessions[0],
    events: [
      { ...event(0), kind: 'user' as const },
      { ...event(1), phase: 'commentary' as const },
      ...Array.from({ length: 200 }, (_, i) => ({ ...event(i + 2), kind: 'tool' as const })),
      { ...event(202), phase: 'final' as const },
    ],
  };
  const latest = detailPage(session, { view: 'conversation', limit: 2 });
  assert.deepEqual(
    latest.events.map((e) => e.id),
    ['e1', 'e202'],
  );
  assert.equal(latest.olderEvents, true);
  const older = detailPage(session, { view: 'conversation', limit: 2, before: 'e1' });
  assert.deepEqual(
    older.events.map((e) => e.id),
    ['e0'],
  );
  assert.equal(older.olderEvents, false);
  assert.equal(
    detailPage(session, { limit: 2 }).events[0].kind,
    'tool',
    'desktop default unchanged',
  );
});
