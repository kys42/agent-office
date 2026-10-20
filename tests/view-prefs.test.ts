import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from '../src/lib/demo.js';
import {
  HELPER_STACK_AT,
  helperSlots,
  layoutOffice,
  layoutRow,
} from '../src/shared/office-layout.js';
import {
  HELPER_UNFINISHED_MS,
  helperUnfinished,
  officeResidents,
} from '../src/shared/residents.js';
import { runtimeObservation } from '../src/shared/runtime.js';
import { deskSpeech, speechDot } from '../src/shared/speech.js';
import { CARD_READ_DWELL_MS, cardReadSettings } from '../src/shared/card-reads.js';
import { buildOfficeModel } from '../src/shared/office-model.js';
import { readWidths, readWidthsAt } from '../src/shared/panel-widths.js';
import { resetDue, viewPrefs } from '../src/shared/view-prefs.js';
import { isSettingsSection, settingsCategory } from '../src/shared/settings.js';
import type { OfficeNotice, Session, Snapshot } from '../src/shared/types.js';
import { setLocale } from '../src/shared/i18n/index.js';
process.env.AGENT_OFFICE_LOCALE = 'ko';
setLocale('ko');

// #228: more settings. Every preference is optional and its default is the old behaviour.
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
  resident: undefined,
  archived: false,
  pinned: false,
  hiddenAt: undefined,
  actor: undefined,
  attachedTo: undefined,
  relation: { kind: 'root', parentNativeId: null, source: 'fixture' },
  zone: 'office',
  project: 'team',
  cwd: '/tmp/team',
  branch: 'main',
  ...patch,
});
const helper = (i: number, parent = 'p', patch: Partial<Session> = {}) =>
  make(`${parent}:h${i}`, {
    status: 'work',
    attachedTo: parent,
    relation: { kind: 'subagent', parentNativeId: parent, source: 'fixture' },
    ...patch,
  });
const notice = (patch: Partial<OfficeNotice>): OfficeNotice => ({
  id: `n:${Math.random()}`,
  sessionId: 'a',
  eventId: 'e',
  kind: 'reply',
  phase: 'final',
  text: '끝났어요',
  at: now,
  receivedAt: now,
  version: 'v',
  seenAt: null,
  viewedAt: null,
  dismissedAt: null,
  resolvedAt: null,
  bootstrap: false,
  ...patch,
});

test('missing view preferences are the behaviour from before', () => {
  assert.deepEqual(viewPrefs(undefined), {
    tinyNames: true,
    tinyFinalDot: true,
    dockPill: 'subdued',
    dockPillResetAt: null,
    panelWidthsResetAt: null,
    helperDesks: true,
    helperStackAt: HELPER_STACK_AT,
    helperUnfinishedMs: HELPER_UNFINISHED_MS,
  });
  const set = viewPrefs({
    tinyNames: false,
    tinyFinalDot: false,
    dockPill: 'hover',
    dockPillResetAt: 5,
    helperDesks: false,
    helperStackAt: 2,
    helperRetainMinutes: 10,
  });
  assert.equal(set.tinyNames, false);
  assert.equal(set.tinyFinalDot, false);
  assert.equal(set.dockPill, 'hover');
  assert.equal(set.dockPillResetAt, 5);
  assert.equal(set.helperDesks, false);
  assert.equal(set.helperStackAt, 2);
  assert.equal(set.helperUnfinishedMs, 10 * 60_000);
  // Nonsense from an old or hand-edited store falls back to the defaults.
  const odd = viewPrefs({ dockPill: 'loud' as never, helperStackAt: 1, helperRetainMinutes: -1 });
  assert.equal(odd.dockPill, 'subdued');
  assert.equal(odd.helperStackAt, HELPER_STACK_AT);
  assert.equal(odd.helperUnfinishedMs, HELPER_UNFINISHED_MS);
});

test('the stack threshold is a parameter of the helper slots and both layouts', () => {
  const two = [helper(0), helper(1)];
  assert.deepEqual(
    helperSlots(two).map((s) => s.stack),
    [undefined, undefined],
  );
  assert.deepEqual(helperSlots(two, 2), [{ id: 'p:h0', stack: ['p:h0', 'p:h1'] }]);
  const four = [0, 1, 2, 3].map((i) => helper(i));
  assert.equal(helperSlots(four).length, 1, 'the default still stacks from four');
  assert.equal(helperSlots(four, 5).length, 4);
  // Below two a stack would hold one helper: never.
  assert.deepEqual(helperSlots([helper(0)], 1), [{ id: 'p:h0' }]);

  const sessions = [make('p', { officeSeat: 0 }), ...two];
  const office = (stackAt?: number) =>
    layoutOffice(sessions, 1.7, stackAt).projects[0].stations[0].children;
  assert.equal(office().length, 2);
  assert.deepEqual(
    office(2).map((c) => c.stack),
    [['p:h0', 'p:h1']],
  );
  const row = (stackAt?: number) => layoutRow(sessions, { stackAt }).zones[0].helpers;
  assert.equal(row().length, 2);
  assert.deepEqual(
    row(2).map((c) => c.stack),
    [['p:h0', 'p:h1']],
  );
  // One stacked desk is narrower than two.
  assert.ok(layoutRow(sessions, { stackAt: 2 }).width < layoutRow(sessions).width);
});

