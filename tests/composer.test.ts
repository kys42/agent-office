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
  // The examples stay on screen; text in `draft` that reads like one was typed there.
  assert.deepEqual(classifyPrompt(orca('Try "this"')), { kind: 'unknown', text: 'Try "this"' });
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
 * Ctrl+U to the start (or the line break before), Backspace the character before the cursor (or
 * the break); a suggestion shows whenever the box is empty and keys never touch it. The cursor
 * starts at the end, as after typing. On `tmux` lines wrap at `width` and the box shows the last
 * `rows` rows, with the cursor reported; on `orca` the screen is plain and the composer comes
 * apart (`draft`), the prompt line showing the marker only.
 */
function fakePrompt(
  options: {
    draft?: string;
    suggestion?: string;
    host?: 'tmux' | 'orca';
    /** The keys never arrive. */
    stuck?: boolean;
    rows?: number;
    width?: number;
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
  const width = options.width ?? 1000;
  /** Display rows (wrapped), and the row and column (cells; Hangul takes 2) of the cursor. */
  const layout = () => {
    const out: string[] = [];
    let at = { y: 0, x: 0 };
    lines.forEach((line, i) => {
      const chunks = line ? (line.match(new RegExp(`.{1,${width}}`, 'g')) ?? ['']) : [''];
      if (i === row) {
        const k = Math.min(Math.floor(col / width), chunks.length - 1);
        const before = line.slice(k * width, col);
        at = {
          y: out.length + k,
          x: [...before].reduce((n, c) => n + (/[가-힣]/.test(c) ? 2 : 1), 0),
        };
      }
      out.push(...chunks);
    });
    return { out, at };
  };
  const host: ComposerHost = {
    styled: !orca,
    read: async () => {
      const text = lines.join('\n');
      if (orca) {
        const shown = text || options.suggestion;
        return { text: strip(box('❯')), ...(shown && { composer: shown }) };
      }
      if (!text && options.suggestion)
        return parseStyledScreen(box(`\x1b[39m❯\xa0\x1b[2m${options.suggestion}\x1b[0m`));
      const { out, at } = layout();
      const first = Math.max(0, out.length - (options.rows ?? out.length));
      const shown = out.slice(first);
      // box(): a blank row and the top rule come before the prompt rows.
      return {
        ...parseStyledScreen(box(`\x1b[39m❯\xa0${shown.join('\n  ')}`)),
        cursor: { x: 2 + at.x, y: 2 + at.y - first },
      };
    },
    wait: async () => {},
    async press(keys) {
      pressed.push([...keys]);
      if (!options.stuck)
        for (const key of keys) {
          if (key === 'C-k') {
            if (col < lines[row].length) lines[row] = lines[row].slice(0, col);
            else if (row < lines.length - 1) lines.splice(row, 2, lines[row] + lines[row + 1]);
          } else if (key === 'BSpace') {
            if (col > 0) {
              lines[row] = lines[row].slice(0, col - 1) + lines[row].slice(col);
              col--;
            } else if (row > 0) {
              col = lines[row - 1].length;
              lines.splice(row - 1, 2, lines[row - 1] + lines[row]);
              row--;
            }
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
        lines[row] = lines[row].slice(0, col) + typed + lines[row].slice(col);
        col += typed.length;
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

/** Every line of `text` is in `saved`, in order. */
const keepsAll = (saved: string, text: string) =>
  assert.ok(containsLines(saved, text), `${JSON.stringify(saved)} lacks ${JSON.stringify(text)}`);

test('Clearing deletes only what is on screen, and verifies the prompt is empty', async () => {
  for (const host of ['tmux', 'orca'] as const)
    for (const draft of [
      'hello draft',
      'first line\nsecond line\nthird line',
      '[Pasted text #1 +12 lines]',
      '안녕하세요 초안\n둘째 줄',
    ]) {
      const prompt = fakePrompt({ draft, host });
      const { result, backups } = await clearPrompt(prompt);
      assert.deepEqual(
        result,
        { status: 'cleared', state: { kind: 'empty' }, saved: draft },
        draft,
      );
      assert.deepEqual(backups, [draft]);
      assert.equal(prompt.text(), '');
      // tmux: Backspace per character left of the cursor; Orca (no cursor): one pair a step.
      const keys = new Set(prompt.pressed.flat());
      assert.deepEqual([...keys], host === 'tmux' ? ['BSpace'] : ['C-k', 'C-u'], draft);
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
  // Orca: what is left of the draft (blank lines taking a step each) is no suggestion either,
  // even when it is a part seen only during the clearing.
  const blank = fakePrompt({ draft: 'keep\n\n\n\n\n\n\n\nlast', host: 'orca', stuck: false });
  assert.equal((await clearPrompt(blank)).result.status, 'cleared');
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

test('A draft taller than the box is saved whole, row by row, before it is deleted', async () => {
  for (const [draft, rows] of [
    [Array.from({ length: 9 }, (_, i) => `line ${i} of a long draft`).join('\n'), 3],
    // Repeated rows and rows that are substrings of later ones still count line by line.
    ['same\nsame\nthird\nfourth', 3],
    ['deploy\nnow\nplease deploy now', 2],
  ] as const) {
    const prompt = fakePrompt({ draft, rows });
    const { result, backups } = await clearPrompt(prompt);
    assert.equal(result.status, 'cleared', draft);
    assert.equal(prompt.text(), '');
    // Each newly shown part went to the clipboard, in front, before any key reached it.
    assert.equal(backups[0], draft.split('\n').slice(-rows).join('\n'));
    assert.equal(result.saved, draft);
    keepsAll(backups.at(-1)!, draft);
  }
});

test('One paragraph taller than the box: only the cursor row is deleted, then what scrolls in', async () => {
  const draft = 'word '.repeat(48).trim();
  const prompt = fakePrompt({ draft, rows: 2, width: 40 });
  const { result, backups } = await clearPrompt(prompt);
  assert.equal(result.status, 'cleared');
  assert.equal(prompt.text(), '');
  // Never more than one row's characters (and the break above it) per step.
  assert.ok(prompt.pressed.every((keys) => keys.length <= 41));
  assert.equal(drawn(backups.at(-1)!), drawn(draft));
});

test('Spaces left of the cursor that the row does not draw are deleted too', async () => {
  // A word-wrapped row ends in a space the screen trims (measured): it is still typed text.
  const prompt = fakePrompt({ draft: 'ends with spaces   ' });
  const { result } = await clearPrompt(prompt);
  assert.equal(result.status, 'cleared');
  assert.equal(prompt.text(), '');
  assert.deepEqual(
    prompt.pressed.map((keys) => keys.length),
    ['ends with spaces   '.length],
  );
});

test('Typing that shows up while clearing stops it and is shown again', async () => {
  const draft = Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n');
  for (const host of ['tmux', 'orca'] as const) {
    const prompt = fakePrompt({
      draft,
      host,
      ...(host === 'tmux' && { rows: 2 }),
      typing: (round) => (round === 0 ? 'new words' : ''),
    });
    const { result } = await clearPrompt(prompt);
    assert.equal(result.status, 'changed', host);
    assert.equal(result.status === 'changed' && result.text.endsWith('new words'), true);
    // The typed words were not deleted.
    assert.ok(prompt.text().endsWith('new words'));
  }
});

test('Backups never shrink: an interrupted clearing confirmed again keeps what went before', () => {
  assert.equal(mergeBackup(undefined, 'a'), 'a');
  assert.equal(mergeBackup('first\nsecond\nthird', 'first\nsecond'), 'first\nsecond\nthird');
  assert.equal(mergeBackup('second\nthird', 'first\nsecond\nthird'), 'first\nsecond\nthird');
  assert.equal(mergeBackup('third', 'new words'), 'third\nnew words');
  // Line by line: a line that merely contains another is no match.
  assert.equal(mergeBackup('deploy', 'please deploy now'), 'deploy\nplease deploy now');
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
