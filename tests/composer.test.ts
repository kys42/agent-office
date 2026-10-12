import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPrompt,
  claudeCodeComposer,
  codexQueueComposer,
  composerFor,
  parseStyledScreen,
  type ComposerHost,
  type ComposerKey,
  type Screen,
} from '../desktop/composer/index.js';

/**
 * The bottom of real `tmux capture-pane -p -e` captures of Claude Code 2.1.296 (120×40 pane),
 * trimmed to the prompt box; the rule is shortened and every text is a neutral probe text.
 */
const RULE = '─'.repeat(40);
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
  // Hyperlinks and other sequences leave no trace in the text.
  assert.equal(
    parseStyledScreen('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ \x1b[?25lok').text,
    'link ok',
  );
});

test('On tmux, a faint suggestion is told apart from typed and pasted drafts', () => {
  const kind = (raw: string) => classifyPrompt(parseStyledScreen(raw));
  assert.deepEqual(kind(FIXTURES.empty), { kind: 'empty' });
  assert.deepEqual(kind(FIXTURES.suggestion), {
    kind: 'suggestion',
    text: 'One more alternative, one short sentence, no tools.',
  });
  assert.deepEqual(kind(FIXTURES.typed), { kind: 'draft', text: 'hello draft' });
  assert.deepEqual(kind(FIXTURES.multi), {
    kind: 'draft',
    text: 'first line\nsecond line\nthird line',
  });
  assert.deepEqual(kind(FIXTURES.pasted), {
    kind: 'draft',
    text: 'note: [Pasted text #1 +12 lines] tail',
  });
  assert.deepEqual(kind(FIXTURES.busyDraft), { kind: 'draft', text: 'draft while busy' });
  assert.deepEqual(kind(FIXTURES.busyEmpty), { kind: 'empty' });
  assert.deepEqual(kind(FIXTURES.permission), { kind: 'closed' });
  // Typed text that merely reads like a placeholder still counts as empty (as before).
  assert.deepEqual(kind(box('\x1b[39m❯\xa0Try "this"')), { kind: 'empty' });
});

test('On Orca (plain text), any text in the prompt is unknown, never a suggestion', () => {
  const plain = (raw: string): Screen => ({ text: strip(raw) });
  assert.deepEqual(classifyPrompt(plain(FIXTURES.empty)), { kind: 'empty' });
  assert.deepEqual(classifyPrompt(plain(FIXTURES.suggestion)), {
    kind: 'unknown',
    text: 'One more alternative, one short sentence, no tools.',
  });
  assert.deepEqual(classifyPrompt(plain(FIXTURES.typed)), { kind: 'unknown', text: 'hello draft' });
  assert.deepEqual(classifyPrompt(plain(FIXTURES.permission)), { kind: 'closed' });
});

/**
 * Claude's prompt as measured: Ctrl+K deletes to the end of the line (or the line break there),
 * Ctrl+U to the start (or the line break before); a suggestion shows whenever the box is empty
 * and keys never touch it. The cursor sits at the end, as after typing.
 */
function fakePrompt(
  options: { draft?: string; suggestion?: string; styled?: boolean; stuck?: boolean } = {},
) {
  let lines = (options.draft ?? '').split('\n');
  let row = lines.length - 1;
  const pressed: ComposerKey[][] = [];
  const styled = options.styled ?? true;
  const render = () => {
    const text = lines.join('\n');
    if (!text && options.suggestion)
      return styled
        ? box(`\x1b[39m❯\xa0\x1b[2m${options.suggestion}\x1b[0m`)
        : box(`❯ ${options.suggestion}`);
    return box(`\x1b[39m❯\xa0${lines.join('\n  ')}`);
  };
  const host: ComposerHost = {
    styled,
    read: async () => (styled ? parseStyledScreen(render()) : { text: strip(render()) }),
    wait: async () => {},
    async press(keys) {
      pressed.push([...keys]);
      if (options.stuck) return;
      for (const key of keys) {
        if (key === 'C-k') {
          if (lines[row]) lines[row] = '';
          else if (row < lines.length - 1) lines.splice(row, 1);
        } else if (lines[row]) lines[row] = '';
        else if (row > 0) {
          lines.splice(row, 1);
          row--;
        }
      }
      if (!lines.length) lines = [''];
    },
  };
  return { host, pressed, text: () => lines.join('\n') };
}

test('Clearing presses Ctrl+K/Ctrl+U pairs and verifies the prompt is empty', async () => {
  for (const draft of [
    'hello draft',
    'first line\nsecond line\nthird line',
    '[Pasted text #1 +12 lines]',
  ]) {
    const prompt = fakePrompt({ draft });
    assert.deepEqual(await claudeCodeComposer.clear(prompt.host), { kind: 'empty' }, draft);
    assert.equal(prompt.text(), '');
    assert.ok(prompt.pressed.flat().every((key) => key === 'C-k' || key === 'C-u'));
  }
  // A suggestion comes back in the emptied box: on tmux it is seen for what it is.
  const tmux = fakePrompt({ draft: 'hello draft', suggestion: 'run the tests' });
  assert.deepEqual(await claudeCodeComposer.clear(tmux.host), {
    kind: 'suggestion',
    text: 'run the tests',
  });
});

test('Clearing that changes nothing is a failure on tmux, a suggestion only on plain screens', async () => {
  const stuck = fakePrompt({ draft: 'hello draft', stuck: true });
  assert.deepEqual(await claudeCodeComposer.clear(stuck.host), {
    kind: 'draft',
    text: 'hello draft',
  });
  // Orca: the draft goes, then text no deletion key touches is Claude's own suggestion. Typing
  // replaces it; the send flow then requires the prompt to hold exactly the typed text.
  const orca = fakePrompt({ draft: 'hello draft', suggestion: 'run the tests', styled: false });
  assert.deepEqual(await claudeCodeComposer.clear(orca.host), {
    kind: 'suggestion',
    text: 'run the tests',
    inferred: true,
  });
  assert.equal(orca.text(), '');
  // A closed prompt (a dialog opened) stops the clearing.
  const closed: ComposerHost = {
    ...fakePrompt({ draft: 'x' }).host,
    read: async () => parseStyledScreen(FIXTURES.permission),
  };
  assert.deepEqual(await claudeCodeComposer.clear(closed), { kind: 'closed' });
});

test('Each agent states what its composer supports', () => {
  assert.deepEqual(claudeCodeComposer.capabilities({ styled: true }), {
    needsComposerCheck: true,
    canDetectSuggestion: true,
    canClear: true,
  });
  assert.deepEqual(claudeCodeComposer.capabilities({ styled: false }), {
    needsComposerCheck: true,
    canDetectSuggestion: false,
    canClear: true,
  });
  // Codex takes follow-ups through its queue: there is no composer to check or clear.
  assert.equal(composerFor('codex'), codexQueueComposer);
  assert.deepEqual(codexQueueComposer.capabilities(null), {
    needsComposerCheck: false,
    canDetectSuggestion: false,
    canClear: false,
  });
  assert.equal(composerFor('claude'), claudeCodeComposer);
  const openclaw = composerFor('openclaw');
  assert.equal(openclaw.agent, 'OpenClaw');
  assert.deepEqual(openclaw.capabilities(null), {
    needsComposerCheck: true,
    canDetectSuggestion: false,
    canClear: false,
  });
});
