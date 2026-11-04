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

test('The preview shows typed text as a draft: empty, placeholder and suggestion are none', () => {
  const can = claudeCodeComposer.capabilities({ styled: true });
  const view = (raw: string) => draftView(classifyPrompt(tmux(raw)), 'Claude', can);
  assert.deepEqual(view(SCREENS.empty), { kind: 'empty' });
  assert.deepEqual(view(SCREENS.busyEmpty), { kind: 'empty' });
  assert.deepEqual(view(SCREENS.queuedHint), { kind: 'empty' });
  // The suggestion is shown as the agent's, not as a draft (#338).
  assert.deepEqual(view(SCREENS.suggestion), {
    kind: 'suggestion',
    text: 'One more alternative, one short sentence, no tools.',
    agent: 'Claude',
    submittable: true,
  });
  assert.deepEqual(view(SCREENS.typed), {
    kind: 'draft',
    text: 'hello draft',
    agent: 'Claude',
    submittable: true,
    logical: 'hello draft',
  });
  assert.deepEqual(view(SCREENS.multi), {
    kind: 'draft',
    text: 'first line\nsecond line\nthird line',
    agent: 'Claude',
    submittable: true,
    logical: 'first line\nsecond line\nthird line',
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
    logical: 'run the tests',
    maybeSuggestion: true,
    // One line known whole: sent through the accept key (#338).
    acceptsSuggestion: true,
  });
  // A paste placeholder (Claude Code's exact form) only a paste puts there: shown in part, and
  // never called a suggestion (#333). Look-alikes are not that form: the caveat stays.
  for (const draft of [
    '[Pasted text #4 +6 lines]',
    '[Pasted text #2]',
    'see [Image #1]',
    'a [...Truncated text #3 +9 lines...] b',
  ])
    assert.deepEqual(
      orca(draft),
      { kind: 'draft', text: draft, agent: 'Claude', submittable: false, partial: true },
      draft,
    );
  for (const draft of ['[Pasted text #0 +6 lines]', '[Pasted text #4 +0 lines]', '[Pasted text]'])
    assert.equal((orca(draft) as { maybeSuggestion?: boolean }).maybeSuggestion, true, draft);
  // Orca drawing the box on screen (no `draft`): the same.
  const drawnBox = draftView(
    classifyPrompt({ text: strip(box('❯\xa0[Pasted text #4 +6 lines]')) }),
    'Claude',
    claudeCodeComposer.capabilities({ styled: false }),
  );
  assert.equal(drawnBox.kind === 'draft' && !drawnBox.maybeSuggestion && drawnBox.partial, true);
});

test('Only rows that cannot be the box wrapping are taken as typed lines', () => {
  const can = claudeCodeComposer.capabilities({ styled: true });
  const view = (...rows: string[]) => {
    const shown = draftView(classifyPrompt(tmux(box(...rows))), 'Claude', can);
    assert.equal(shown.kind, 'draft');
    return shown.kind === 'draft' ? shown : null;
  };
  // Short rows far from the edge: every break was typed, and indentation past the box's own
  // two spaces is the text's (it is lost from `text`, which trims each row).
  const code = view('\x1b[39m❯\xa0if (ok) {', '    run();', '  }', '', '  done');
  // Shown (and handed back to [Send as is]) as drawn: the indent past the box's own stays.
  assert.equal(code?.text, 'if (ok) {\n  run();\n}\n\ndone');
  assert.equal(code?.logical, 'if (ok) {\n  run();\n}\n\ndone');
  // A row filled to the edge then a URL: the box may have split it. Shown, never rebuilt.
  const url = 'https://example.com/' + 'a'.repeat(140);
  const wrapped = view(`\x1b[39m❯\xa0see ${url.slice(0, 112)}`, `  ${url.slice(112)}`);
  assert.equal(wrapped?.logical, undefined);
  assert.equal(wrapped?.submittable, true, 'Enter alone still sends it as typed');
  // A long row of words followed by a word that would have fitted no more: a possible wrap.
  const words = Array.from({ length: 22 }, (_, i) => `word${i}`).join(' ');
  assert.equal(view(`\x1b[39m❯\xa0${words}`, '  tail')?.logical, undefined);
  // Korean counts two cells a character: 56 of them leave no room on a 120-wide box.
  assert.equal(view(`\x1b[39m❯\xa0${'가'.repeat(56)}`, '  나')?.logical, undefined);
  assert.equal(view(`\x1b[39m❯\xa0${'가'.repeat(20)}`, '  나')?.logical, `${'가'.repeat(20)}\n나`);
  // A row not drawn after the box's indent is no row of the text: not rebuilt.
  assert.equal(view('\x1b[39m❯\xa0one', 'two')?.logical, undefined);
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
    { status: 'submitted', state: classifyPrompt(typed) },
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
    { status: 'submitted', state: classifyPrompt(multi) },
  );
  assert.equal(lines.submitted(), 1);
});

