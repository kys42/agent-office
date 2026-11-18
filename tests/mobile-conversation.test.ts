import test from 'node:test';
import assert from 'node:assert/strict';
import { newestMobilePage, olderMobilePage } from '../src/shared/mobile-conversation';
import { LOADED_EVENTS } from '../src/shared/conversation-pages';
import type { MobileDetail } from '../src/shared/mobile';

const page = (start: number, end: number): MobileDetail => ({
  id: 'synthetic',
  older: start > 0,
  events: Array.from({ length: end - start }, (_, index) => ({
    id: String(start + index),
    at: start + index,
    kind: 'assistant' as const,
    phase: 'final' as const,
    text: `Message ${start + index}`,
  })),
});

test('mobile history traverses 4,000 records with a bounded window and returns to latest', () => {
  let view = newestMobilePage(null, page(3960, 4000));
  const seen = new Set(view.events.map((e) => e.id));
  for (let end = 3960; end > 0; end -= 40) {
    view = olderMobilePage(view, page(end - 40, end));
    for (const event of view.events) seen.add(event.id);
    assert.ok(view.events.length <= LOADED_EVENTS);
    assert.equal(view.events[0].id, String(end - 40));
  }
  assert.equal(seen.size, 4000, 'no older records are made unreachable by the cap');
  assert.equal(view.older, false);
  assert.equal(view.newer, true);
  view = newestMobilePage(null, page(4000, 4040));
  assert.equal(view.newer, false);
  assert.equal(view.events.length, 40);
  assert.equal(view.events.at(-1)?.id, '4039');
});

test('mobile latest merges overlap once and resets across gaps and remote sharing reduction', () => {
  const old = newestMobilePage(null, page(0, 400));
  const live = newestMobilePage(old, page(380, 420));
  assert.equal(live.events.length, 400);
  assert.equal(live.events[0].id, '20');
  assert.equal(live.older, true);
  const gap = newestMobilePage(live, page(900, 940));
  assert.equal(gap.events.length, 40);
  assert.equal(gap.events[0].id, '900');
  const remote = newestMobilePage(
    old,
    { ...page(399, 400), events: [{ ...old.events[399], text: 'Excerpt', excerpt: true }] },
    true,
  );
  assert.equal(remote.events.length, 1);
  assert.equal(remote.events[0].text, 'Excerpt');
  assert.equal(remote.older, false);
});

test('duplicate event IDs and equal timestamps retain stored order while paging back', () => {
  const old = newestMobilePage(null, page(40, 80));
  old.events.forEach((e) => {
    e.at = 1;
  });
  const earlier = page(0, 45);
  earlier.events.forEach((e) => {
    e.at = 1;
  });
  const merged = olderMobilePage(old, earlier);
  assert.deepEqual(
    merged.events.map((e) => e.id),
    Array.from({ length: 80 }, (_, i) => String(i)),
  );
  assert.equal(olderMobilePage(old, { ...earlier, id: 'other' }), old);
});
