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
  // Charset selection (`ESC ( B`, with an intermediate byte) and SO/SI leave nothing either.
  assert.equal(parseStyledScreen('\x1b(Bab\x0ec\x0fd\x1b)0e\x1b7f').text, 'abcdef');
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
  // Typed text that merely reads like an example is a draft on tmux: only faint text is one.
  assert.deepEqual(kind(box('\x1b[39m❯\xa0Try "this"')), { kind: 'draft', text: 'Try "this"' });
  assert.deepEqual(kind(box('\x1b[39m❯\xa0\x1b[2mPress up to edit queued messages\x1b[0m')), {
    kind: 'empty',
  });
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
  // Orca 1.4.216 reports the composer apart (`draft`); the prompt line keeps the marker only.
  const orca = (draft?: string): Screen => ({
    text: strip(box('❯')),
    ...(draft !== undefined && { composer: draft }),
  });
  assert.deepEqual(classifyPrompt(orca()), { kind: 'empty' });
  assert.deepEqual(classifyPrompt(orca('first line\nsecond line')), {
    kind: 'unknown',
    text: 'first line\nsecond line',
  });
  assert.deepEqual(classifyPrompt(orca('hello.py로 만들어줘')), {
    kind: 'unknown',
    text: 'hello.py로 만들어줘',
  });
});

/**
 * Claude's prompt as measured: Ctrl+K deletes to the end of the line (or the line break there),
 * Ctrl+U to the start (or the line break before); a suggestion shows whenever the box is empty
 * and keys never touch it. The cursor starts at the end, as after typing. On `orca` the screen
 * is plain and the composer comes apart (`draft`), the prompt line showing the marker only;
 * `rows` shows only the last rows of a long text, as a short pane does.
 */
