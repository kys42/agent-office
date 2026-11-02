import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPrompt,
  claudeCodeComposer,
  codexQueueComposer,
  composerFor,
  draftView,
  parseStyledScreen,
  type ComposerHost,
  type Screen,
} from '../desktop/composer/index.js';
import {
  DRAFT_POLL,
  draftIsLong,
  importDraft,
  nextDraftDelay,
  previewsTarget,
  sameDraftView,
} from '../src/lib/terminalDraft.js';
import { sameUnwrapped, settleSends, type PendingSend } from '../src/lib/pendingSends.js';
import type { TerminalTarget } from '../src/shared/types.js';

/**
 * The work card's preview of the terminal input box (#328): the adapter's reading and its
 * submit-as-is, and the renderer's pure rules. Screens are the bottom of `tmux capture-pane -p -e`
 * captures of Claude Code 2.1.296 (as in composer.test.ts), with neutral probe texts.
 */
const RULE = '─'.repeat(120);
const FOOT = '\x1b[39m  \x1b[38;5;220m⏵⏵ auto mode on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m';
const box = (...prompt: string[]) =>
  ['', `\x1b[38;5;244m${RULE}`, ...prompt, `\x1b[38;5;244m${RULE}`, '', FOOT, ''].join('\n');
const strip = (raw: string) => raw.replace(/\x1b\[[0-9;]*m/g, '');
const tmux = (raw: string, height = 40): Screen => ({ ...parseStyledScreen(raw), height });
const SCREENS = {
  /** Fresh session: the example placeholder, faint. */
  empty: box('\x1b[39m❯\xa0\x1b[2mTry "how do I log an error?"\x1b[0m'),
  /** After a reply: the prompt suggestion, faint. */
  suggestion: box('\x1b[39m❯\xa0\x1b[2mOne more alternative, one short sentence, no tools.\x1b[0m'),
  typed: box('\x1b[39m❯\xa0hello draft'),
  multi: box('\x1b[39m❯\xa0first line', '  second line', '  third line'),
  pasted: box('\x1b[39m❯\xa0note: [Pasted text #1 +12 lines] tail'),
  busyEmpty: box('\x1b[38;5;246m❯\xa0\x1b[39m'),
  queuedHint: box('\x1b[39m❯\xa0\x1b[2mPress up to edit queued messages\x1b[0m'),
  /** A permission prompt replaces the box. */
  permission: [
    `\x1b[38;5;244m${RULE}`,
    ' Bash command',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel · Tab to amend',
  ].join('\n'),
  /** `@` completions drawn above the box: Enter would pick a file. */
  completions: [
    '    ◇ src/app.ts',
    '    ◇ src/api.ts',
    `\x1b[38;5;244m${RULE}`,
    '\x1b[39m❯\xa0see @src/ap',
    `\x1b[38;5;244m${RULE}`,
    '',
  ].join('\n'),
};

/** A host showing one fixed screen per read (in order, the last repeating), counting Enter. */
function screens(...shown: (Screen | null)[]) {
  let reads = 0;
  let submitted = 0;
  const pressed: string[][] = [];
  const host: ComposerHost = {
    styled: true,
    read: async () => shown[Math.min(reads++, shown.length - 1)],
    wait: async () => {},
    press: async (keys) => {
      pressed.push([...keys]);
    },
    submit: async () => {
      submitted++;
    },
  };
  return { host, pressed, submitted: () => submitted, reads: () => reads };
}

test('The preview shows typed text only: empty, placeholder and suggestion are no draft', () => {
  const can = claudeCodeComposer.capabilities({ styled: true });
  const view = (raw: string) => draftView(classifyPrompt(tmux(raw)), 'Claude', can);
  assert.deepEqual(view(SCREENS.empty), { kind: 'empty' });
  assert.deepEqual(view(SCREENS.busyEmpty), { kind: 'empty' });
  assert.deepEqual(view(SCREENS.queuedHint), { kind: 'empty' });
  assert.deepEqual(view(SCREENS.suggestion), { kind: 'empty' });
  assert.deepEqual(view(SCREENS.typed), {
    kind: 'draft',
    text: 'hello draft',
    agent: 'Claude',
    submittable: true,
  });
  assert.deepEqual(view(SCREENS.multi), {
    kind: 'draft',
    text: 'first line\nsecond line\nthird line',
    agent: 'Claude',
    submittable: true,
  });
  // A collapsed paste stands for text not on screen: shown, never submitted from here.
  assert.deepEqual(view(SCREENS.pasted), {
    kind: 'draft',
    text: 'note: [Pasted text #1 +12 lines] tail',
    agent: 'Claude',
    submittable: false,
    partial: true,
  });
  // A box at the most rows the pane shows may hide its start: partial too.
  const five = box('\x1b[39m❯\xa0one', '  two', '  three', '  four', '  five');
  const tall = draftView(classifyPrompt(tmux(five, 20)), 'Claude', can);
  assert.equal(tall.kind === 'draft' && tall.partial, true);
  // A permission prompt or a completion list replaced the box: nothing to show or press.
  assert.deepEqual(view(SCREENS.permission), { kind: 'unknown', reason: 'closed' });
  assert.deepEqual(view(SCREENS.completions), { kind: 'unknown', reason: 'closed' });
  // Blank rows alone hold nothing to show.
  assert.deepEqual(view(box('\x1b[39m❯\xa0', '', '')), { kind: 'empty' });
  assert.deepEqual(draftView({ kind: 'unreadable' }, 'Claude', can), {
    kind: 'unknown',
    reason: 'unreadable',
  });
  // Orca reports the box apart (`draft`) and cannot tell a suggestion from typing: said so.
  const orca = (draft?: string) =>
    draftView(
      classifyPrompt({
        text: strip(box('❯')),
        ...(draft !== undefined && { composer: draft }),
      }),
      'Claude',
      claudeCodeComposer.capabilities({ styled: false }),
    );
  assert.deepEqual(orca(), { kind: 'empty' });
  assert.deepEqual(orca('run the tests'), {
    kind: 'draft',
    text: 'run the tests',
    agent: 'Claude',
    submittable: true,
    maybeSuggestion: true,
  });
});

test('Only Claude Code submits its box as is: Codex (a queue) and OpenClaw never', () => {
  assert.equal(claudeCodeComposer.capabilities({ styled: true }).canSubmitDraft, true);
  // Known before any terminal is found: main asks with no host.
  assert.equal(claudeCodeComposer.capabilities(null).canSubmitDraft, true);
  assert.ok(!codexQueueComposer.capabilities(null).canSubmitDraft);
  assert.equal(codexQueueComposer.submitDraft, undefined);
  assert.ok(!composerFor('openclaw').capabilities(null).canSubmitDraft);
  assert.equal(composerFor('openclaw').submitDraft, undefined);
});

test('Submitting as is presses Enter only while the box holds exactly that text', async () => {
  const typed = tmux(SCREENS.typed);
  const ok = screens(typed, typed);
  assert.deepEqual(
    await claudeCodeComposer.submitDraft!(ok.host, 'hello draft', async () => true),
    { status: 'submitted' },
  );
  assert.equal(ok.submitted(), 1);
  assert.deepEqual(ok.pressed, [], 'nothing typed or deleted');
  assert.equal(ok.reads(), 2, 'read, then again right before Enter');

  // Changed before the first look, or between the looks (edited, extended, sent there): no key.
  for (const shown of [
    [tmux(box('\x1b[39m❯\xa0hello draft!')), typed],
    [typed, tmux(box('\x1b[39m❯\xa0hello draft and more'))],
    [typed, tmux(SCREENS.empty)],
    [tmux(SCREENS.suggestion)],
  ]) {
    const changed = screens(...shown);
    const result = await claudeCodeComposer.submitDraft!(
      changed.host,
      'hello draft',
      async () => true,
    );
    assert.equal(result.status, 'changed');
    assert.equal(changed.submitted(), 0);
    assert.deepEqual(changed.pressed, []);
  }

  // A permission prompt or a menu replacing the box right before the key: Enter would pick.
  for (const closed of [SCREENS.permission, SCREENS.completions]) {
    const dialog = screens(typed, tmux(closed));
    assert.deepEqual(
      await claudeCodeComposer.submitDraft!(dialog.host, 'hello draft', async () => true),
      { status: 'refused', reason: 'closed' },
    );
    assert.equal(dialog.submitted(), 0);
  }

  // Claude stopped being the one at the terminal (paused, gone): no second look, no key.
  const lost = screens(typed, typed);
  assert.deepEqual(
    await claudeCodeComposer.submitDraft!(lost.host, 'hello draft', async () => false),
    { status: 'refused', reason: 'lost' },
  );
  assert.equal(lost.submitted(), 0);
  assert.equal(lost.reads(), 1);

  // Not all of it on screen: the person never saw what would go.
  const pasted = screens(tmux(SCREENS.pasted));
  assert.deepEqual(
    await claudeCodeComposer.submitDraft!(
      pasted.host,
      'note: [Pasted text #1 +12 lines] tail',
      async () => true,
    ),
    { status: 'refused', reason: 'partial' },
  );
  assert.equal(pasted.submitted(), 0);

  const blind = screens(null);
  assert.deepEqual(await claudeCodeComposer.submitDraft!(blind.host, 'x', async () => true), {
    status: 'refused',
    reason: 'unreadable',
  });
  assert.equal(blind.submitted(), 0);

  // A multi-line draft goes as it is: Enter only, nothing retyped, so its own spacing stays.
  const multi = tmux(SCREENS.multi);
  const lines = screens(multi, multi);
  assert.deepEqual(
    await claudeCodeComposer.submitDraft!(
      lines.host,
      'first line\nsecond line\nthird line',
      async () => true,
    ),
    { status: 'submitted' },
  );
  assert.equal(lines.submitted(), 1);
});

const target = (over: Partial<TerminalTarget> = {}): TerminalTarget => ({
  kind: 'tmux',
  label: 'work:1.0',
  status: 'idle',
  canSend: true,
  canFocus: true,
  ...over,
});

test('The card reads the box only for a terminal a send could reach', () => {
  assert.equal(previewsTarget(target()), true);
  assert.equal(previewsTarget(target({ kind: 'orca', status: 'busy' })), true);
  assert.equal(previewsTarget(null), false);
  assert.equal(previewsTarget(target({ canSend: false, status: 'waiting' })), false);
  assert.equal(previewsTarget(target({ kind: 'codex', queues: true })), false);
  assert.equal(previewsTarget(target({ kind: 'codex', desktop: true })), false);
  assert.equal(previewsTarget(target({ kind: 'orca', tabOnly: true })), false);
  assert.equal(previewsTarget(target({ remoteOffice: 'home' })), false);
});

test('Reads slow down while nothing changes and speed up on a change', () => {
  const draft = { kind: 'draft', text: 'a', agent: 'Claude', submittable: true } as const;
  assert.equal(nextDraftDelay(DRAFT_POLL.base, true, draft), DRAFT_POLL.base);
  let delay: number = DRAFT_POLL.base;
  for (let i = 0; i < 10; i++) delay = nextDraftDelay(delay, false, draft);
  assert.equal(delay, DRAFT_POLL.draft);
  delay = DRAFT_POLL.base;
  for (let i = 0; i < 10; i++) delay = nextDraftDelay(delay, false, { kind: 'empty' });
  assert.equal(delay, DRAFT_POLL.empty);
  for (let i = 0; i < 10; i++)
    delay = nextDraftDelay(delay, false, { kind: 'unknown', reason: 'closed' });
  assert.equal(delay, DRAFT_POLL.unknown);
  assert.equal(nextDraftDelay(DRAFT_POLL.unknown, true, draft), DRAFT_POLL.base);
  // Every interval stays at or above the base: never a tight loop.
  assert.ok(Object.values(DRAFT_POLL).every((ms) => ms >= 2500));

  assert.equal(sameDraftView(draft, { ...draft }), true);
  assert.equal(sameDraftView(draft, { ...draft, text: 'b' }), false);
  assert.equal(sameDraftView(draft, { ...draft, partial: true }), false);
  assert.equal(sameDraftView({ kind: 'empty' }, { kind: 'empty' }), true);
  assert.equal(
    sameDraftView({ kind: 'unknown', reason: 'closed' }, { kind: 'unknown', reason: 'sending' }),
    false,
  );
  assert.equal(sameDraftView(null, { kind: 'empty' }), false);
});

test('Taking the box text into the card keeps what was written there', () => {
  assert.equal(importDraft('', 'from terminal'), 'from terminal');
  assert.equal(importDraft('  \n', 'from terminal'), 'from terminal');
  assert.equal(importDraft('mine\n', 'from terminal'), 'mine\n\nfrom terminal');
  // Taken in twice: once.
  assert.equal(importDraft('mine\n\nfrom terminal', 'from terminal'), 'mine\n\nfrom terminal');
  assert.equal(draftIsLong('a\nb\nc'), false);
  assert.equal(draftIsLong('a\nb\nc\nd'), true);
  assert.equal(draftIsLong('x'.repeat(181)), true);
});

test('A receipt for text read off a wrapped box settles on the recorded request', () => {
  // The box split a word over two rows; the record has the words as typed.
  assert.ok(
    sameUnwrapped('please refactor the parser module', 'please refac\ntor the parser module'),
  );
  assert.ok(!sameUnwrapped('ok', 'ok then run tests'));
  const sent: PendingSend = {
    id: 'a',
    sessionId: 's1',
    text: 'please refac\ntor the parser module',
    at: 1000,
    wrapped: true,
  };
  const user = { id: 'u1', kind: 'user', text: 'please refactor the parser module', at: 2000 };
  assert.deepEqual(settleSends([sent], 's1', [user], new Set(), 3000), []);
  // Without the flag the same words wait (spacing inside words counts for typed sends).
  assert.equal(
    settleSends([{ ...sent, wrapped: undefined }], 's1', [user], new Set(), 3000).length,
    1,
  );
});
