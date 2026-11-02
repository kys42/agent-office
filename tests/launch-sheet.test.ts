import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from '../src/lib/demo.js';
import { m, setLocale } from '../src/shared/i18n/index.js';
import {
  chosenDestination,
  conversationChoices,
  destinationRows,
  draftIntent,
  duplicateView,
  firstResumable,
  forkDefaultName,
  messageProblem,
  nameProblem,
  keepsDestinations,
  placeOf,
  resultView,
  startLabel,
  broughtUp,
  type LaunchDraft,
} from '../src/shared/launch-sheet.js';
import { launchIntentSchema, type LaunchOptions } from '../src/shared/launch.js';
import type { Session } from '../src/shared/types.js';

setLocale('en');
const now = Date.now();
const make = (id: string, patch: Partial<Session> = {}): Session => ({
  ...demoSnapshot().sessions[0],
  id,
  nativeId: `native-${id}`,
  provider: 'claude',
  cwd: '/work/alpha',
  workspace: undefined,
  area: undefined,
  remote: undefined,
  attachedTo: undefined,
  archived: false,
  relation: { kind: 'root', parentNativeId: null, source: 'fixture' },
  updatedAt: now - 60_000,
  ...patch,
});
const draft = (patch: Partial<LaunchDraft> = {}): LaunchDraft => ({
  kind: 'new',
  at: 'a',
  provider: 'claude',
  name: 'Reviewer',
  forkName: 'Reviewer fork',
  message: '',
  ...patch,
});
const probe = (available: boolean, extra: object = {}) => ({ available, ...extra });
const options = (patch: Partial<LaunchOptions> = {}): LaunchOptions => ({
  destinations: [
    { id: 'orca', probe: probe(false, { reason: 'Orca is not running.' }) },
    { id: 'tmux', probe: probe(true, { command: 'tmux attach' }) },
    { id: 'terminalApp', probe: probe(true) },
    { id: 'copy', probe: probe(true) },
  ],
  default: 'tmux',
  duplicate: { state: 'none' },
  ...patch,
});

test('a draft becomes the core intent only once it is valid, and always passes its schema', () => {
  const fresh = draftIntent(draft({ message: 'look around' }));
  assert.deepEqual(fresh, {
    kind: 'new',
    at: 'a',
    provider: 'claude',
    name: 'Reviewer',
    initialMessage: 'look around',
  });
  // The options are asked without the message: it does not change where it can go.
  assert.equal((draftIntent(draft({ message: 'x' }), true) as any).initialMessage, '');
  assert.equal(draftIntent(draft({ name: 'bad/name' })), null);
  assert.equal(draftIntent(draft({ name: '' })), null);
  assert.equal(draftIntent(draft({ message: 'bell\x07' })), null);
  assert.equal(draftIntent(draft({ kind: 'resume' })), null, 'resume needs a conversation');
  assert.deepEqual(draftIntent(draft({ kind: 'resume', session: 's1', name: 'bad/' })), {
    kind: 'resume',
    session: 's1',
  });
  assert.equal(draftIntent(draft({ kind: 'fork', session: 's1', forkName: '' })), null);
  const fork = draftIntent(draft({ kind: 'fork', session: 's1', forkName: '  Copy ' }));
  assert.deepEqual(fork, { kind: 'fork', session: 's1', name: 'Copy', initialMessage: '' });
  for (const intent of [fresh, fork, draftIntent(draft({ kind: 'resume', session: 's1' }))])
    assert.equal(launchIntentSchema.safeParse(intent).success, true);
  assert.equal(nameProblem('ok name_1-2'), '');
  assert.equal(nameProblem('x'.repeat(41)), m().tmux.invalidName);
  assert.equal(messageProblem('x'.repeat(4001)), m().tmux.invalidMessage);
});

test('a fork is prefilled with a valid name of at most 40 characters', () => {
  assert.equal(forkDefaultName('Reviewer'), 'Reviewer fork');
  assert.equal(forkDefaultName('a/b: c.d!'), 'a b c d fork');
  assert.equal(forkDefaultName('!!!'), 'fork');
  const long = forkDefaultName('가'.repeat(60));
  assert.equal([...long].length, 40);
  assert.equal(nameProblem(long), '');
  setLocale('ko');
  try {
    assert.equal(forkDefaultName('개발 동료'), '개발 동료 복제');
  } finally {
    setLocale('en');
  }
});