test('an unfinished helper keeps its desk for the chosen minutes', () => {
  const parent = make('p', { taskStartedAt: now });
  const quiet = (minutes: number) => {
    const at = now - minutes * 60_000;
    return make('c', {
      taskStartedAt: now - 120 * 60_000,
      status: 'ready',
      observedStatus: 'work',
      updatedAt: at,
      runtime: runtimeObservation('work', at, 'tool call'),
      relation: { kind: 'subagent', parentNativeId: 'p', source: 'fixture' },
    });
  };
  const hidden = (c: Session, unfinishedMs?: number) =>
    officeResidents([parent, c], now, { unfinishedMs }).hidden.map((s) => s.id);
  // Default: 30 minutes, as before.
  assert.deepEqual(hidden(quiet(29)), []);
  assert.deepEqual(hidden(quiet(31)), ['c']);
  // 10 minutes: gone sooner. 60: kept longer.
  assert.deepEqual(hidden(quiet(11), 10 * 60_000), ['c']);
  assert.deepEqual(hidden(quiet(9), 10 * 60_000), []);
  assert.deepEqual(hidden(quiet(45), 60 * 60_000), []);
  assert.deepEqual(hidden(quiet(61), 60 * 60_000), ['c']);
  assert.equal(helperUnfinished(quiet(100), now, 120 * 60_000), true);
  assert.equal(helperUnfinished(quiet(100), now), false);
  // The office model takes it from the preference.
  const snap = (helperRetainMinutes?: number): Snapshot => ({
    ...demoSnapshot(),
    sessions: [parent, quiet(45)],
    notices: [],
    preferences: { ...demoSnapshot().preferences, helperRetainMinutes },
  });
  assert.deepEqual(
    buildOfficeModel(snap(), now).hidden.map((s) => s.id),
    ['c'],
  );
  assert.deepEqual(buildOfficeModel(snap(60), now).hidden, []);
});

test('helper desks off: the scenes draw no helpers, the model still knows them', () => {
  const sessions = [make('p', { officeSeat: 0 }), helper(0), helper(1)];
  const snap = (helperDesks?: boolean): Snapshot => ({
    ...demoSnapshot(),
    sessions,
    notices: [],
    preferences: { ...demoSnapshot().preferences, helperDesks },
  });
  const on = buildOfficeModel(snap(), now);
  assert.deepEqual(
    on.scene.map((s) => s.id),
    ['p', 'p:h0', 'p:h1'],
  );
  const off = buildOfficeModel(snap(false), now);
  assert.deepEqual(
    off.scene.map((s) => s.id),
    ['p'],
  );
  // Still reachable: the colleague's view lists its helpers (the card's linked runs).
  assert.deepEqual(
    off.view('p')?.helpers.map((h) => h.session.id),
    ['p:h0', 'p:h1'],
  );
  assert.equal(off.view('p:h0')?.session.id, 'p:h0');
  assert.equal(layoutRow(off.scene).zones[0].helpers.length, 0);
});

test('tiny dot: final replies can be left out, calls and errors stay', () => {
  const dot = (s: Session, notices: OfficeNotice[], finals?: boolean) =>
    speechDot(s, deskSpeech(s, notices, 3, now), { finals });
  const idle = make('a');
  const reply = notice({});
  assert.equal(dot(idle, [reply])?.tone, 'reply');
  assert.equal(dot(idle, [reply], true)?.tone, 'reply');
  assert.equal(dot(idle, [reply], false), undefined);
  assert.equal(dot(make('a', { status: 'call' }), [], false)?.tone, 'attention');
  assert.equal(dot(idle, [notice({ kind: 'error', phase: undefined })], false)?.tone, 'error');
});

test('card reading: on or off, and after how long', () => {
  assert.deepEqual(cardReadSettings(undefined), { enabled: true, dwellMs: CARD_READ_DWELL_MS });
  assert.equal(CARD_READ_DWELL_MS, 1500);
  assert.deepEqual(cardReadSettings({ readOnOpen: false }), {
    enabled: false,
    dwellMs: CARD_READ_DWELL_MS,
  });
  assert.equal(cardReadSettings({ readDwellSeconds: 0 }).dwellMs, 0);
  assert.equal(cardReadSettings({ readDwellSeconds: 3 }).dwellMs, 3000);
  assert.equal(cardReadSettings({ readDwellSeconds: -1 }).dwellMs, CARD_READ_DWELL_MS);
});

test('a reset stamp forgets only what was saved before it', () => {
  assert.equal(resetDue(null, 0), false);
  assert.equal(resetDue(undefined, 100), false);
  assert.equal(resetDue(200, 100), true);
  assert.equal(resetDue(200, undefined), true);
  assert.equal(resetDue(200, 300), false, 'dragged again after the reset');
  // The column widths carry when they were dragged; old saves have none.
  const raw = JSON.stringify({ side: 250, dock: 400, at: 123 });
  assert.equal(readWidthsAt(raw), 123);
  assert.deepEqual(readWidths(raw), { side: 250, dock: 400 });
  assert.equal(readWidthsAt(JSON.stringify({ side: 250 })), 0);
  assert.equal(readWidthsAt('nope'), 0);
  assert.equal(readWidthsAt(null), 0);
});

test('the new settings sections deep-link into their categories', () => {
  assert.equal(settingsCategory('dock'), 'appearance');
  assert.equal(settingsCategory('panels'), 'appearance');
  assert.equal(settingsCategory('reading'), 'general');
  assert.equal(settingsCategory('helpers'), 'office');
  assert.ok(isSettingsSection('dock'));
});
