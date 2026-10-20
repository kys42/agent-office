import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_NOTIFY,
  NOTIFY_FRESH_MS,
  colleagueResolver,
  flushNotifications,
  NOTIFY_GRACE_MS,
  notifyPreferences,
  notifyReady,
  planNotifications,
  revalidateNotifications,
  throttleNotifications,
  type Colleague,
  type NotifyContext,
  type NotifyFocus,
  type NotifyItem,
  type NotifyPlanInput,
} from '../src/shared/notify-plan.js';
import { demoSnapshot } from '../src/lib/demo.js';
import { setLocale } from '../src/shared/i18n/index.js';
import type { OfficeNotice, Preferences } from '../src/shared/types.js';

setLocale('ko');
const now = 1_800_000_000_000;
const notice = (id: string, patch: Partial<OfficeNotice> = {}): OfficeNotice => ({
  id,
  sessionId: 'a',
  eventId: id,
  kind: 'reply',
  phase: 'final',
  text: '**결과**를 정리했어요.',
  at: now - 1000,
  receivedAt: now - 500,
  version: 'v1',
  seenAt: null,
  viewedAt: null,
  dismissedAt: null,
  resolvedAt: null,
  bootstrap: false,
  ...patch,
});
const call = (id: string, patch: Partial<OfficeNotice> = {}) =>
  notice(id, { kind: 'attention', phase: undefined, text: '확인이 필요해요', ...patch });
const prefs = (patch: Partial<Preferences> = {}): Preferences => ({
  paused: false,
  reducedMotion: false,
  privacy: false,
  excludedProjects: [],
  enabledProviders: ['claude', 'codex', 'openclaw'],
  maxSessions: 120,
  notifications: { finals: true, calls: true, sound: false },
  ...patch,
});
const people: Record<string, Colleague> = {
  a: { name: '리서처', provider: 'Claude', ids: ['a', 'a2'] },
  b: { name: '빌더', provider: 'Codex', ids: ['b'] },
  h: { name: '도우미', provider: 'Claude', ids: ['h', 'a'] },
};
const away: NotifyFocus = { mainFocused: false, selected: null, cards: [] };
const plan = (notices: OfficeNotice[], patch: Partial<NotifyPlanInput> = {}) =>
  planNotifications({
    seen: new Set(),
    notices,
    prefs: prefs(),
    colleague: (id) => people[id],
    focus: away,
    now,
    ...patch,
  });

test('Defaults: calls and errors notify silently, finals stay quiet until turned on', () => {
  assert.deepEqual(DEFAULT_NOTIFY, { finals: false, calls: true, sound: false });
  assert.deepEqual(notifyPreferences({}), DEFAULT_NOTIFY);
  const { items } = plan([notice('f'), call('c', { sessionId: 'b' })], {
    prefs: prefs({ notifications: undefined }),
  });
  assert.deepEqual(
    items.map((i) => [i.kind, i.title, i.body, i.silent]),
    [['call', '빌더', '확인이 필요해요', true]],
  );
});

test('A new final shows its colleague and a short plain excerpt; sound follows the setting', () => {
  const long = '가'.repeat(300);
  const { items } = plan([notice('f'), notice('g', { sessionId: 'b', text: long })], {
    prefs: prefs({ notifications: { finals: true, calls: false, sound: true } }),
  });
  assert.equal(items.length, 2);
  assert.deepEqual(
    { title: items[0].title, body: items[0].body, session: items[0].sessionId },
    { title: '리서처', body: '결과를 정리했어요.', session: 'a' },
  );
  assert.ok(items[1].body.length <= 100 && items[1].body.endsWith('…'));
  assert.ok(items.every((i) => !i.silent));
  // Errors count as calls.
  const errors = plan([notice('e', { kind: 'error', phase: undefined, text: 'boom' })]).items;
  assert.deepEqual(
    errors.map((i) => [i.kind, i.body]),
    [['error', '오류가 났어요']],
  );
});

test('The first snapshot only primes; each call version notifies once', () => {
  const first = plan([call('c')], { seen: null });
  assert.equal(first.items.length, 0);
  assert.ok(first.seen.has('c@v1'));
  assert.equal(plan([call('c')], { seen: first.seen }).items.length, 0);
  // A call raised again with new content is someone waiting again.
  assert.equal(plan([call('c', { version: 'v2' })], { seen: first.seen }).items.length, 1);
  // Only the keys still carried are kept.
  assert.deepEqual([...plan([call('g')], { seen: first.seen }).seen], ['g@v1']);
});

