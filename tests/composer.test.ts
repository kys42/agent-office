import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPrompt,
  containsLines,
  drawn,
  mergeBackup,
  claudeCodeComposer,
  codexQueueComposer,
  composerFor,
  parseStyledScreen,
  type ComposerHost,
  type Screen,
} from '../desktop/composer/index.js';
import { maxBoxRows, oneStretchGone } from '../desktop/composer/claude-code.js';

/**
 * The bottom of real `tmux capture-pane -p -e` captures of Claude Code 2.1.296 (120×40 pane),
 * trimmed to the prompt box; every text is a neutral probe text.
 */
const RULE = '─'.repeat(120);
const FOOT = '\x1b[39m  \x1b[38;5;220m⏵⏵ auto mode on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m';
const box = (...prompt: string[]) =>
  ['', `\x1b[38;5;244m${RULE}`, ...prompt, `\x1b[38;5;244m${RULE}`, '', FOOT, ''].join('\n');
const FIXTURES = {
  /** Fresh session: the example placeholder, faint. Cursor 2,36 (right after `❯ `). */
  empty: box('\x1b[39m❯\xa0\x1b[2mTry "how do I log an error?"\x1b[0m'),
  /** After a reply (focus reported): the prompt suggestion, faint. Cursor 2,36. */
  suggestion: box('\x1b[39m❯\xa0\x1b[2mOne more alternative, one short sentence, no tools.\x1b[0m'),
  /** Typed: plain. Cursor 13,36 (after the text). */
  typed: box('\x1b[39m❯\xa0hello draft'),
  /** Pasted over three lines: plain, continuation rows indented. Cursor 12,36. */
  multi: box('\x1b[39m❯\xa0first line', '  second line', '  third line'),
  /** A long paste collapses into a placeholder, drawn plain like typed text. */
  pasted: box('\x1b[39m❯\xa0note: [Pasted text #1 +12 lines] tail'),
  /** Mid-turn: the marker turns grey, typed text stays plain. */
  busyDraft: box('\x1b[38;5;246m❯\xa0\x1b[39mdraft while busy'),
  /** Mid-turn, emptied. */
  busyEmpty: box('\x1b[38;5;246m❯\xa0\x1b[39m'),
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
};
const strip = (raw: string) => raw.replace(/\x1b\[[0-9;]*m/g, '');

test('A styled capture reads as the plain capture, with faint characters marked', () => {
  const screen = parseStyledScreen(FIXTURES.suggestion);
  assert.equal(screen.text, strip(FIXTURES.suggestion));
  const row = screen.text.split('\n').findIndex((line) => line.startsWith('❯'));
  const flags = screen.faint![row];
  assert.deepEqual(flags.slice(0, 2), [false, false], 'the marker is not faint');
  assert.ok(flags.slice(2).every(Boolean), 'the suggestion is');
  // Attributes carry across lines until reset; colour arguments are never read as faint.
  const carried = parseStyledScreen('\x1b[2mab\ncd\x1b[22me\n\x1b[38;2;2;2;2mf\x1b[38:5:2mg');
  assert.deepEqual(carried.faint, [
    [true, true],
    [true, true, false],
    [false, false],
  ]);
  // Charset selection (`ESC ( B`, with an intermediate byte) and SO/SI leave nothing either.
  assert.equal(parseStyledScreen('\x1b(Bab\x0ec\x0fd\x1b)0e\x1b7f').text, 'abcdef');
  // Hyperlinks and other sequences leave no trace in the text.
  assert.equal(
    parseStyledScreen('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ \x1b[?25lok').text,
    'link ok',
  );
});

/** tmux reads the pane height with the screen: 40 rows (the box shows up to 15). */
const tmux = (raw: string, height = 40): Screen => ({ ...parseStyledScreen(raw), height });

test('On tmux, a faint suggestion is told apart from typed and pasted drafts', () => {
  const kind = (raw: string) => classifyPrompt(tmux(raw));
  assert.deepEqual(kind(FIXTURES.empty), { kind: 'empty' });
  assert.deepEqual(kind(FIXTURES.suggestion), {
    kind: 'suggestion',
    text: 'One more alternative, one short sentence, no tools.',
  });
  assert.deepEqual(kind(FIXTURES.typed), { kind: 'draft', text: 'hello draft', whole: true });
  assert.deepEqual(kind(FIXTURES.multi), {
    kind: 'draft',
    text: 'first line\nsecond line\nthird line',
    whole: true,
  });
  // A collapsed paste stands for text not on screen: never known whole.
  assert.deepEqual(kind(FIXTURES.pasted), {
    kind: 'draft',
    text: 'note: [Pasted text #1 +12 lines] tail',
    whole: false,
  });
  assert.deepEqual(kind(FIXTURES.busyDraft), {
    kind: 'draft',
    text: 'draft while busy',
    whole: true,
  });
  assert.deepEqual(kind(FIXTURES.busyEmpty), { kind: 'empty' });
  assert.deepEqual(kind(FIXTURES.permission), { kind: 'closed' });
  // Typed text that merely reads like an example is a draft on tmux: only faint text is one.
  assert.deepEqual(kind(box('\x1b[39m❯\xa0Try "this"')), {
    kind: 'draft',
    text: 'Try "this"',
    whole: true,
  });
  assert.deepEqual(kind(box('\x1b[39m❯\xa0\x1b[2mPress up to edit queued messages\x1b[0m')), {
    kind: 'empty',
  });
  // Empty is one blank row. Blank rows above one another are typed line breaks: a draft (the
  // rest of it may be scrolled out of a box at its full height).
  assert.equal(kind(box('\x1b[39m❯\xa0', '', '')).kind, 'draft');
});

test('A box at the most rows Claude shows may hide its start: never known whole', () => {
  // Measured on 2.1.296: 3 rows up to height 16, then (height − 10) / 2.
  assert.deepEqual(
    [12, 16, 20, 21, 25, 30, 33, 40, 50, 70].map(maxBoxRows),
    [3, 3, 5, 5, 7, 10, 11, 15, 20, 30],
  );
  const five = box('\x1b[39m❯\xa0one', '  two', '  three', '  four', '  five');
  assert.deepEqual(classifyPrompt(tmux(five, 30)), {
    kind: 'draft',
    text: 'one\ntwo\nthree\nfour\nfive',
    whole: true,
  });
  // At height 20 the box shows 5 rows at most: five rows may be the end of more.
  assert.equal((classifyPrompt(tmux(five, 20)) as { whole: boolean }).whole, false);
  // Without the pane height, nothing is known whole.
  assert.equal((classifyPrompt(parseStyledScreen(five)) as { whole: boolean }).whole, false);
});

test('On Orca, any text in the prompt is unknown; only a short reported draft is whole', () => {
  const plain = (raw: string): Screen => ({ text: strip(raw) });
  // Older Orca draws the composer on screen, as plain text: never cleared from here.
  assert.deepEqual(classifyPrompt(plain(FIXTURES.empty)), { kind: 'empty' });
  assert.deepEqual(classifyPrompt(plain(FIXTURES.suggestion)), {
    kind: 'unknown',
    text: 'One more alternative, one short sentence, no tools.',
    whole: false,
  });
  assert.deepEqual(classifyPrompt(plain(FIXTURES.typed)), {
    kind: 'unknown',
    text: 'hello draft',
    whole: false,
  });
  assert.deepEqual(classifyPrompt(plain(FIXTURES.permission)), { kind: 'closed' });
  assert.equal(classifyPrompt(plain(box('❯', '', ''))).kind, 'unknown');
  // Orca 1.4.216 reports the composer apart (`draft`); the prompt line keeps the marker only.
  const orca = (draft?: string): Screen => ({
    text: strip(box('❯')),
    ...(draft !== undefined && { composer: draft }),
  });
  assert.deepEqual(classifyPrompt(orca()), { kind: 'empty' });
  assert.deepEqual(classifyPrompt(orca('')), { kind: 'empty' });
  // The examples stay on screen; text in `draft` that reads like one was typed there.
  assert.deepEqual(classifyPrompt(orca('Try "this"')), {
    kind: 'unknown',
    text: 'Try "this"',
    whole: true,
  });
  assert.deepEqual(classifyPrompt(orca('first line\nsecond line')), {
    kind: 'unknown',
    text: 'first line\nsecond line',
    whole: true,
  });
  // `draft` holds only what the box shows (measured): text that may not fit is not known whole.
  assert.equal((classifyPrompt(orca('a\nb\nc')) as { whole: boolean }).whole, false);
  assert.equal((classifyPrompt(orca('x'.repeat(300))) as { whole: boolean }).whole, false);
});

test('Deletion leaves the confirmed text with one stretch taken out', () => {
  assert.equal(oneStretchGone('firstsecondthird', 'firstsecond'), true);
  assert.equal(oneStretchGone('firstsecondthird', 'firstthird'), true, 'a middle line');
  assert.equal(oneStretchGone('firstsecondthird', 'secondthird'), true);
  assert.equal(oneStretchGone('firstsecondthird', ''), true);
  assert.equal(oneStretchGone('firstsecondthird', 'firstsecondtyped'), false);
  assert.equal(oneStretchGone('firstsecondthird', 'fisecondthi'), false, 'two stretches');
  assert.equal(oneStretchGone('samesame', 'same'), true);
});

/** Graphemes, as the composer's cursor moves over them (emoji sequences are one). */
const graphemes = (text: string) =>
  [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map(
    (part) => part.segment,
  );

/**
 * Claude's prompt as measured: Ctrl+K deletes to the end of the line (or the line break there),
 * Ctrl+U to the start (or the line break before), by grapheme; a suggestion shows whenever the
 * box is empty and keys never touch it. The cursor starts at the end unless `cursor` places it
 * (line, grapheme). tmux: the box shows the last rows up to its most for the pane `height`,
 * styled; Orca: the composer comes apart as `draft`, as much of it as the box shows.
 */
function fakePrompt(
  options: {
    draft?: string;
    suggestion?: string;
    host?: 'tmux' | 'orca';
    /** The keys never arrive. */
    stuck?: boolean;
    /** Typing arrives, the deletion keys do nothing (another key mode). */
    noDelete?: boolean;
    height?: number;
    cursor?: [number, number];
    /** Called after each key press, e.g. to type meanwhile. */
    typing?: (round: number) => string;
  } = {},
) {
  let lines = (options.draft ?? '').split('\n').map(graphemes);
  let [row, col] = options.cursor ?? [lines.length - 1, lines.at(-1)!.length];
  let rounds = 0;
  const pressed: string[][] = [];
  const orca = options.host === 'orca';
  const most = maxBoxRows(options.height ?? 40);
  const text = () => lines.map((line) => line.join('')).join('\n');
  const host: ComposerHost = {
    styled: !orca,
    read: async () => {
      const shown = text() ? lines.slice(-most).map((line) => line.join('')) : [];
      if (orca) {
        const draft = shown.join('\n') || options.suggestion;
        return { text: strip(box('❯')), ...(draft && { composer: draft }) };
      }
      if (!shown.length && options.suggestion)
        return tmux(box(`\x1b[39m❯\xa0\x1b[2m${options.suggestion}\x1b[0m`), options.height);
      return tmux(box(`\x1b[39m❯\xa0${shown.join('\n  ')}`), options.height);
    },
    wait: async () => {},
    async press(keys) {
      pressed.push([...keys]);
      if (!options.stuck)
        for (const key of keys) {
          if (key === '.') {
            lines[row] = [...lines[row].slice(0, col), '.', ...lines[row].slice(col)];
            col++;
          } else if (key === 'BSpace') {
            if (col > 0) {
              lines[row] = [...lines[row].slice(0, col - 1), ...lines[row].slice(col)];
              col--;
            }
          } else if (options.noDelete) {
            continue;
          } else if (key === 'C-k') {
            if (col < lines[row].length) lines[row] = lines[row].slice(0, col);
            else if (row < lines.length - 1)
              lines.splice(row, 2, [...lines[row], ...lines[row + 1]]);
          } else if (col > 0) {
            lines[row] = lines[row].slice(col);
            col = 0;
          } else if (row > 0) {
            col = lines[row - 1].length;
            lines.splice(row - 1, 2, [...lines[row - 1], ...lines[row]]);
            row--;
          }
        }
      const typed = graphemes(options.typing?.(rounds++) ?? '');
      if (typed.length) {
        lines[row] = [...lines[row].slice(0, col), ...typed, ...lines[row].slice(col)];
        col += typed.length;
      }
    },
  };
  return { host, pressed, text };
}

/** Clears what the fake prompt holds now, keeping every backup made on the way. */
async function clearPrompt(prompt: ReturnType<typeof fakePrompt>) {
  const backups: string[] = [];
  const from = await claudeCodeComposer.inspect(prompt.host);
  assert.ok(from.kind === 'draft' || from.kind === 'unknown', from.kind);
  const result = await claudeCodeComposer.clear(prompt.host, from, async (text) => {
    backups.push(text);
  });
  return { result, backups };
}

test('A composer known whole is saved in full first, then cleared pair by pair', async () => {
  for (const host of ['tmux', 'orca'] as const)
    for (const draft of [
      'hello draft',
      'first line\nsecond line\nthird line',
      '안녕하세요 초안\n둘째 줄',
      'good 👍🏽 family 👨‍👩‍👧\nтест · … é',
      'keep\n\n\n\nlast',
    ]) {
      if (host === 'orca' && draft.split('\n').length > 2) continue; // not whole on Orca
      const prompt = fakePrompt({ draft, host });
      const { result, backups } = await clearPrompt(prompt);
      assert.deepEqual(result, { status: 'cleared', state: { kind: 'empty' } }, `${host} ${draft}`);
      // The whole text, once, before any key.
      assert.deepEqual(backups, [draft]);
      assert.equal(prompt.text(), '');
      assert.ok(prompt.pressed.every((keys) => keys.join() === 'C-k,C-u'));
    }
  // The cursor in the middle (Orca reports no cursor): its line goes first, still one stretch.
  const middle = fakePrompt({ draft: 'one\ntwo', host: 'orca', cursor: [0, 1] });
  assert.equal((await clearPrompt(middle)).result.status, 'cleared');
  const tmuxMiddle = fakePrompt({ draft: 'one\ntwo\nthree', cursor: [1, 1] });
  assert.equal((await clearPrompt(tmuxMiddle)).result.status, 'cleared');
  assert.equal(tmuxMiddle.text(), '');
  // A suggestion comes back in the emptied box: on tmux it is seen for what it is.
  const faint = fakePrompt({ draft: 'hello draft', suggestion: 'run the tests' });
  assert.deepEqual((await clearPrompt(faint)).result.status, 'cleared');
  // On Orca it comes back in `draft`: text no part of the draft that survives two pairs.
  const orca = fakePrompt({ draft: 'hello draft', suggestion: 'run the tests', host: 'orca' });
  const { result, backups } = await clearPrompt(orca);
  assert.deepEqual(result, {
    status: 'cleared',
    state: { kind: 'suggestion', text: 'run the tests', inferred: true },
  });
  assert.equal(orca.text(), '');
  assert.deepEqual(backups, ['hello draft', 'hello draft\nrun the tests']);
});

test('A composer not known whole is never touched', async () => {
  // tmux at height 16 shows 3 rows at most: a 5-line draft shows only its end.
  for (const prompt of [
    fakePrompt({ draft: 'secret\n\n\n\n\nmore', height: 16 }),
    fakePrompt({ draft: 'one\ntwo\nthree\nfour\nfive', height: 16 }),
    fakePrompt({ draft: 'one\ntwo\nthree', host: 'orca' }),
    fakePrompt({ draft: 'w '.repeat(200), host: 'orca' }),
  ]) {
    const from = await claudeCodeComposer.inspect(prompt.host);
    assert.ok(from.kind === 'draft' || from.kind === 'unknown');
    assert.equal(from.whole, false);
    const backups: string[] = [];
    const result = await claudeCodeComposer.clear(prompt.host, from, async (text) => {
      backups.push(text);
    });
    assert.equal(result.status === 'failed' && result.partial, true);
    assert.deepEqual(prompt.pressed, []);
    assert.deepEqual(backups, []);
  }
});

test('Placeholders, a small pane or the task list: never known whole', () => {
  // A collapsed paste or an image stands for content the box does not show.
  for (const text of [
    'note: [Pasted text #1 +12 lines] tail',
    'see [Image #1]',
    '[Pasted text #2]',
  ])
    assert.equal(
      (classifyPrompt(tmux(box(`\x1b[39m❯\xa0${text}`))) as { whole: boolean }).whole,
      false,
      text,
    );
  assert.equal(
    (
      classifyPrompt({ text: strip(box('❯')), composer: '[Pasted text #1 +4 lines]' }) as {
        whole: boolean;
      }
    ).whole,
    false,
  );
  // Below height 12 the box's lower edge is cut off (measured): not counted whole either.
  assert.equal((classifyPrompt(tmux(FIXTURES.typed, 11)) as { whole: boolean }).whole, false);
  // The task list (ctrl+t) was not measured: fail closed.
  const tasks = [
    '  ☐ Write the tests',
    '  ◼ Fix the bug',
    `\x1b[38;5;244m${RULE}`,
    '\x1b[39m❯\xa0hello draft',
    `\x1b[38;5;244m${RULE}`,
    '  ⏸ manual mode on · ctrl+t to hide tasks',
  ].join('\n');
  assert.equal((classifyPrompt(tmux(tasks)) as { whole: boolean }).whole, false);
});

test('Clearing stops at once when Claude is no longer the one at the terminal', async () => {
  const prompt = fakePrompt({ draft: 'one\ntwo\nthree' });
  const from = await claudeCodeComposer.inspect(prompt.host);
  let asks = 0;
  const result = await claudeCodeComposer.clear(
    prompt.host,
    from as Extract<typeof from, { kind: 'draft' }>,
    async () => {},
    // Paused (Ctrl+Z) after the first pair.
    async () => ++asks === 1,
  );
  assert.equal(result.status === 'failed' && result.lost, true);
  assert.equal(prompt.pressed.length, 1);
});

test('Text that shows up and cannot be known whole, or goes away, is never sent over', async () => {
  // tmux: a paste shows up while clearing: never probed, asked again as not clearable here.
  const pasted = fakePrompt({
    draft: 'one\ntwo',
    typing: (round) => (round === 0 ? ' [Pasted text #1 +9 lines]' : ''),
  });
  assert.deepEqual((await clearPrompt(pasted)).result, {
    status: 'changed',
    text: 'one\n[Pasted text #1 +9 lines]',
    whole: false,
  });
  // Orca: text that showed up once the draft went, then went too, was typing (it is saved).
  const typed = fakePrompt({
    draft: 'hello',
    host: 'orca',
    typing: (round) => (round === 0 ? 'zz' : ''),
  });
  const { result, backups } = await clearPrompt(typed);
  assert.deepEqual(result, { status: 'changed', text: 'zz', whole: true });
  assert.deepEqual(backups, ['hello', 'hello\nzz']);
  // Blank lines are cleared without touching the clipboard.
  const blank = fakePrompt({ draft: '\n\n' });
  const from = await claudeCodeComposer.inspect(blank.host);
  assert.equal(from.kind, 'draft');
  const copies: string[] = [];
  const cleared = await claudeCodeComposer.clear(
    blank.host,
    from as Extract<typeof from, { kind: 'draft' }>,
    async (text) => void copies.push(text),
  );
  assert.equal(cleared.status, 'cleared');
  assert.deepEqual(copies, []);
});

test('Text the keys never change is never taken as cleared', async () => {
  // tmux: the plain draft is still there.
  const stuck = fakePrompt({ draft: 'hello draft', stuck: true });
  assert.deepEqual((await clearPrompt(stuck)).result, {
    status: 'failed',
    state: { kind: 'draft', text: 'hello draft', whole: true },
  });
  // Orca: text that never moved is probed with one '.'. Keys that never arrive: not cleared.
  const orcaStuck = fakePrompt({ draft: 'hello draft', stuck: true, host: 'orca' });
  assert.equal((await clearPrompt(orcaStuck)).result.status, 'failed');
  // Typing arrives but deletion does not: the '.' is taken back, the draft stays as it was.
  const keyMode = fakePrompt({ draft: 'hello draft', noDelete: true, host: 'orca' });
  assert.equal((await clearPrompt(keyMode)).result.status, 'failed');
  assert.equal(keyMode.text(), 'hello draft');
  assert.deepEqual(keyMode.pressed.slice(-1), [['BSpace']]);
  // Only the suggestion: typing replaced it, so the box is ready once the '.' is gone.
  const offered = fakePrompt({ suggestion: 'run the tests', host: 'orca' });
  const { result, backups } = await clearPrompt(offered);
  assert.deepEqual(result, {
    status: 'cleared',
    state: { kind: 'suggestion', text: 'run the tests', inferred: true },
  });
  assert.equal(offered.text(), '');
  assert.deepEqual(backups, ['run the tests']);
  // A closed prompt (a dialog opened) stops the clearing.
  const closed: ComposerHost = {
    ...fakePrompt({ draft: 'x' }).host,
    read: async () => parseStyledScreen(FIXTURES.permission),
  };
  assert.deepEqual(
    await claudeCodeComposer.clear(
      closed,
      { kind: 'draft', text: 'x', whole: true },
      async () => {},
    ),
    { status: 'failed', state: { kind: 'closed' } },
  );
});

test('Typing that shows up while clearing stops it and is shown again', async () => {
  // tmux: anything but the draft with a stretch gone is typing; nothing more is deleted.
  const tmuxPrompt = fakePrompt({
    draft: 'line 0\nline 1\nline 2',
    typing: (round) => (round === 0 ? 'new words' : ''),
  });
  const { result } = await clearPrompt(tmuxPrompt);
  assert.deepEqual(result, { status: 'changed', text: 'line 0\nline 1\nnew words', whole: true });
  assert.ok(tmuxPrompt.text().endsWith('new words'));
  // Orca: new text may be the suggestion back in the box, so it is saved first, then tried
  // once more; text that then moves was typing: it stops there, already on the clipboard.
  const orca = fakePrompt({
    draft: 'line 0\nline 1',
    host: 'orca',
    typing: (round) => (round === 0 ? 'new words' : ''),
  });
  const orcaRun = await clearPrompt(orca);
  assert.equal(orcaRun.result.status, 'changed');
  assert.match(orcaRun.backups.at(-1)!, /new words/);
});

test('Backups never shrink: an interrupted clearing confirmed again keeps what went before', () => {
  assert.equal(mergeBackup(undefined, 'a'), 'a');
  assert.equal(mergeBackup('first\nsecond\nthird', 'first\nsecond'), 'first\nsecond\nthird');
  assert.equal(mergeBackup('second\nthird', 'first\nsecond\nthird'), 'first\nsecond\nthird');
  assert.equal(mergeBackup('third', 'new words'), 'third\nnew words');
  // Line by line: a line that merely contains another is no match.
  assert.equal(mergeBackup('deploy', 'please deploy now'), 'deploy\nplease deploy now');
  assert.ok(containsLines('a\nb\nc', 'b\nc'));
  assert.equal(drawn(' a \n b '), 'ab');
});

test('Each agent states what its composer supports', () => {
  assert.deepEqual(claudeCodeComposer.capabilities({ styled: true }), {
    delivery: 'terminal',
    canInspect: true,
    canDetectSuggestion: true,
    canClear: true,
  });
  assert.deepEqual(claudeCodeComposer.capabilities({ styled: false }), {
    delivery: 'terminal',
    canInspect: true,
    canDetectSuggestion: false,
    canClear: true,
  });
  // Codex takes follow-ups through its queue: there is no composer to check or clear.
  assert.equal(composerFor('codex'), codexQueueComposer);
  assert.deepEqual(codexQueueComposer.capabilities(null), {
    delivery: 'queue',
    canInspect: false,
    canDetectSuggestion: false,
    canClear: false,
  });
  assert.equal(composerFor('claude'), claudeCodeComposer);
  const openclaw = composerFor('openclaw');
  assert.equal(openclaw.agent, 'OpenClaw');
  assert.deepEqual(openclaw.capabilities(null), {
    delivery: 'none',
    canInspect: false,
    canDetectSuggestion: false,
    canClear: false,
  });
});