test('"+" offers the project\'s office conversations first, then its lounge and archive', () => {
  const office = make('o1', { updatedAt: now - 5_000 });
  const older = make('o2', { updatedAt: now - 50_000 });
  const helper = make('h', { relation: { kind: 'subagent', parentNativeId: 'x', source: 'f' } });
  const lounge = make('w', { updatedAt: now - 1_000 });
  const archived = make('ar', { archived: true });
  const claw = make('c', { provider: 'openclaw' });
  const elsewhere = make('e', { cwd: '/work/beta', project: 'beta' });
  const zones = { waiting: [lounge, elsewhere, office], archive: [archived, claw] };
  const { list, hidden } = conversationChoices(zones, [older, office, helper]);
  assert.deepEqual(
    list.map((c) => [c.session.id, c.zone, c.block]),
    [
      ['o1', 'office', undefined],
      ['o2', 'office', undefined],
      ['w', 'waiting', undefined],
      ['ar', 'archive', undefined],
      ['c', 'archive', 'provider'],
    ],
  );
  assert.equal(hidden, 0);
  assert.equal(firstResumable([{ session: claw, zone: 'archive', block: 'provider' }]), undefined);
  assert.equal(firstResumable(list), 'o1');
  // Without the office's zones (a view that cannot bring anyone back) only the office.
  assert.deepEqual(
    conversationChoices(undefined, [office]).list.map((c) => c.session.id),
    ['o1'],
  );
});

test('the duplicate check: running only goes there, an unconfirmed start only waits', () => {
  assert.deepEqual(duplicateView(undefined), { notice: '', tone: 'none', blocks: false });
  const running = duplicateView({ state: 'running', where: 'orca' });
  assert.equal(running.blocks, true);
  assert.equal(running.go, 'jump');
  assert.match(running.notice, /already running in Orca/);
  const pendingOrca = duplicateView({ state: 'open', where: 'orca', pending: true });
  assert.equal(pendingOrca.blocks, true);
  assert.equal(pendingOrca.reveal, true);
  assert.equal(pendingOrca.go, undefined);
  const pendingTerminal = duplicateView({ state: 'open', where: 'other', pending: true });
  assert.equal(pendingTerminal.blocks, true);
  assert.equal(pendingTerminal.reveal, false);
  assert.equal(pendingTerminal.notice, m().launch.terminalAppUncertain);
  // Just handed over: it may still be starting, a start is cautioned, not blocked.
  const starting = duplicateView({ state: 'open', where: 'orca', pending: true, starting: true });
  assert.equal(starting.blocks, false);
  assert.equal(starting.go, 'orca-tab');
  assert.equal(starting.notice, m().launch.starting('Orca'));
  assert.equal(duplicateView({ state: 'open', where: 'tmux' }).go, 'tmux');
  // Where its place cannot be opened on this platform, nothing to go to (a caution only).
  assert.equal(duplicateView({ state: 'open', where: 'tmux' }, []).go, undefined);
  assert.equal(duplicateView({ state: 'open', where: 'orca' }, ['tmux']).go, undefined);
  assert.equal(duplicateView({ state: 'open', where: 'other' }).go, undefined);
  assert.equal(duplicateView({ state: 'unknown' }).blocks, false);
});

test('destinations show availability and the reason; the pick wins while it is available', () => {
  const rows = destinationRows(options({ remembered: 'terminalApp' }));
  assert.deepEqual(
    rows.map((r) => [r.id, r.available, r.badge, r.reason, r.remembered]),
    [
      ['orca', false, 'Not available', 'Orca is not running.', false],
      ['tmux', true, 'Available', '', false],
      ['terminalApp', true, 'Available', '', true],
      ['copy', true, 'Available', '', false],
    ],
  );
  assert.equal(
    destinationRows(
      options({ destinations: [{ id: 'tmux', probe: probe(true, { running: true }) }] }),
    )[0].badge,
    'Running',
  );
  assert.ok(destinationRows(null).every((r) => !r.available && r.badge === 'Checking…'));
  assert.equal(chosenDestination(options(), null), 'tmux');
  assert.equal(chosenDestination(options(), 'copy'), 'copy');
  assert.equal(chosenDestination(options(), 'orca'), 'tmux', 'an unavailable pick falls back');
  assert.equal(chosenDestination(null, 'orca'), 'orca');
  assert.equal(startLabel('copy'), 'Copy the command');
  assert.equal(startLabel('orca'), 'Start in Orca');
  assert.equal(startLabel('tmux', true), 'Start in tmux anyway');
  assert.deepEqual((['orca', 'tmux', 'terminalApp', 'copy'] as const).map(placeOf), [
    'orca',
    'tmux',
    'other',
    null,
  ]);
});