test('A final reply notifies once, even when its text completes after a partial collection', () => {
  const partial = plan([notice('f', { text: '결과를 정리', version: 'v1' })]);
  assert.equal(partial.items.length, 1);
  // The collector read the rest: new content, new version, fresh receivedAt; same news.
  const done = plan([notice('f', { version: 'v2', receivedAt: now })], { seen: partial.seen });
  assert.deepEqual(done.items, []);
  // A reply that only becomes a final later (it was progress before) is news then.
  const progress = plan([notice('p', { phase: 'commentary' })]);
  assert.equal(progress.items.length, 0);
  assert.equal(plan([notice('p', { version: 'v2' })], { seen: progress.seen }).items.length, 1);
});

test('Startup: snapshots only prime until a collection pass finishes after the app started', () => {
  const started = now - 10_000;
  // The office read from disk before the first pass: not ready.
  assert.equal(notifyReady({ syncing: true, lastSync: null }, started, now - 9000, now), false);
  // A pass from before the app started (a collector already running) does not count.
  assert.equal(
    notifyReady({ syncing: false, lastSync: started - 1 }, started, now - 9000, now),
    false,
  );
  // Still syncing: the pass is not over.
  assert.equal(
    notifyReady({ syncing: true, lastSync: started + 1 }, started, now - 9000, now),
    false,
  );
  assert.equal(
    notifyReady({ syncing: false, lastSync: started + 1 }, started, now - 9000, now),
    true,
  );
  // A collector that never finishes a pass: notifications start after the grace period.
  assert.equal(
    notifyReady({ syncing: true, lastSync: null }, started, now - NOTIFY_GRACE_MS, now),
    true,
  );
});

test('Old, read, put away, background, remote and unknown news never notifies', () => {
  const { items } = plan(
    [
      notice('boot', { bootstrap: true }),
      notice('read', { seenAt: now }),
      notice('gone', { dismissedAt: now }),
      notice('old', { receivedAt: now - NOTIFY_FRESH_MS - 1 }),
      notice('bg', { background: true }),
      notice('remote-office:x:a::e'),
      notice('r2', { sessionId: 'remote-office:x:a' }),
      notice('progress', { phase: 'commentary' }),
      call('handled', { resolvedAt: now }),
      // A helper's call still notifies (its final would be background).
      call('helper', { sessionId: 'h', background: true }),
    ],
    { colleague: (id) => people[id] ?? people.a },
  );
  assert.deepEqual(
    items.map((i) => i.key),
    ['helper@v1'],
  );
  // A session the office no longer knows.
  assert.deepEqual(plan([notice('who', { sessionId: 'nobody' })]).items, []);
});

test('Nothing shows for a colleague in front of the person', () => {
  const both = [notice('f'), call('c', { sessionId: 'b' })];
  // The big office is focused at that colleague's card (any of its runs).
  assert.deepEqual(
    plan(both, { focus: { mainFocused: true, selected: 'a2', cards: [] } }).items.map(
      (i) => i.sessionId,
    ),
    ['b'],
  );
  // The same card in a window behind other apps still notifies.
  assert.equal(
    plan(both, { focus: { mainFocused: false, selected: 'a', cards: [] } }).items.length,
    2,
  );
  // A dock card on screen; a helper's call shows on its host's card.
  assert.deepEqual(
    plan([...both, call('h', { sessionId: 'h' })], {
      focus: { mainFocused: false, selected: null, cards: ['a'] },
    }).items.map((i) => i.sessionId),
    ['b'],
  );
});

test('Hidden screen content: the tool name only, never the message', () => {
  const { items } = plan([notice('f'), call('c', { sessionId: 'b' })], {
    prefs: prefs({ privacy: true }),
  });
  assert.deepEqual(
    items.map((i) => [i.title, i.body]),
    [
      ['Claude', '최종 응답을 보냈어요'],
      ['Codex', '확인이 필요해요'],
    ],
  );
});

const item = (key: string, kind: NotifyItem['kind'] = 'final', sessionId = 'a'): NotifyItem => ({
  key,
  kind,
  title: key,
  body: key,
  sessionId,
  silent: true,
  count: 1,
  finals: kind === 'final' ? 1 : 0,
});

test('A burst of more than three at once becomes one summary', () => {
  const r = throttleNotifications(
    { shown: [], held: [] },
    [item('1'), item('2', 'call', 'b'), item('3'), item('4')],
    now,
  );
  assert.equal(r.show.length, 1);
  assert.equal(r.show[0].kind, 'summary');
  assert.equal(r.show[0].body, '새 소식 4개 · 최종 응답 3개');
  assert.equal(r.show[0].sessionId, undefined);
  assert.equal(r.flushAt, undefined);
  // All from one colleague: the summary opens that colleague.
  const one = throttleNotifications(
    { shown: [], held: [] },
    ['1', '2', '3', '4'].map((k) => item(k)),
    now,
  );
  assert.equal(one.show[0].sessionId, 'a');
  assert.equal(one.show[0].body, '새 최종 응답 4개');
});