function fakePrompt(
  options: {
    draft?: string;
    suggestion?: string;
    host?: 'tmux' | 'orca';
    /** The keys never arrive. */
    stuck?: boolean;
    rows?: number;
    /** Called after each key press, e.g. to type meanwhile. */
    typing?: (round: number) => string;
  } = {},
) {
  let lines = (options.draft ?? '').split('\n');
  let row = lines.length - 1;
  let col = lines[row].length;
  let rounds = 0;
  const pressed: ComposerKey[][] = [];
  const orca = options.host === 'orca';
  const shown = () => {
    const text = lines.join('\n');
    if (!text && options.suggestion) return { text: options.suggestion, faint: true };
    return { text: lines.slice(-(options.rows ?? lines.length)).join('\n'), faint: false };
  };
  const host: ComposerHost = {
    styled: !orca,
    read: async () => {
      const { text, faint } = shown();
      if (orca) return { text: strip(box('❯')), ...(text && { composer: text }) };
      const body = text.split('\n').join('\n  ');
      return parseStyledScreen(
        box(faint ? `\x1b[39m❯\xa0\x1b[2m${body}\x1b[0m` : `\x1b[39m❯\xa0${body}`),
      );
    },
    wait: async () => {},
    async press(keys) {
      pressed.push([...keys]);
      if (!options.stuck)
        for (const key of keys) {
          if (key === 'C-k') {
            if (col < lines[row].length) lines[row] = lines[row].slice(0, col);
            else if (row < lines.length - 1) lines.splice(row, 2, lines[row] + lines[row + 1]);
          } else if (col > 0) {
            lines[row] = lines[row].slice(col);
            col = 0;
          } else if (row > 0) {
            col = lines[row - 1].length;
            lines.splice(row - 1, 2, lines[row - 1] + lines[row]);
            row--;
          }
        }
      const typed = options.typing?.(rounds++) ?? '';
      if (typed) {
        lines[row] += typed;
        col = lines[row].length;
      }
    },
  };
  return { host, pressed, text: () => lines.join('\n') };
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

test('Clearing presses Ctrl+K/Ctrl+U pairs and verifies the prompt is empty', async () => {
  for (const draft of [
    'hello draft',
    'first line\nsecond line\nthird line',
    '[Pasted text #1 +12 lines]',
  ]) {
    const prompt = fakePrompt({ draft });
    const { result, backups } = await clearPrompt(prompt);
    assert.deepEqual(result, { status: 'cleared', state: { kind: 'empty' }, saved: draft }, draft);
    assert.deepEqual(backups, [draft]);
    assert.equal(prompt.text(), '');
    assert.ok(prompt.pressed.flat().every((key) => key === 'C-k' || key === 'C-u'));
  }
  // A suggestion comes back in the emptied box: on tmux it is seen for what it is.
  const tmux = fakePrompt({ draft: 'hello draft', suggestion: 'run the tests' });
  assert.deepEqual((await clearPrompt(tmux)).result.status, 'cleared');
  // On Orca the composer comes apart from the screen, and a cleared draft makes way for the
  // suggestion: once the keys were seen to delete, untouchable text is that suggestion.
  const orca = fakePrompt({ draft: 'hello draft', suggestion: 'run the tests', host: 'orca' });
  const { result, backups } = await clearPrompt(orca);
  assert.deepEqual(result.status === 'cleared' && result.state, {
    kind: 'suggestion',
    text: 'run the tests',
    inferred: true,
  });
  assert.equal(orca.text(), '');
  // The suggestion was saved as well before the keys went over it: nothing unsaved is deleted.
  assert.equal(backups.at(-1), 'run the tests\nhello draft');
});

test('Text the keys never change is never taken as cleared', async () => {
  // tmux: the plain draft is still there.
  const stuck = fakePrompt({ draft: 'hello draft', stuck: true });
  assert.deepEqual((await clearPrompt(stuck)).result, {
    status: 'failed',
    state: { kind: 'draft', text: 'hello draft' },
    saved: 'hello draft',
  });
  // Orca: text that never moved may be a suggestion, or keys that never arrived: not cleared.
  for (const options of [{ draft: 'hello draft', stuck: true }, { suggestion: 'run the tests' }]) {
    const orca = fakePrompt({ ...options, host: 'orca' });
    const { result } = await clearPrompt(orca);
    assert.equal(result.status, 'failed', JSON.stringify(options));
  }
  // A closed prompt (a dialog opened) stops the clearing.
  const closed: ComposerHost = {
    ...fakePrompt({ draft: 'x' }).host,
    read: async () => parseStyledScreen(FIXTURES.permission),
  };
  assert.deepEqual(
    await claudeCodeComposer.clear(closed, { kind: 'draft', text: 'x' }, async () => {}),
    { status: 'failed', state: { kind: 'closed' }, saved: 'x' },
  );
});

test('A long draft shown only in part is saved whole before it is deleted', async () => {
  const draft = Array.from({ length: 9 }, (_, i) => `line ${i} of a long draft`).join('\n');
  const prompt = fakePrompt({ draft, rows: 3 });
  const { result, backups } = await clearPrompt(prompt);
  assert.equal(result.status, 'cleared');
  assert.equal(prompt.text(), '');
  // Each newly shown part went to the clipboard, in front, before any key reached it.
  assert.equal(backups[0], draft.split('\n').slice(-3).join('\n'));
  assert.equal(backups.at(-1), draft);
  assert.equal(result.saved, draft);
});

test('Typing that shows up while clearing stops it and is shown again', async () => {
  // Someone keeps typing at the end of a long draft the box shows only the end of.
  const draft = Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n');
  const prompt = fakePrompt({
    draft,
    rows: 2,
    stuck: false,
    typing: (round) => (round === 0 ? 'new words' : ''),
  });
  const { result } = await clearPrompt(prompt);
  assert.equal(result.status, 'changed');
  assert.equal(result.status === 'changed' && result.text.endsWith('new words'), true);
  // The typed words were not deleted.
  assert.ok(prompt.text().endsWith('new words'));
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