test('An indent changed after the preview is a change: no Enter (Python, YAML)', async () => {
  const shown = (indent: string) =>
    tmux(box('\x1b[39m❯\xa0def total(xs):', `  ${indent}return sum(xs)`));
  const before = shown('    ');
  const can = claudeCodeComposer.capabilities({ styled: true });
  const preview = draftView(classifyPrompt(before), 'Claude', can);
  assert.equal(preview.kind === 'draft' && preview.text, 'def total(xs):\n    return sum(xs)');
  // The trimmed rows read the same either way: only the untrimmed form tells them apart.
  const after = shown('  ');
  assert.equal(
    (classifyPrompt(after) as { text: string }).text,
    (classifyPrompt(before) as { text: string }).text,
  );
  const expected = preview.kind === 'draft' ? preview.text : '';
  for (const looks of [
    [after, after],
    [before, after],
  ]) {
    const host = screens(...looks);
    const result = await claudeCodeComposer.submitDraft!(host.host, expected, async () => true);
    assert.equal(result.status, 'changed');
    assert.equal(host.submitted(), 0);
  }
  // Unchanged: it goes, and the last look before Enter says what went, as typed.
  const same = screens(before, before);
  const went = await claudeCodeComposer.submitDraft!(same.host, expected, async () => true);
  assert.equal(went.status, 'submitted');
  assert.equal(
    went.status === 'submitted' && 'logical' in went.state && went.state.logical,
    'def total(xs):\n    return sum(xs)',
  );
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

/**
 * Claude Code's prompt suggestion (#338), as 2.1.316 draws it: faint after `❯ `, and with the
 * terminal focused the cursor on its first character (`invert(t[0]) + dim(t.slice(1))`), cut short
 * with `…` when it does not fit its one row.
 */
const SUGGESTED = {
  /** Unfocused: all of it faint. */
  faint: box('\x1b[39m❯\xa0\x1b[2m커밋해줘\x1b[0m'),
  /** Focused: the cursor's cell (inverse, not faint) first, the rest faint. */
  cursor: box('\x1b[39m❯\xa0\x1b[7m커\x1b[27m\x1b[2m밋해줘\x1b[0m'),
  /** The terminal's own cursor: the first character drawn plain. */
  plainFirst: box('\x1b[39m❯\xa0커\x1b[2m밋해줘\x1b[0m'),
  /** Too long for its row: cut short. */
  cut: box(
    '\x1b[39m❯\xa0\x1b[7mR\x1b[27m\x1b[2mun the full test suite and then summarize every…\x1b[0m',
  ),
  /** Typed, the cursor at its start: plain all along. */
  typedCursor: box('\x1b[39m❯\xa0\x1b[7m커\x1b[27m밋해줘'),
  /** Two plain characters before faint ones: not the cursor's cell alone. */
  typedTwo: box('\x1b[39m❯\xa0커밋\x1b[2m해줘\x1b[0m'),
};

test("A suggestion told by its style is shown as the agent's suggestion, never as a draft", () => {
  const tmuxCan = claudeCodeComposer.capabilities({ styled: true });
  assert.equal(tmuxCan.canSubmitSuggestion, true);
  const view = (raw: string) => draftView(classifyPrompt(tmux(raw)), 'Claude', tmuxCan);
  for (const raw of [SUGGESTED.faint, SUGGESTED.cursor, SUGGESTED.plainFirst]) {
    assert.deepEqual(classifyPrompt(tmux(raw)), {
      kind: 'suggestion',
      text: '커밋해줘',
      whole: true,
    });
    assert.deepEqual(view(raw), {
      kind: 'suggestion',
      text: '커밋해줘',
      agent: 'Claude',
      submittable: true,
    });
  }
  // Cut short on screen: shown, never sent from here (Tab would take more than was seen).
  assert.deepEqual(view(SUGGESTED.cut), {
    kind: 'suggestion',
    text: 'Run the full test suite and then summarize every…',
    agent: 'Claude',
    submittable: false,
  });
  // Typed text is never faint: the cursor on its first cell keeps it a draft.
  assert.equal(classifyPrompt(tmux(SUGGESTED.typedCursor)).kind, 'draft');
  assert.equal(classifyPrompt(tmux(SUGGESTED.typedTwo)).kind, 'draft');
  // The example placeholder with the cursor on it is still an empty box.
  assert.deepEqual(view(box('\x1b[39m❯\xa0\x1b[7mT\x1b[27m\x1b[2mry "fix lint errors"\x1b[0m')), {
    kind: 'empty',
  });
  // One only inferred (no styles, it survived the deletion keys) is not shown as one.
  assert.deepEqual(
    draftView({ kind: 'suggestion', text: '커밋해줘', inferred: true }, 'Claude', tmuxCan),
    { kind: 'empty' },
  );
  // Orca: its `draft` holds the suggestion exactly as typing (1.4.216 falls back to the raw
  // characters after the cursor when none is undimmed): the caveat, and one line known whole is
  // sent through the accept key (a suggestion is taken in, typed text left as it is).
  const orcaCan = claudeCodeComposer.capabilities({ styled: false });
  assert.equal(orcaCan.canSubmitSuggestion, true);
  const orcaView = (composer: string, text = strip(box('❯'))) =>
    draftView(classifyPrompt({ text, composer }), 'Claude', orcaCan);
  assert.deepEqual(orcaView('커밋해줘'), {
    kind: 'draft',
    text: '커밋해줘',
    agent: 'Claude',
    submittable: true,
    logical: '커밋해줘',
    maybeSuggestion: true,
    acceptsSuggestion: true,
  });
  // More than one line is never a suggestion: [Send as is] alone (Enter only), as before.
  const lines = orcaView('첫 줄\n둘째 줄');
  assert.equal(lines.kind === 'draft' && lines.submittable, true);
  assert.equal(lines.kind === 'draft' && lines.acceptsSuggestion, undefined);
  // tmux tells a draft from the suggestion: never sent through the accept key.
  const typedView = draftView(classifyPrompt(tmux(SCREENS.typed)), 'Claude', tmuxCan);
  assert.equal(typedView.kind === 'draft' && typedView.acceptsSuggestion, undefined);
});

test('A task list above the box no longer makes a short one-line box partial', () => {
  const orcaCan = claudeCodeComposer.capabilities({ styled: false });
  const tmuxCan = claudeCodeComposer.capabilities({ styled: true });
  const TASKS_ABOVE = ['  ✔ 테스트 돌리기', '  ◼ 커밋하기', '  ☐ 푸시하기'];
  const TASK_FOOT = '\x1b[39m  esc to interrupt · ctrl+t to hide tasks';
  const withTasks = (...prompt: string[]) =>
    [
      ...TASKS_ABOVE,
      '',
      `\x1b[38;5;244m${RULE}`,
      ...prompt,
      `\x1b[38;5;244m${RULE}`,
      '',
      TASK_FOOT,
      '',
    ].join('\n');
  // Orca reports the text apart and leaves the marker row only (its tail drops blank rows): the
  // reported Orca case (#338) — "커밋해줘" under a task list read as not all visible.
  const orca = draftView(
    classifyPrompt({ text: strip(withTasks('❯')).replace(/\n\n/g, '\n'), composer: '커밋해줘' }),
    'Claude',
    orcaCan,
  );
  assert.equal(orca.kind === 'draft' && !orca.partial && orca.acceptsSuggestion, true);
  // tmux: one or two rows between the rules is never a capped box (it shows 3 at least).
  for (const rows of [['\x1b[39m❯\xa0hello draft'], ['\x1b[39m❯\xa0one', '  two']]) {
    const shown = draftView(classifyPrompt(tmux(withTasks(...rows), 20)), 'Claude', tmuxCan);
    assert.equal(shown.kind === 'draft' && !shown.partial && shown.submittable, true, rows[0]);
  }
  // Three rows or more beside a task list may be a capped box: still partial.
  const three = draftView(
    classifyPrompt(tmux(withTasks('\x1b[39m❯\xa0one', '  two', '  three'))),
    'Claude',
    tmuxCan,
  );
  assert.equal(three.kind === 'draft' && three.partial, true);
  // Text that may need more rows than Orca surely shows stays partial with or without tasks.
  const long = draftView(
    classifyPrompt({
      text: strip(withTasks('❯')).replace(/\n\n/g, '\n'),
      composer: '가'.repeat(120),
    }),
    'Claude',
    orcaCan,
  );
  assert.equal(long.kind === 'draft' && long.partial && long.maybeSuggestion, true);
});

/**
 * Claude Code's prompt as far as [Send suggestion] goes (2.1.316): a suggestion shows (faint,
 * the cursor on its first cell) while the box is empty; Right (like Tab) with the box empty takes
 * all of it in as typed text; Right with text typed only moves the cursor (Tab there would run
 * completion: recorded); Enter submits what is typed, and on an empty box submits nothing.
 * `styled: false` reads it as Orca does: no styles, the text apart in `draft` either way.
 */
function promptSim(
  suggestion: string,
  opts: { styled?: boolean; typed?: string; onAccept?: (shown: string) => string } = {},
) {
  let typed = opts.typed ?? '';
  let shown: string | null = suggestion;
  const keys: string[][] = [];
  const submitted: string[] = [];
  const completions: string[] = [];
  const render = (): Screen => {
    if (opts.styled === false) {
      const text = typed || shown || '';
      return { text: strip(box('❯')), ...(text && { composer: text }) };
    }
    const raw = typed
      ? box(`\x1b[39m❯\xa0${typed}`)
      : shown
        ? box(`\x1b[39m❯\xa0\x1b[7m${shown[0]}\x1b[27m\x1b[2m${shown.slice(1)}\x1b[0m`)
        : box('\x1b[39m❯\xa0');
    return tmux(raw);
  };
  const host: ComposerHost = {
    styled: opts.styled !== false,
    read: async () => render(),
    wait: async () => {},
    press: async (pressed) => {
      keys.push([...pressed]);
      for (const key of pressed as string[]) {
        if (key === 'Tab' && typed) completions.push(typed);
        if (key !== 'Right' && key !== 'Tab') continue;
        if (!typed && shown) typed = opts.onAccept ? opts.onAccept(shown) : shown;
      }
    },
    submit: async () => {
      if (!typed) return;
      submitted.push(typed);
      typed = '';
      shown = null;
    },
  };
  return {
    host,
    keys,
    submitted,
    completions,
    set: (next: { typed?: string; shown?: string | null }) => {
      if (next.typed !== undefined) typed = next.typed;
      if (next.shown !== undefined) shown = next.shown;
    },
  };
}

test('Send suggestion: Right while the box holds just it, then Enter once it holds exactly it', async () => {
  const sim = promptSim('커밋해줘');
  const result = await claudeCodeComposer.submitSuggestion!(sim.host, '커밋해줘', async () => true);
  assert.equal(result.status, 'submitted');
  assert.deepEqual(sim.keys, [['Right']], 'the accept key only; Enter is the submit key');
  assert.deepEqual(sim.submitted, ['커밋해줘']);
  assert.deepEqual(sim.completions, []);
});

test('Orca: one line that may be the suggestion goes whichever it is, exactly as previewed', async () => {
  // The suggestion: Right takes it in, Enter sends it.
  const suggested = promptSim('커밋해줘', { styled: false });
  const a = await claudeCodeComposer.submitSuggestion!(
    suggested.host,
    '커밋해줘',
    async () => true,
  );
  assert.equal(a.status, 'submitted');
  assert.deepEqual(suggested.keys, [['Right']]);
  assert.deepEqual(suggested.submitted, ['커밋해줘']);
  // Typed text that reads the same: Right only moves the cursor, Enter sends it as is.
  const typed = promptSim('다른 추천', { styled: false, typed: '커밋해줘' });
  const b = await claudeCodeComposer.submitSuggestion!(typed.host, '커밋해줘', async () => true);
  assert.equal(b.status, 'submitted');
  assert.deepEqual(typed.keys, [['Right']]);
  assert.deepEqual(typed.submitted, ['커밋해줘']);
  assert.deepEqual(typed.completions, [], 'no Tab: no completion on typed text');
  // Something else after the key (a suggestion that was cut, a cursor glyph): no Enter.
  const other = promptSim('커밋해줘', { styled: false, onAccept: (s) => `${s} 하고 푸시` });
  const c = await claudeCodeComposer.submitSuggestion!(other.host, '커밋해줘', async () => true);
  assert.equal(c.status === 'changed' && c.accepted, true);
  assert.deepEqual(other.submitted, []);
  // Other text before the key, or more than one line: nothing pressed.
  const moved = promptSim('커밋해줘', { styled: false, typed: '커밋해줘!' });
  assert.equal(
    (await claudeCodeComposer.submitSuggestion!(moved.host, '커밋해줘', async () => true)).status,
    'changed',
  );
  assert.deepEqual(moved.keys, []);
  const multi = promptSim('', { styled: false, typed: '한 줄\n두 줄' });
  assert.deepEqual(
    await claudeCodeComposer.submitSuggestion!(multi.host, '한 줄\n두 줄', async () => true),
    { status: 'refused', reason: 'unsupported' },
  );
  assert.deepEqual(multi.keys, []);
  // Not known whole: refused before any key.
  const long = '가'.repeat(120);
  const partial = promptSim('', { styled: false, typed: long });
  assert.deepEqual(
    await claudeCodeComposer.submitSuggestion!(partial.host, long, async () => true),
    { status: 'refused', reason: 'partial' },
  );
  assert.deepEqual(partial.keys, []);
});

test('Send suggestion presses nothing more on any mismatch', async () => {
  const send = (sim: ReturnType<typeof promptSim>, text = '커밋해줘', go = async () => true) =>
    claudeCodeComposer.submitSuggestion!(sim.host, text, go);
  // The key took in something else than was shown (a cursor glyph drawn over its first character,
  // someone typing meanwhile): no Enter, and it says the key went in.
  const other = promptSim('커밋해줘', { onAccept: (s) => `${s} 그리고 푸시` });
  const moved = await send(other);
  assert.equal(moved.status, 'changed');
  assert.equal(moved.status === 'changed' && moved.accepted, true);
  assert.deepEqual(other.keys, [['Right']]);
  assert.deepEqual(other.submitted, []);

  // The key took nothing in (another key mode): the suggestion stays, no Enter.
  const stuck = promptSim('커밋해줘', { onAccept: () => '' });
  const still = await send(stuck);
  assert.equal(still.status === 'changed' && still.accepted, true);
  assert.deepEqual(stuck.submitted, []);

  // tmux: text typed in the box (a draft, told by its style): no key at all.
  const typed = promptSim('커밋해줘', { typed: '커밋해줘' });
  const draft = await send(typed);
  assert.equal(draft.status, 'changed');
  assert.ok(!(draft.status === 'changed' && draft.accepted));
  assert.deepEqual(typed.keys, []);

  // A different suggestion now, or none: no key.
  for (const shown of ['푸시해줘', null]) {
    const sim = promptSim('커밋해줘');
    sim.set({ shown });
    assert.equal((await send(sim)).status, 'changed');
    assert.deepEqual(sim.keys, []);
  }

  // Typed between the two looks: the second one stops it before the key.
  const racing = promptSim('커밋해줘');
  let asked = 0;
  const raced = await send(racing, '커밋해줘', async () => {
    if (asked++ === 0) racing.set({ typed: 'ㅋ' });
    return true;
  });
  assert.equal(raced.status, 'changed');
  assert.deepEqual(racing.keys, []);

  // Claude stopped being there before the key; or after it, before Enter.
  const lost = promptSim('커밋해줘');
  assert.deepEqual(await send(lost, '커밋해줘', async () => false), {
    status: 'refused',
    reason: 'lost',
  });
  assert.deepEqual(lost.keys, []);
  const late = promptSim('커밋해줘');
  let calls = 0;
  assert.deepEqual(await send(late, '커밋해줘', async () => calls++ === 0), {
    status: 'refused',
    reason: 'lost',
    accepted: true,
  });
  assert.deepEqual(late.keys, [['Right']]);
  assert.deepEqual(late.submitted, []);

  // Cut short on screen: refused before any key.
  const cut = promptSim('Run the full test suite and then summarize every…');
  assert.deepEqual(await send(cut, 'Run the full test suite and then summarize every…'), {
    status: 'refused',
    reason: 'partial',
  });
  assert.deepEqual(cut.keys, []);
});

test('A suggestion view rests like a draft and compares by its text', () => {
  const s = { kind: 'suggestion', text: '커밋해줘', agent: 'Claude', submittable: true } as const;
  assert.equal(sameDraftView(s, { ...s }), true);
  assert.equal(sameDraftView(s, { ...s, text: '푸시해줘' }), false);
  assert.equal(sameDraftView(s, { ...s, submittable: false }), false);
  assert.equal(
    sameDraftView(s, { kind: 'draft', text: '커밋해줘', agent: 'Claude', submittable: true }),
    false,
  );
  let delay: number = DRAFT_POLL.base;
  for (let i = 0; i < 10; i++) delay = nextDraftDelay(delay, false, s);
  assert.equal(delay, DRAFT_POLL.draft);
});