test('results: done closes, running opens, uncertain waits, refusals go there or elsewhere', () => {
  assert.deepEqual(resultView({ state: 'launched', destination: 'orca', message: 'Opened' }), {
    close: true,
    toast: 'Opened',
  });
  assert.deepEqual(resultView({ state: 'copied', destination: 'copy', message: '' }), {
    close: true,
    toast: m().launch.copied,
  });
  assert.equal(resultView({ state: 'cancelled', destination: 'tmux' }), null);
  // A tmux start nothing opened runs out of sight: its way back in stays on the sheet.
  const tmuxStarted = {
    state: 'launched',
    destination: 'tmux',
    message: 'Started in tmux.',
    command: 'tmux a',
  } as const;
  assert.deepEqual(resultView(tmuxStarted, null, ['tmux']), {
    close: false,
    tone: 'info',
    text: 'Started in tmux.',
    actions: [{ kind: 'open-terminal' }, { kind: 'copy-command', command: 'tmux a' }],
  });
  // Linux: no Terminal to open it in, only the attach command.
  assert.deepEqual(resultView(tmuxStarted, null, []), {
    close: false,
    tone: 'info',
    text: 'Started in tmux.',
    actions: [{ kind: 'copy-command', command: 'tmux a' }],
  });
  assert.deepEqual(resultView({ ...tmuxStarted, command: undefined }, null, []), {
    close: true,
    toast: 'Started in tmux.',
  });
  assert.deepEqual(resultView({ state: 'opened', destination: 'tmux', message: 'Opened' }), {
    close: true,
    toast: 'Opened',
  });
  assert.deepEqual(
    resultView({ state: 'running', destination: 'tmux', message: 'm', command: 'tmux a' }),
    {
      close: false,
      tone: 'info',
      text: 'm',
      actions: [{ kind: 'open-terminal' }, { kind: 'copy-command', command: 'tmux a' }],
    },
  );
  const orca = resultView({ state: 'uncertain', destination: 'orca', message: '' });
  assert.deepEqual(orca, {
    close: false,
    tone: 'info',
    text: m().tmux.orcaUncertain,
    actions: [{ kind: 'reveal' }],
  });
  // Elsewhere only the hint: never another place, never Open Orca.
  for (const [destination, text] of [
    ['tmux', m().launch.tmuxUncertain],
    ['terminalApp', m().launch.terminalAppUncertain],
  ] as const)
    assert.deepEqual(resultView({ state: 'uncertain', destination, message: '' }), {
      close: false,
      tone: 'info',
      text,
      actions: [],
    });
  const runs = resultView({
    state: 'refused',
    destination: 'orca',
    reason: 'runs',
    duplicate: { state: 'running', where: 'tmux' },
  });
  assert.deepEqual(runs && !runs.close && runs.actions, [{ kind: 'go', go: 'jump' }]);
  const waits = resultView({
    state: 'refused',
    destination: 'tmux',
    reason: 'pending',
    duplicate: { state: 'open', where: 'orca', pending: true },
  });
  assert.deepEqual(waits && !waits.close && waits.actions, [{ kind: 'reveal' }]);
  // A failed re-check suggests the other destinations still available (not the failed one).
  const failed = resultView(
    { state: 'refused', destination: 'tmux', reason: 'tmux missing' },
    options({
      destinations: [
        { id: 'orca', probe: probe(true) },
        { id: 'tmux', probe: probe(true) },
        { id: 'terminalApp', probe: probe(false) },
        { id: 'copy', probe: probe(true) },
      ],
    }),
  );
  assert.deepEqual(failed, {
    close: false,
    tone: 'error',
    text: 'tmux missing',
    actions: [
      { kind: 'suggest', destination: 'orca' },
      { kind: 'suggest', destination: 'copy' },
    ],
  });
  // "Where" stays only beside suggestions: never under an unconfirmed or running start.
  assert.equal(keepsDestinations(failed), true);
  assert.equal(keepsDestinations(orca), false);
  assert.equal(keepsDestinations(runs), false);
  assert.equal(keepsDestinations(null), true);
  assert.equal(broughtUp({ state: 'uncertain', destination: 'orca', message: '' }), true);
  assert.equal(broughtUp({ state: 'copied', destination: 'copy', message: '' }), false);
  assert.equal(broughtUp({ state: 'refused', destination: 'copy', reason: '' }), false);
});