test('Over three within five seconds: the rest wait and arrive as one', () => {
  let state = { shown: [] as number[], held: [] as NotifyItem[] };
  const shown: string[] = [];
  for (const [at, key] of [
    [0, '1'],
    [1000, '2'],
    [2000, '3'],
    [3000, '4'],
    [3500, '5'],
  ] as const) {
    const r = throttleNotifications(state, [item(key, 'call', key)], now + at);
    state = r.state;
    shown.push(...r.show.map((i) => i.key));
    if (key === '4') assert.equal(r.flushAt, now + 5000);
  }
  assert.deepEqual(shown, ['1', '2', '3']);
  assert.equal(state.held.length, 2);
  const flushed = flushNotifications(state, now + 5000);
  assert.equal(flushed.show.length, 1);
  assert.equal(flushed.show[0].body, '확인이 필요한 소식 2개');
  assert.deepEqual(flushed.state.held, []);
  // A single held one shows as itself; nothing held shows nothing.
  assert.equal(flushNotifications({ shown: [], held: [item('x')] }, now).show[0].key, 'x');
  assert.deepEqual(flushNotifications(flushed.state, now).show, []);
  // After the window, notifications show one by one again.
  const later = throttleNotifications(flushed.state, [item('6')], now + 20_000);
  assert.deepEqual(
    later.show.map((i) => i.key),
    ['6'],
  );
});

test('Held notifications are checked again right before they show', () => {
  const notices = [notice('f'), call('c', { sessionId: 'b' }), notice('g', { sessionId: 'b' })];
  const held = plan(notices).items;
  assert.equal(held.length, 3);
  const again = (patch: Partial<NotifyContext> = {}) =>
    revalidateNotifications(held, {
      notices,
      prefs: prefs(),
      colleague: (id) => people[id],
      focus: away,
      now,
      ...patch,
    });
  assert.equal(again().length, 3);
  // Notifications turned off meanwhile: dropped (finals only, or all).
  assert.deepEqual(
    again({ prefs: prefs({ notifications: { finals: false, calls: true, sound: false } }) }).map(
      (i) => i.key,
    ),
    ['c@v1'],
  );
  assert.deepEqual(
    again({ prefs: prefs({ notifications: { finals: false, calls: false, sound: false } }) }),
    [],
  );
  // Hidden screen content turned on meanwhile: redacted.
  assert.deepEqual(
    again({ prefs: prefs({ privacy: true }) }).map((i) => [i.title, i.body]),
    [
      ['Claude', '최종 응답을 보냈어요'],
      ['Codex', '확인이 필요해요'],
      ['Codex', '최종 응답을 보냈어요'],
    ],
  );
  // The colleague is in front of the person now.
  assert.deepEqual(
    again({ focus: { mainFocused: false, selected: null, cards: ['b'] } }).map((i) => i.key),
    ['final:f'],
  );
  // Read, viewed, put away, handled, or no longer carried meanwhile.
  assert.deepEqual(
    again({
      notices: [
        notice('f', { seenAt: now }),
        call('c', { sessionId: 'b', resolvedAt: now }),
        notice('g', { sessionId: 'b', viewedAt: now }),
      ],
    }),
    [],
  );
  assert.deepEqual(again({ notices: [notice('f', { dismissedAt: now })] }), []);
  // A held summary is checked member by member, then summarized again.
  const burst = throttleNotifications(
    { shown: [now, now, now], held: [] },
    [...held, ...plan([notice('x')]).items],
    now,
  );
  assert.equal(burst.state.held[0].kind, 'summary');
  const flushed = flushNotifications(burst.state, now + 5000, (items) =>
    revalidateNotifications(items, {
      notices: [notices[0], notices[1]],
      prefs: prefs(),
      colleague: (id) => people[id],
      focus: away,
      now: now + 5000,
    }),
  );
  assert.equal(flushed.show.length, 1);
  assert.equal(flushed.show[0].body, '새 소식 2개 · 최종 응답 1개');
  // Nothing left: nothing shows, and the window is not used up.
  const none = flushNotifications(burst.state, now + 5000, () => []);
  assert.deepEqual(none.show, []);
  assert.deepEqual(none.state.held, []);
});

test('Colleagues resolve from the office model: name, tool and every id its card shows', () => {
  const snapshot = demoSnapshot();
  const resolve = colleagueResolver(snapshot, Date.now());
  const s = snapshot.sessions[0];
  const who = resolve(s.id)!;
  assert.ok(who.name.length > 0);
  assert.ok(who.ids.includes(s.id));
  assert.equal(resolve('missing'), undefined);
});
