import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cleanInput,
  claudeAbsent,
  findClaudeProcess,
  findHost,
  focusTerminal,
  locateTerminal,
  lookupTerminal,
  parseClaudeProcess,
  parseProcessEnv,
  promptHolds,
  readPrompt,
  ptyOwner,
  sendToTerminal,
  inspectTerminalDraft,
  terminalTarget,
  TerminalInputError,
  type LiveTerminal,
  type RunOptions,
  type TerminalDeps,
} from '../desktop/terminals.js';
import { OfficeService } from '../server/service.js';
import type { SendResult } from '../src/shared/types.js';
import { claudeCodeComposer, codexQueueComposer, composerFor } from '../desktop/composer/index.js';
import { setLocale } from '../src/shared/i18n/index.js';
// These tests assert the original Korean copy: pin the language so results never depend on the
// machine (services resolve `auto` through AGENT_OFFICE_LOCALE first).
process.env.AGENT_OFFICE_LOCALE = 'ko';
setLocale('ko');

const SESSION = '6dfc48fb-f723-4025-aab6-eaa73f743e5b';
const START = 'Tue Oct  6 13:05:12 2026';
const HANDLE = 'term_205af179-74b5-4973-9cd8-0fb07bf63fa9';
const TAB = '75d9bc44-0187-4bcf-bec0-d3f8e1ce6a7f';
const ARGS = 'claude -n ao-send-test';
const ORCA_HELPER =
  '/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper';
const SOCKET = '/private/tmp/tmux-501/default';

function record(pid: number, over: Record<string, unknown> = {}) {
  return JSON.stringify({
    pid,
    sessionId: SESSION,
    procStart: START,
    status: 'idle',
    kind: 'interactive',
    updatedAt: 1000,
    ...over,
  });
}

/** claude(4242) ← zsh(4000) ← login(3900), all on one tty, under the program holding the pty. */
const processTable = (owner: string, tty = 'ttys012') =>
  [
    `  4242  4000 ${tty}    claude`,
    `  4000  3900 ${tty}    -zsh`,
    `  3900  3146 ${tty}    login`,
    `  3146     1 ??       ${owner}`,
    `  9999     1 ttys099  -zsh`,
  ].join('\n');

const RULE = '─'.repeat(40);
/** Claude Code 2.1.296 as rendered at rest or mid-turn: the prompt box is the last thing. */
const claudeScreen = (typed: string) =>
  [
    '⏺ Done.',
    '',
    `${RULE} ao-send-test ─`,
    `❯ ${typed.split('\n').join('\n  ')}`.trimEnd(),
    RULE,
    '  ⏸ manual mode on · ← for agents',
  ].join('\n');
/** A permission prompt replaces the prompt box (measured on 2.1.296). */
const permissionScreen = [
  `${RULE} earlier output`,
  '⏺ Waiting 8 seconds',
  '  ⎿  $ sleep 8 && date > out.txt',
  '',
  RULE,
  ' Bash command',
  ' sleep 8 && date > out.txt',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and always allow access to this folder',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');
/** The agents view (← for agents) has a prompt of its own: Enter there starts a new session. */
const agentsScreen = (typed: string) =>
  [
    'Your conversation moved to the background — enter opens it · esc returns to it',
    'Needs input',
    ' ✻ current session  ao-send-test',
    RULE,
    `❯ ${typed || 'describe a task for a new session'}`,
    RULE,
    typed
      ? '  enter to create · esc to clear · ctrl+f to find'
      : '  enter to return · space to reply',
  ].join('\n');
/** `@` completions drawn above the prompt: Enter would pick a file. */
const suggestScreen = (typed: string) =>
  [
    '    ◇ src/app.ts',
    '    ◇ src/api.ts',
    `${RULE} ao-send-test ─`,
    `❯ ${typed}`,
    RULE,
    '  ⏸ manual mode on',
  ].join('\n');

/** Fake process table and CLIs. Every call is recorded so tests can check exact arguments. */
function fakeDeps(
  sessionsDir: string,
  options: {
    alive?: number[];
    lstart?: Record<number, string>;
    env?: string;
    args?: string;
    table?: string;
    tmuxShow?: string;
    orcaShow?: unknown;
    orcaSend?: unknown;
    orcaSwitch?: unknown;
    /** `ps -o stat=,pgid=,tpgid=` of the Claude process. */
    fg?: string;
    /** The rendered terminal for what sits in the prompt; the nth read (from 0). */
    screen?: (typed: string, read: number) => string;
    /** `#{pane_height}` (default 40: the prompt box shows up to 15 rows). */
    paneHeight?: number;
    /** `#{pane_in_mode}`: 1 while the tmux pane is scrolled back. */
    paneMode?: string;
    /** `source` of `orca terminal read --screen`. */
    orcaSource?: string;
    /** Fails `orca terminal send --enter` only. */
    enterRefused?: boolean;
    /**
     * Orca 1.4.216: the composer comes apart as `draft` (absent when empty) and the prompt line
     * shows the marker only. Given what the prompt holds (typed text), what `draft` reports.
     */
    orcaDraft?: (typed: string, read: number) => string | undefined;
    /** With `orcaDraft`: the rendered prompt line (measured: the suggestion is drawn there). */
    orcaTail?: (typed: string) => string;
    fail?: (file: string, args: string[]) => Error | undefined;
  } = {},
) {
  const calls: { file: string; args: string[]; options?: RunOptions }[] = [];
  // What the prompt holds: typed or pasted text, cleared by Enter.
  let typed = '';
  let loaded = '';
  let reads = 0;
  const screen = () => (options.screen ?? claudeScreen)(typed, reads++);
  const deps: TerminalDeps = {
    sessionsDir,
    codexHome: '/nonexistent/codex-home',
    alive: (pid) => (options.alive ?? [4242]).includes(pid),
    bin: (name) => `/bin/${name}`,
    wait: async () => {},
    run: async (file, args, runOptions) => {
      calls.push({ file, args, options: runOptions });
      const failure = options.fail?.(file, args);
      if (failure) throw failure;
      if (file === '/bin/ps') {
        const pid = Number(args.at(-1));
        if (args.includes('lstart=')) return `${options.lstart?.[pid] ?? START}   \n`;
        if (args.includes('-axo')) return options.table ?? processTable(ORCA_HELPER);
        if (args.includes('-wwE')) return `${options.args ?? ARGS} ${options.env ?? ''}\n`;
        if (args.includes('-ww')) return `${options.args ?? ARGS}\n`;
        if (args.includes('stat=,pgid=,tpgid=')) return `${options.fg ?? 'S+ 4242 4242'}\n`;
      }
      if (file === '/bin/tmux' && args.some((a) => a.startsWith('#{pane_in_mode}')))
        return `${options.paneMode ?? '0'} ${options.paneHeight ?? 40}\n`;
      if (file === '/bin/tmux' && args.includes('display-message')) return options.tmuxShow ?? '';
      if (file === '/bin/tmux' && args.includes('load-buffer')) loaded = runOptions?.input ?? '';
      if (file === '/bin/tmux' && args.includes('paste-buffer')) typed += loaded;
      // Enter submits; Ctrl+K/Ctrl+U pairs (the composer adapter's clearing) empty the prompt.
      if (file === '/bin/tmux' && args.includes('send-keys'))
        typed =
          args.includes('Enter') || clears(args) ? '' : typed + (args.at(-1) === 'l' ? 'l' : '');
      if (file === '/bin/tmux' && args.includes('capture-pane')) return screen();
      if (file === '/bin/orca' && args[1] === 'read') {
        const draft = options.orcaDraft?.(typed, reads);
        const tail = (
          options.orcaDraft ? (options.orcaTail?.(typed) ?? claudeScreen('')) : screen()
        ).split('\n');
        if (options.orcaDraft) reads++;
        return JSON.stringify({
          ok: true,
          result: {
            terminal: {
              tail,
              source: options.orcaSource ?? 'screen',
              ...(draft !== undefined && { draft }),
            },
          },
        });
      }
      if (file === '/bin/orca' && args[1] === 'list') {
        const t = (options.orcaShow as { result?: { terminal?: unknown } })?.result?.terminal;
        return JSON.stringify({ ok: true, result: { terminals: t ? [t] : [] } });
      }
      if (file === '/bin/orca' && args[1] === 'switch')
        return JSON.stringify(
          options.orcaSwitch ?? { ok: true, result: { focus: { navigated: true } } },
        );
      if (file === '/bin/orca' && args[1] === 'send') {
        const text = args.find((arg) => arg.startsWith('--text='));
        if (clears(args)) typed = '';
        else if (text === '--text=\x7f') typed = [...typed].slice(0, -1).join('');
        else if (text) typed += text.slice('--text='.length).replace(/\x1b\[20[01]~/g, '');
        if (args.includes('--enter')) {
          if (options.enterRefused)
            return JSON.stringify({ ok: true, result: { send: { accepted: false } } });
          typed = '';
        }
        return JSON.stringify(
          options.orcaSend ?? { ok: true, result: { send: { accepted: true } } },
        );
      }
      return '';
    },
  };
  return { deps, calls };
}

async function withSessions(files: Record<string, string>, fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-terminals-'));
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const orcaShow = (over: Record<string, unknown> = {}) => ({
  ok: true,
  result: {
    terminal: {
      handle: HANDLE,
      tabId: TAB,
      title: '✳ ao-send-test',
      connected: true,
      writable: true,
      orphaned: false,
      ...over,
    },
  },
});
const ORCA_ENV = `ORCA_TERMINAL_HANDLE=${HANDLE} ORCA_TAB_ID=${TAB}`;
const TMUX_ENV = `TMUX=${SOCKET},812,0 TMUX_PANE=%3 ${ORCA_ENV}`;

test('Session records must be well-formed, interactive, and named after their own pid', () => {
  assert.equal(parseClaudeProcess('4242.json', record(4242))?.sessionId, SESSION);
  assert.equal(parseClaudeProcess('4242.json', record(4343)), null);
  assert.equal(parseClaudeProcess('4242.json', record(4242, { kind: 'headless' })), null);
  assert.equal(parseClaudeProcess('4242.json', record(4242, { sessionId: '../x' })), null);
  assert.equal(parseClaudeProcess('4242.json', record(4242, { procStart: undefined })), null);
  assert.equal(parseClaudeProcess('4242.json', '{broken'), null);
});

test('A live session process is matched by id and verified against PID reuse', async () => {
  await withSessions(
    {
      '4242.json': record(4242),
      '5151.json': record(5151, { updatedAt: 9000 }),
      '6000.json': record(6000, { sessionId: 'other-session-0000' }),
      'notes.txt': 'ignored',
    },
    async (dir) => {
      // 5151 is newer but dead; 4242 is alive and started when recorded.
      const { deps, calls } = fakeDeps(dir, { alive: [4242, 6000] });
      assert.equal((await findClaudeProcess(SESSION, deps))?.pid, 4242);
      const lstart = calls.find((c) => c.args.includes('lstart='))!;
      assert.equal(lstart.options?.env?.TZ, 'UTC');
      assert.equal(lstart.options?.env?.LC_ALL, 'C');

      const recycled = fakeDeps(dir, {
        alive: [4242],
        lstart: { 4242: 'Wed Oct  7 09:00:00 2026' },
      });
      assert.equal(await findClaudeProcess(SESSION, recycled.deps), null);
      assert.equal(await findClaudeProcess('missing-session', deps), null);
    },
  );
  const { deps } = fakeDeps('/nonexistent/agent-office-sessions');
  assert.equal(await findClaudeProcess(SESSION, deps), null);
});

test('Only the environment part of ps output is read, never look-alike arguments', () => {
  const args = `claude --note ORCA_TERMINAL_HANDLE=term_fake TMUX_PANE=%99`;
  const env = `HOME=/Users/me ${ORCA_ENV} TMUX=${SOCKET},812,0 TMUX_PANE=%3`;
  assert.deepEqual(parseProcessEnv(`${args} ${env}`, args), {
    inTmux: true,
    orcaHandle: HANDLE,
    orcaTab: TAB,
    tmuxSocket: SOCKET,
    tmuxPane: '%3',
  });
  // Arguments alone carry no environment.
  assert.deepEqual(parseProcessEnv(args, args), {
    inTmux: false,
    orcaHandle: undefined,
    orcaTab: undefined,
    tmuxSocket: undefined,
    tmuxPane: undefined,
  });
  // Malformed values are ignored rather than passed to a CLI.
  assert.equal(parseProcessEnv(`x TMUX_PANE=%1;rm`, 'x').tmuxPane, undefined);
  assert.equal(parseProcessEnv(`x ORCA_TERMINAL_HANDLE=term_a$b`, 'x').orcaHandle, undefined);
});

test('The pty owner is the first ancestor on another terminal', () => {
  assert.deepEqual(ptyOwner(processTable(ORCA_HELPER), 4242), {
    tty: 'ttys012',
    command: ORCA_HELPER,
  });
  assert.deepEqual(ptyOwner(processTable('tmux'), 4242), { tty: 'ttys012', command: 'tmux' });
  // nvim :terminal inside Orca: the inner shell's pty belongs to nvim on the outer tty.
  const nested = [
    '  4242  4000 ttys020    claude',
    '  4000  3800 ttys020    -zsh',
    '  3800  3700 ttys012    nvim',
    '  3700  3146 ttys012    -zsh',
    `  3146     1 ??       ${ORCA_HELPER}`,
  ].join('\n');
  assert.equal(ptyOwner(nested, 4242)?.command, 'nvim');
  assert.equal(ptyOwner(processTable(ORCA_HELPER, '??'), 4242), null);
  assert.equal(ptyOwner(processTable(ORCA_HELPER), 1234), null);
});

test('tmux is accepted only when tmux holds the pty and the pane tty matches', async () => {
  const ok = fakeDeps('/x', {
    env: TMUX_ENV,
    table: processTable('tmux'),
    tmuxShow: '/dev/ttys012\twork:1.0\n',
  });
  assert.deepEqual(await findHost(4242, ok.deps), {
    kind: 'tmux',
    socket: SOCKET,
    pane: '%3',
    label: 'work:1.0',
  });
  const display = ok.calls.find((c) => c.args.includes('display-message'))!;
  assert.deepEqual(display.args.slice(0, 6), ['-S', SOCKET, 'display-message', '-p', '-t', '%3']);
  // A pane on another tty never falls back to the inherited outer Orca terminal.
  const other = fakeDeps('/x', {
    env: TMUX_ENV,
    table: processTable('tmux'),
    tmuxShow: '/dev/ttys099\twork:1.0\n',
    orcaShow: orcaShow(),
  });
  assert.equal(await findHost(4242, other.deps), null);
  const malformed = fakeDeps('/x', {
    env: `TMUX=relative,1,0 ${ORCA_ENV}`,
    table: processTable('tmux'),
    orcaShow: orcaShow(),
  });
  assert.equal(await findHost(4242, malformed.deps), null);
  assert.ok(!malformed.calls.some((c) => c.file === '/bin/orca'));
});

test('Orca is accepted only when Orca holds the pty, for a live writable terminal of the same tab', async () => {
  const ok = fakeDeps('/x', { env: ORCA_ENV, orcaShow: orcaShow() });
  assert.deepEqual(await findHost(4242, ok.deps), {
    kind: 'orca',
    handle: HANDLE,
    title: '✳ ao-send-test',
  });
  // One list call covers every Orca terminal; no per-handle CLI call.
  assert.deepEqual(
    ok.calls.filter((c) => c.file === '/bin/orca').map((c) => c.args),
    [['terminal', 'list', '--json']],
  );
  for (const over of [
    { connected: false },
    { writable: false },
    { orphaned: true },
    { tabId: 'another-tab' },
    { handle: 'term_other' },
  ]) {
    const bad = fakeDeps('/x', { env: ORCA_ENV, orcaShow: orcaShow(over) });
    assert.equal(await findHost(4242, bad.deps), null, JSON.stringify(over));
  }
  // screen, zellij or nvim inside an Orca tab inherit the Orca handle but own the pty.
  for (const owner of ['screen', 'zellij', 'nvim']) {
    const nested = fakeDeps('/x', {
      env: ORCA_ENV,
      table: processTable(owner),
      orcaShow: orcaShow(),
    });
    assert.equal(await findHost(4242, nested.deps), null, owner);
  }
  const none = fakeDeps('/x', { env: 'HOME=/Users/me' });
  assert.equal(await findHost(4242, none.deps), null);
});

test('Locating combines process and host; the renderer view never carries a handle', async () => {
  await withSessions({ '4242.json': record(4242, { status: 'busy' }) }, async (dir) => {
    const { deps } = fakeDeps(dir, { env: ORCA_ENV, orcaShow: orcaShow() });
    const live = await locateTerminal(SESSION, { fresh: true, deps });
    assert.ok(live);
    const view = terminalTarget(live);
    assert.deepEqual(view, {
      kind: 'orca',
      label: '✳ ao-send-test',
      status: 'busy',
      canSend: true,
      canFocus: true,
      focus: { kind: 'orca', label: '✳ ao-send-test' },
    });
    assert.ok(!JSON.stringify(view).includes(HANDLE));
  });
});

test('Input is plain typed text within limits', () => {
  assert.equal(cleanInput('  hi\r\nthere\u001b[31m\u0007\t!  '), 'hi\nthere[31m\t!');
  assert.equal(cleanInput('a\u001b[201~b'), 'a[201~b');
  assert.throws(() => cleanInput('   '), TerminalInputError);
  assert.throws(() => cleanInput(42), TerminalInputError);
  assert.throws(() => cleanInput('x'.repeat(4001)), TerminalInputError);
  assert.equal(cleanInput('x'.repeat(4000)).length, 4000);
});

const orcaLive = (status = 'idle'): LiveTerminal => ({
  process: { pid: 4242, sessionId: SESSION, procStart: START, status, updatedAt: 0 },
  host: { kind: 'orca', handle: HANDLE, title: '✳ ao-send-test' },
});
const tmuxLive = (status = 'idle'): LiveTerminal => ({
  process: { pid: 4242, sessionId: SESSION, procStart: START, status, updatedAt: 0 },
  host: { kind: 'tmux', socket: SOCKET, pane: '%3', label: 'work:1.0' },
});

test('A failed send can inspect the current whole draft without any input or clipboard changes', async () => {
  for (const live of [tmuxLive(), orcaLive()]) {
    const { deps, calls } = fakeDeps('/x', { screen: () => claudeScreen('existing message') });
    const draft = await inspectTerminalDraft(live, claudeCodeComposer, deps);
    assert.equal(draft?.status, 'needs-confirm');
    assert.equal(draft?.draft, 'existing message');
    assert.notEqual(draft?.clearable, false);
    assert.ok(
      !calls.some(
        (c) =>
          c.args.includes('send-keys') || c.args.includes('send') || c.args.includes('load-buffer'),
      ),
    );
  }
});

test('Read-only draft recovery refuses dialogs or a foreign foreground and marks partial text uncleared', async () => {
  const foreign = fakeDeps('/x', { fg: 'T 4242 4000', screen: () => claudeScreen('mine') });
  assert.equal(await inspectTerminalDraft(tmuxLive(), claudeCodeComposer, foreign.deps), null);
  const partial = fakeDeps('/x', { screen: () => claudeScreen('[Pasted text #1 +12 lines]') });
  assert.equal(
    (await inspectTerminalDraft(tmuxLive(), claudeCodeComposer, partial.deps))?.partial,
    true,
  );
  const closed = fakeDeps('/x', {
    screen: () => 'Do you want to allow this command? Enter to confirm · Esc to cancel',
  });
  assert.equal(await inspectTerminalDraft(tmuxLive(), claudeCodeComposer, closed.deps), null);
});

const sent = (calls: { args: string[] }[]) =>
  calls.some(
    (c) => (c.args.includes('send-keys') && c.args.includes('Enter')) || c.args.includes('--enter'),
  );
/** The message of a finished send, or what came back instead. */
const said = async (result: Promise<SendResult>) => {
  const r = await result;
  return r.status === 'sent' ? r.message : `needs-confirm: ${r.draft}`;
};
/** Keys that delete from the prompt: tmux key names, or Orca's control bytes. */
const clears = (args: string[]) =>
  args.includes('send-keys')
    ? args.some((a) => a === 'C-u' || a === 'BSpace' || a === 'C-k')
    : args.some((a) => a.startsWith('--text=') && /[\x0b\x15\x7f]/.test(a));
/** Text typed: a paste, or Orca text that is more than the clearing keys' control bytes. */
const typedAny = (calls: { args: string[] }[]) =>
  calls.some(
    (c) =>
      c.args.includes('paste-buffer') ||
      c.args.some((a) => a.startsWith('--text=') && /[^\x0b\x15]/.test(a.slice(7))),
  );

test("Claude's prompt is read from the screen: a dialog, menu or other view is never it", () => {
  assert.equal(readPrompt(claudeScreen('')), '');
  assert.equal(readPrompt(claudeScreen('Try "fix lint errors"')), 'Try "fix lint errors"');
  assert.equal(readPrompt(claudeScreen('first\nsecond')), 'first\nsecond');
  assert.equal(readPrompt(permissionScreen), null);
  assert.equal(readPrompt(claudeScreen('').replace('❯', '!')), null, '! shell mode');
  assert.equal(readPrompt(agentsScreen('')), null, 'agents view');
  assert.equal(readPrompt(agentsScreen('hi')), null, 'agents view, typed');
  assert.equal(readPrompt(suggestScreen('see @src/ap')), null, 'completions');
  assert.equal(readPrompt(`${claudeScreen('')}\n esc to close`), null, 'lowercase hint');
  assert.equal(readPrompt(`${claudeScreen('')}\n  ❯ /model`), null, 'list below');
  // Output that merely looks like a list, further up, is not one.
  assert.equal(
    readPrompt(
      ['  /help    Show help', '  ◇ an old bullet', '⏺ Done.', '', claudeScreen('')].join('\n'),
    ),
    '',
  );
  // The main prompt's own hints never close it (default footer while working, tasks, voice).
  for (const foot of [
    '⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents',
    '⏸ manual mode on · ctrl+t to hide tasks',
    'hold space to speak',
  ])
    assert.equal(readPrompt(`${claudeScreen('')}\n  ${foot}`), '', foot);
  // A slash command typed in full selects its own row, above or below the box (measured).
  const slash = (typed: string, row: string) =>
    [
      `  ❯ ${row}    Start a new session with empty context`,
      `${RULE} ao-send-test ─`,
      `❯ ${typed}`,
      RULE,
      '  ⏸ manual mode on',
    ].join('\n');
  assert.equal(readPrompt(slash('/clear', '/clear')), '/clear');
  assert.equal(
    readPrompt(`${claudeScreen('/clear')}\n  ❯ /clear    Start a new session`),
    '/clear',
  );
  // Queued messages above the box are not a list (measured while working).
  assert.equal(
    readPrompt(
      [
        '❯ Add the word ONE.',
        '❯ Add the word TWO.',
        '  ctrl+x ctrl+s to send now',
        '✻ Composing…',
        `${RULE} x ─`,
        '❯ Press up to edit queued messages',
        RULE,
      ].join('\n'),
    ),
    'Press up to edit queued messages',
  );
  // The selected row need not touch the box.
  assert.equal(
    readPrompt(
      [
        `  ❯ /clear    Start a new session`,
        '    /compact  Summarize',
        `${RULE} x ─`,
        '❯ /c',
        RULE,
      ].join('\n'),
    ),
    null,
  );
  // Anything else selected would run instead of what was typed.
  assert.equal(readPrompt(slash('/cl', '/clear')), null);
  assert.equal(readPrompt(slash('/clear now', '/clear')), null);
  // A narrow pane truncates a hint: any "enter to …" below the box means Enter goes elsewhere.
  assert.equal(readPrompt(`${claudeScreen('hi')}\n  enter to inter…`), null);
  // A narrow pane wraps a hint across rows.
  assert.equal(readPrompt(`${claudeScreen('hi')}\n  enter to\n  interrupt and send`), null);
  // History search and the transcript take Enter themselves.
  for (const foot of ['search prompts: fix', 'no matching prompt: xyz', 'ctrl+o to toggle'])
    assert.equal(readPrompt(`${claudeScreen('')}\n  ${foot}`), null, foot);
  // The person's own footer stays fine: shift+tab, "? for shortcuts".
  assert.equal(
    readPrompt(`${claudeScreen('')}\n ⏵⏵ auto mode on (shift+tab to cycle) · ? for shortcuts`),
    '',
  );
  // A title that fills a narrow pane leaves one dash before it.
  assert.equal(readPrompt(['─ a title filling the pane ─', '❯', RULE].join('\n')), '');
  // A long session name leaves fewer dashes before it.
  assert.equal(
    readPrompt(claudeScreen('').replace(`${RULE} ao-send-test ─`, '─── a very long name ─')),
    '',
  );
  assert.equal(readPrompt(''), null);
  assert.equal(readPrompt(RULE), null);
});

test('The prompt must hold exactly the typed text, as drawn', () => {
  assert.equal(promptHolds(claudeScreen('first\nsecond'), 'first\nsecond'), true);
  // Wrapping, a collapsed long paste, and emoji variation selectors all count.
  assert.equal(
    promptHolds(claudeScreen('가'.repeat(50) + '\n' + '가'.repeat(30)), '가'.repeat(80)),
    true,
  );
  assert.equal(promptHolds(claudeScreen('[Pasted text #1 +14 lines]'), 'long\n'.repeat(14)), true);
  assert.equal(promptHolds(claudeScreen('good 👍'), 'good 👍️'), true);
  // A long text the composer shows only the end of.
  const long = Array.from({ length: 30 }, (_, i) => `line ${i} of a long reply`).join('\n');
  assert.equal(promptHolds(claudeScreen(long.split('\n').slice(-8).join('\n')), long), true);
  assert.equal(promptHolds(claudeScreen('reply'), long), false, 'too short to tell');
  // Text left over from before would be submitted twice; a draft would be mixed in.
  assert.equal(promptHolds(claudeScreen('hi hi'), 'hi'), false);
  assert.equal(promptHolds(claudeScreen('draft then mine'), 'mine'), false);
  assert.equal(promptHolds(agentsScreen('hi'), 'hi'), false);
});

test('Orca types the text, looks again, then presses Enter on its own', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    const { deps, calls } = fakeDeps(dir);
    assert.equal(
      await said(sendToTerminal(orcaLive(), '--dry-run\nfirst', deps)),
      'Orca 터미널에 보냈어요',
    );
    const orca = calls.filter((c) => c.file === '/bin/orca').map((c) => c.args);
    const read = ['terminal', 'read', `--terminal=${HANDLE}`, '--screen', '--limit=200', '--json'];
    assert.deepEqual(orca, [
      read,
      // `--flag=value` keeps text that starts with dashes a value.
      [
        'terminal',
        'send',
        `--terminal=${HANDLE}`,
        '--text=\x1b[200~--dry-run\nfirst\x1b[201~',
        '--json',
      ],
      read,
      // Once more after the record and foreground checks.
      read,
      ['terminal', 'send', `--terminal=${HANDLE}`, '--enter', '--json'],
    ]);
  });
});

test('An Orca refusal is reported with its reason, also when the CLI exits non-zero', async () => {
  const refusal = { ok: true, result: { send: { accepted: false, refusedReason: 'pane closed' } } };
  const plain = fakeDeps('/x', { orcaSend: refusal });
  await assert.rejects(sendToTerminal(orcaLive(), 'hi', plain.deps), /pane closed/);
  const exited = fakeDeps('/x', {
    fail: (file, args) =>
      file === '/bin/orca' && args[1] === 'send'
        ? Object.assign(new Error('exit 1'), { stdout: JSON.stringify(refusal) })
        : undefined,
  });
  await assert.rejects(sendToTerminal(orcaLive(), 'hi', exited.deps), (e: Error) => {
    assert.ok(e instanceof TerminalInputError);
    assert.match(e.message, /pane closed/);
    return true;
  });
  const crashed = fakeDeps('/x', {
    fail: (file, args) =>
      file === '/bin/orca' && args[1] === 'send' ? new Error('spawn failed') : undefined,
  });
  await assert.rejects(sendToTerminal(orcaLive(), 'hi', crashed.deps), (e: Error) => {
    assert.ok(!(e instanceof TerminalInputError));
    return true;
  });
});

test('tmux loads text through stdin, pastes it bracketed, re-checks, then submits', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    const { deps, calls } = fakeDeps(dir);
    await sendToTerminal(tmuxLive(), 'const a = 1;\nb', deps);
    const tmux = calls.filter((c) => c.file === '/bin/tmux');
    const mode = [
      '-S',
      SOCKET,
      'display-message',
      '-p',
      '-t',
      '%3',
      '#{pane_in_mode} #{pane_height}',
    ];
    const capture = ['-S', SOCKET, 'capture-pane', '-p', '-e', '-t', '%3'];
    assert.equal(tmux.length, 9);
    assert.deepEqual(tmux[0].args, mode);
    assert.deepEqual(tmux[1].args, capture);
    const buffer = tmux[2].args[4];
    assert.match(buffer, /^agent-office-[\w-]+$/);
    assert.deepEqual(tmux[2].args, ['-S', SOCKET, 'load-buffer', '-b', buffer, '-']);
    assert.equal(tmux[2].options?.input, 'const a = 1;\nb');
    assert.deepEqual(tmux[3].args, [
      '-S',
      SOCKET,
      'paste-buffer',
      '-p',
      '-d',
      '-b',
      buffer,
      '-t',
      '%3',
    ]);
    assert.deepEqual(tmux[4].args, mode);
    assert.deepEqual(tmux[5].args, capture);
    // The screen once more after the record and foreground checks, right before Enter.
    assert.deepEqual(tmux[6].args, mode);
    assert.deepEqual(tmux[7].args, capture);
    assert.deepEqual(tmux[8].args, ['-S', SOCKET, 'send-keys', '-t', '%3', 'Enter']);
  });
});

test('Nothing is typed while a permission prompt, menu or shell mode holds the screen', async () => {
  const screens = [
    permissionScreen,
    claudeScreen('').replace('❯', '!'),
    agentsScreen(''),
    suggestScreen(''),
    '',
  ];
  for (const live of [orcaLive('busy'), tmuxLive('busy')])
    for (const shown of screens) {
      const { deps, calls } = fakeDeps('/x', { screen: () => shown });
      await assert.rejects(sendToTerminal(live, 'hi', deps), TerminalInputError);
      assert.ok(!typedAny(calls) && !sent(calls), `${live.host.kind}: ${shown.slice(0, 20)}`);
    }
});

test('No Enter when a permission prompt opens after typing, before the record says so', async () => {
  // Claude writes `waiting` after drawing the prompt: the screen is the later, surer sign.
  for (const live of [orcaLive('busy'), tmuxLive('busy')])
    await withSessions({ '4242.json': record(4242, { status: 'busy' }) }, async (dir) => {
      const { deps, calls } = fakeDeps(dir, {
        screen: (typed, read) => (read === 0 ? claudeScreen(typed) : permissionScreen),
      });
      await assert.rejects(sendToTerminal(live, 'hi', deps), /제출하지 않았어요/);
      assert.ok(typedAny(calls) && !sent(calls), live.host.kind);
    });
});

test('The prompt gets a moment to draw the text, then a send that never shows stops', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    const late = fakeDeps(dir, { screen: (typed, read) => claudeScreen(read < 2 ? '' : typed) });
    await sendToTerminal(tmuxLive(), 'hi', late.deps);
    assert.ok(sent(late.calls));
    const never = fakeDeps(dir, { screen: () => claudeScreen('') });
    await assert.rejects(sendToTerminal(tmuxLive(), 'hi', never.deps), TerminalInputError);
    assert.ok(!sent(never.calls));
    assert.equal(never.calls.filter((c) => c.args.includes('capture-pane')).length, 4);
  });
});

/** The prompt with Claude's suggestion drawn faint, as `capture-pane -e` shows it (2.1.296). */
const suggested = (text: string) =>
  claudeScreen('').replace(/❯$/m, `\x1b[39m❯ \x1b[2m${text}\x1b[0m`);

test("Text already in the prompt, a draft or a failed send's, is never added to", async () => {
  for (const live of [orcaLive('busy'), tmuxLive('busy')]) {
    const { deps, calls } = fakeDeps('/x', { screen: () => claudeScreen('half-written idea') });
    // Nothing is typed: the text comes back for the person to decide about.
    const result = await sendToTerminal(live, 'hi', deps, { backup: async () => {} });
    assert.deepEqual(result, {
      status: 'needs-confirm',
      draft: 'half-written idea',
      agent: 'Claude',
      // On Orca, text on screen may be the suggestion: the person picks, and it can be cleared.
      ...(live.host.kind === 'orca' && { maybeSuggestion: true }),
    });
    // Without a way to back the text up first (no clipboard), it is refused as before.
    await assert.rejects(
      sendToTerminal(live, 'hi', deps, { replaceDraft: 'half-written idea' }),
      /이미 글이 있어요/,
    );
    assert.ok(!typedAny(calls) && !sent(calls), live.host.kind);
    assert.ok(!calls.some((c) => clears(c.args)));
  }
  // Hints an empty prompt shows are not drafts: faint on tmux, by their wording on Orca.
  await withSessions({ '4242.json': record(4242, { status: 'busy' }) }, async (dir) => {
    for (const [live, empty] of [
      [tmuxLive('busy'), suggested('Press up to edit queued messages')],
      [orcaLive('busy'), claudeScreen('Press up to edit queued messages')],
    ] as const) {
      const { deps, calls } = fakeDeps(dir, {
        screen: (typed) => (typed ? claudeScreen(typed) : empty),
      });
      await sendToTerminal(live, 'hi', deps);
      assert.ok(sent(calls), live.host.kind);
    }
  });
  // On tmux the same words typed (drawn plain) are a draft.
  const typedHint = fakeDeps('/x', { screen: () => claudeScreen('Try "this"') });
  assert.equal(
    (await sendToTerminal(tmuxLive(), 'hi', typedHint.deps, { backup: async () => {} })).status,
    'needs-confirm',
  );
  for (const hint of [
    'Press up to edit queued messages, Enter to send them immediately',
    'Press Enter to edit the selected message',
    'Try "write a test for\nsrc/app.ts"',
  ])
    assert.equal(readPrompt(claudeScreen(hint)), hint);
});

test('Orca reporting the composer apart (draft) is read as the prompt', async () => {
  // Orca 1.4.216: typed text shows up in `draft`, never on screen (measured).
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    const { deps, calls } = fakeDeps(dir, { orcaDraft: (typed) => typed || undefined });
    assert.deepEqual(await sendToTerminal(orcaLive(), 'hi', deps), {
      status: 'sent',
      message: 'Orca 터미널에 보냈어요',
    });
    assert.ok(sent(calls));
  });
  // A draft there is never typed into.
  const { deps, calls } = fakeDeps('/x', { orcaDraft: () => 'half-written idea' });
  assert.deepEqual(await sendToTerminal(orcaLive(), 'hi', deps, { backup: async () => {} }), {
    status: 'needs-confirm',
    draft: 'half-written idea',
    agent: 'Claude',
    maybeSuggestion: true,
  });
  assert.ok(!typedAny(calls));
});

test('On Orca, only the suggestion in the prompt: confirmed, it is typed over and sent', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    // Orca reports the suggestion in `draft` like typing; keys never touch it.
    const { deps, calls } = fakeDeps(dir, { orcaDraft: (typed) => typed || 'run the tests' });
    const backups: string[] = [];
    const backup = async (text: string) => {
      backups.push(text);
    };
    const first = await sendToTerminal(orcaLive(), 'hi', deps, { backup });
    assert.equal(first.status, 'needs-confirm');
    const result = await sendToTerminal(orcaLive(), 'hi', deps, {
      backup,
      replaceDraft: 'run the tests',
    });
    assert.equal(result.status, 'sent');
    assert.ok(sent(calls));
    assert.deepEqual(backups, ['run the tests']);
  });
});

test('On Orca, the suggestion drawn on screen (no draft) is cleared with one letter and sent', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    // Measured on Orca 1.4.216: the suggestion sits on the prompt line, typing goes to `draft`.
    const { deps, calls } = fakeDeps(dir, {
      orcaDraft: (typed) => typed || undefined,
      orcaTail: (typed) => claudeScreen(typed ? '' : '결과 나오면 추천안대로 ㄱㄱ'),
    });
    const backups: string[] = [];
    const backup = async (text: string) => void backups.push(text);
    const first = await sendToTerminal(orcaLive(), 'hi', deps, { backup });
    assert.deepEqual(first, {
      status: 'needs-confirm',
      draft: '결과 나오면 추천안대로 ㄱㄱ',
      agent: 'Claude',
      maybeSuggestion: true,
    });
    for (const message of ['hi', '결과 나오면 추천안대로 ㄱㄱ']) {
      const result = await sendToTerminal(orcaLive(), message, deps, {
        backup,
        replaceDraft: '결과 나오면 추천안대로 ㄱㄱ',
      });
      assert.equal(result.status, 'sent', message);
      const typed = calls.flatMap((c) => c.args.filter((a) => a.startsWith('--text=')));
      assert.ok(typed.includes('--text=l') && typed.includes('--text=\x7f'), 'probed');
    }
    assert.equal(calls.filter((c) => c.args.includes('--enter')).length, 2);
    assert.deepEqual(backups, ['결과 나오면 추천안대로 ㄱㄱ', '결과 나오면 추천안대로 ㄱㄱ']);
  });
});

test('A faint suggestion in the tmux prompt is typed over without asking', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    const { deps, calls } = fakeDeps(dir, {
      screen: (typed) => (typed ? claudeScreen(typed) : suggested('run the tests')),
    });
    const result = await sendToTerminal(tmuxLive(), 'hi', deps, { backup: async () => {} });
    assert.deepEqual(result, { status: 'sent', message: 'tmux work:1.0에 보냈어요' });
    assert.ok(!calls.some((c) => clears(c.args)), 'nothing cleared');
    assert.ok(sent(calls));
  });
  // On Orca the same text reads like a draft (Orca's `draft` holds it too): the person is asked.
  const { deps, calls } = fakeDeps('/x', { orcaDraft: (typed) => typed || 'run the tests' });
  assert.deepEqual(await sendToTerminal(orcaLive(), 'hi', deps, { backup: async () => {} }), {
    status: 'needs-confirm',
    draft: 'run the tests',
    agent: 'Claude',
    maybeSuggestion: true,
  });
  assert.ok(!typedAny(calls));
});

test('tmux: a suggestion read as a draft is cleared with one letter and sent', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    // Reported on tmux: a Korean suggestion with characters not drawn faint (here grey by
    // colour) read as a draft, and "지우고 내 글 보내기" ended in "비우지 못해".
    const text = 'ㄱㄱ  머지하고  앱  띄워줘';
    const { deps, calls } = fakeDeps(dir, {
      screen: (typed) =>
        typed
          ? claudeScreen(typed)
          : claudeScreen('').replace(/❯$/m, `\x1b[39m❯ \x1b[38;5;246m${text}\x1b[39m`),
    });
    const backups: string[] = [];
    const backup = async (saved: string) => void backups.push(saved);
    assert.deepEqual(await sendToTerminal(tmuxLive(), 'hi', deps, { backup }), {
      status: 'needs-confirm',
      draft: text,
      agent: 'Claude',
    });
    const result = await sendToTerminal(tmuxLive(), 'hi', deps, { backup, replaceDraft: text });
    assert.equal(result.status, 'sent');
    const keys = calls.filter((c) => c.args.includes('send-keys')).map((c) => c.args.slice(5));
    assert.deepEqual(keys.slice(0, 4), [['C-k', 'C-u'], ['C-k', 'C-u'], ['l'], ['BSpace']]);
    assert.ok(sent(calls));
    assert.deepEqual(backups, [text]);
  });
});

/** Every step of a send, in order: what reached the clipboard and the terminal. */
function steps(deps: TerminalDeps) {
  const log: string[] = [];
  const run = deps.run;
  deps.run = async (file, args, options) => {
    if (args.includes('capture-pane') || args[1] === 'read') log.push('read');
    else if (clears(args)) log.push('clear');
    else if (args.includes('paste-buffer') || args.some((a) => a.startsWith('--text=')))
      log.push('type');
    else if (args.includes('Enter') || args.includes('--enter')) log.push('enter');
    return run(file, args, options);
  };
  const backup = async (text: string) => void log.push(`clipboard:${text}`);
  return { log, backup };
}

test('Clear & send: clipboard, clear, verify empty, type, verify, then Enter', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    for (const live of [tmuxLive(), orcaLive()]) {
      let draft = 'half-written idea';
      // Orca 1.4.216 reports the composer as `draft`; older Orca is never cleared from here.
      const { deps, calls } = fakeDeps(dir, {
        screen: (typed) => claudeScreen(typed || draft),
        ...(live.host.kind === 'orca' && { orcaDraft: (typed: string) => typed || draft }),
      });
      // The fake prompt shows the draft until the clearing keys arrive.
      const run = deps.run;
      deps.run = async (file, args, options) => {
        if (clears(args)) draft = '';
        return run(file, args, options);
      };
      const { log, backup } = steps(deps);
      const result = await sendToTerminal(live, 'hi', deps, {
        replaceDraft: 'half-written idea',
        backup,
      });
      assert.equal(result.status, 'sent', live.host.kind);
      assert.equal(result.status === 'sent' && result.cleared, true);
      assert.deepEqual(
        log.filter((step, i) => step !== log[i - 1]),
        ['read', 'clipboard:half-written idea', 'clear', 'read', 'type', 'read', 'enter'],
        live.host.kind,
      );
      // One Ctrl+K·Ctrl+U pair at a time.
      if (live.host.kind === 'tmux')
        assert.ok(calls.some((c) => c.args.join(' ').endsWith('send-keys -t %3 C-k C-u')));
      else assert.ok(calls.some((c) => c.args.includes('--text=\x0b\x15')));
    }
  });
});

test('A draft that changed since it was shown is shown again, untouched', async () => {
  const { deps, calls } = fakeDeps('/x', { screen: () => claudeScreen('a newer idea') });
  const { log, backup } = steps(deps);
  const result = await sendToTerminal(tmuxLive(), 'hi', deps, {
    replaceDraft: 'half-written idea',
    backup,
  });
  assert.deepEqual(result, {
    status: 'needs-confirm',
    draft: 'a newer idea',
    agent: 'Claude',
    changed: true,
  });
  assert.deepEqual(log, ['read']);
  assert.ok(!typedAny(calls) && !sent(calls));
});

test('A prompt that cannot be emptied gets nothing typed and nothing sent', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    const kept = /비우지 못해 보내지 않았어요.*입력창에 있던 글은 클립보드에 있어요/;
    // The keys reach the terminal but the prompt keeps the text (on tmux, drawn plain).
    const { deps, calls } = fakeDeps(dir, { screen: () => claudeScreen('half-written idea') });
    const { log, backup } = steps(deps);
    await assert.rejects(
      sendToTerminal(tmuxLive(), 'hi', deps, { replaceDraft: 'half-written idea', backup }),
      kept,
    );
    assert.equal(log[1], 'clipboard:half-written idea');
    assert.ok(log.includes('clear'));
    assert.ok(!typedAny(calls) && !sent(calls));
    // Orca: text that never moved is probed with one letter; when even that never shows (the
    // keys never arrive), nothing more is typed.
    const orca = fakeDeps(dir, { orcaDraft: () => 'half-written idea' });
    await assert.rejects(
      sendToTerminal(orcaLive(), 'hi', orca.deps, {
        replaceDraft: 'half-written idea',
        backup: async () => {},
      }),
      kept,
    );
    const typed = orca.calls.flatMap((c) =>
      c.args.filter((a) => a.startsWith('--text=') && /[^\x0b\x15]/.test(a.slice(7))),
    );
    assert.deepEqual(typed, ['--text=l']);
    assert.ok(!sent(orca.calls));
    // A clipboard that fails leaves the prompt alone.
    const failing = fakeDeps(dir, { screen: () => claudeScreen('half-written idea') });
    await assert.rejects(
      sendToTerminal(tmuxLive(), 'hi', failing.deps, {
        replaceDraft: 'half-written idea',
        backup: async () => {
          throw new Error('no clipboard');
        },
      }),
      /클립보드에 복사하지 못해/,
    );
    assert.ok(!failing.calls.some((c) => clears(c.args)) && !typedAny(failing.calls));
  });
});

test('A collapsed paste or an image in the prompt is never cleared from here', async () => {
  for (const [live, options] of [
    [tmuxLive(), { screen: () => claudeScreen('see [Pasted text #1 +12 lines]') }],
    [orcaLive(), { orcaDraft: () => 'look at [Image #1]' }],
  ] as const) {
    const { deps, calls } = fakeDeps('/x', options);
    const asked = await sendToTerminal(live, 'hi', deps, { backup: async () => {} });
    assert.equal(asked.status === 'needs-confirm' && asked.partial, true, live.host.kind);
    assert.equal(
      (
        await sendToTerminal(live, 'hi', deps, {
          replaceDraft: asked.status === 'needs-confirm' ? asked.draft : '',
          backup: async () => {},
        })
      ).status,
      'needs-confirm',
    );
    assert.ok(!typedAny(calls) && !sent(calls) && !calls.some((c) => clears(c.args)));
  }
});

test('Clearing stops when Claude is paused or leaves the terminal mid-way', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    let draft = 'first\nsecond\nthird';
    let pairs = 0;
    const { deps, calls } = fakeDeps(dir, { screen: (typed) => claudeScreen(typed || draft) });
    const run = deps.run;
    deps.run = async (file, args, options) => {
      if (clears(args)) {
        pairs++;
        draft = draft.split('\n').slice(0, -1).join('\n');
        return '';
      }
      // Ctrl+Z after the first pair: the shell takes the terminal's foreground.
      if (pairs >= 1 && args.includes('stat=,pgid=,tpgid=')) return 'T 4242 9999\n';
      return run(file, args, options);
    };
    await assert.rejects(
      sendToTerminal(tmuxLive(), 'hi', deps, {
        replaceDraft: 'first\nsecond\nthird',
        backup: async () => {},
      }),
      /비우는 사이 Claude 상태가 바뀌어 멈췄고.*입력창에 있던 글은 클립보드에 있어요/,
    );
    assert.equal(pairs, 1, 'no key after the pause');
    assert.ok(!typedAny(calls) && !sent(calls));
  });
});

test('After clearing, only the exact text is submitted: a long reply over leftovers is not', async () => {
  // Orca: the draft goes, then text the keys never touch shows up (taken for Claude's
  // suggestion). It was a leftover after all: the reply mixes with it, and the composer shows
  // only the end — which would pass for a long text shown in part, but not after clearing.
  const reply = 'Please run the whole test suite again and report every failure.';
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    let cleared = false;
    const { deps, calls } = fakeDeps(dir, {
      orcaDraft: (typed) =>
        typed
          ? `stale words here ${typed}`.slice(-50)
          : cleared
            ? 'stale words here'
            : 'half-written idea',
    });
    const run = deps.run;
    deps.run = async (file, args, options) => {
      if (clears(args)) cleared = true;
      return run(file, args, options);
    };
    const saved: string[] = [];
    await assert.rejects(
      sendToTerminal(orcaLive(), reply, deps, {
        replaceDraft: 'half-written idea',
        backup: async (text) => void saved.push(text),
      }),
      /넣은 글만 있는지 확인하지 못해 제출하지 않았어요.*입력창에 있던 글은 클립보드에 있어요/,
    );
    assert.ok(typedAny(calls));
    assert.ok(!sent(calls), 'no Enter');
    // Everything the keys went over was saved first.
    assert.equal(saved.at(-1), 'half-written idea\nstale words here');
  });
});

test('An interrupted clearing confirmed again never backs up less than before', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    let draft = 'first\nsecond\nthird';
    let presses = 0;
    const { deps } = fakeDeps(dir, { screen: (typed) => claudeScreen(typed || draft) });
    const run = deps.run;
    deps.run = async (file, args, options) => {
      if (clears(args)) {
        // Each step takes the last row; after the first, someone types on.
        draft = draft.split('\n').slice(0, -1).join('\n');
        if (++presses === 1) draft += ' typed';
        return '';
      }
      return run(file, args, options);
    };
    const clipboard: string[] = [];
    const backup = async (text: string) => void clipboard.push(text);
    const first = await sendToTerminal(tmuxLive(), 'hi', deps, {
      replaceDraft: 'first\nsecond\nthird',
      backup,
    });
    // The typing stopped it: shown again, with what was cleared so far on the clipboard.
    assert.deepEqual(first, {
      status: 'needs-confirm',
      draft: 'first\nsecond typed',
      agent: 'Claude',
      changed: true,
      clipboard: true,
    });
    const second = await sendToTerminal(tmuxLive(), 'hi', deps, {
      replaceDraft: 'first\nsecond typed',
      backup,
    });
    assert.equal(second.status, 'sent');
    // Every backup holds the earlier one: 'third' was never dropped from the clipboard.
    for (const text of clipboard.slice(1)) assert.match(text, /third/);
    assert.match(clipboard.at(-1)!, /first[\s\S]*second typed/);
  });
});

test('A verified empty prompt takes a long reply as Claude shows it; an inferred one does not', async () => {
  /** Claude collapses a paste of 4 lines or more, or over 800 characters (measured). */
  const collapse = (text: string) =>
    text.split('\n').length >= 4 || text.length > 800
      ? `[Pasted text #1 +${text.split('\n').length - 1} lines]`
      : text;
  for (const reply of [
    Array.from({ length: 5 }, (_, i) => `step ${i + 1}: check it`).join('\n'),
    'x'.repeat(1000),
  ])
    await withSessions({ '4242.json': record(4242) }, async (dir) => {
      let draft = 'half-written idea';
      const { deps, calls } = fakeDeps(dir, {
        screen: (typed) => claudeScreen(typed ? collapse(typed) : draft),
      });
      const run = deps.run;
      deps.run = async (file, args, options) => {
        if (clears(args)) draft = '';
        return run(file, args, options);
      };
      const result = await sendToTerminal(tmuxLive(), reply, deps, {
        replaceDraft: 'half-written idea',
        backup: async () => {},
      });
      assert.equal(result.status, 'sent', reply.slice(0, 20));
      assert.ok(sent(calls));
    });
  // The inferred case (Orca, text the keys never touch after the draft went) refuses a long
  // reply shown in part: tested below with what it would hide.
});

test('Blank rows in the box are no empty prompt, and a box that may hide text is never cleared', async () => {
  // 'secret\n\n\n\n\nmore' with the cursor on the blank lines: a box of 3 rows (height 16)
  // shows only blank rows; the secret is above, out of view.
  const blank = [
    '⏺ Done.',
    '',
    `${RULE} ao-send-test ─`,
    '❯ ',
    '  ',
    '  ',
    RULE,
    '  ⏸ manual mode on',
  ].join('\n');
  const { deps, calls } = fakeDeps('/x', { screen: () => blank, paneHeight: 16 });
  const asked = await sendToTerminal(tmuxLive(), 'hi', deps, { backup: async () => {} });
  assert.equal(asked.status, 'needs-confirm');
  assert.equal(asked.status === 'needs-confirm' && asked.partial, true);
  assert.equal(
    (
      await sendToTerminal(tmuxLive(), 'hi', deps, {
        replaceDraft: asked.status === 'needs-confirm' ? asked.draft : '',
        backup: async () => {},
      })
    ).status,
    'needs-confirm',
  );
  assert.ok(!typedAny(calls) && !sent(calls) && !calls.some((c) => clears(c.args)));
});

test('The clipboard notice holds only while the clipboard still holds the earlier text', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    let draft = 'first\nsecond';
    const { deps } = fakeDeps(dir, { screen: (typed) => claudeScreen(typed || draft) });
    const run = deps.run;
    deps.run = async (file, args, options) => {
      // The first step lets someone type on: the clearing stops with the backup made.
      if (clears(args)) {
        draft = 'first typed';
        return '';
      }
      return run(file, args, options);
    };
    let clipboard = '';
    const backup = async (text: string) => {
      clipboard = text;
    };
    const first = await sendToTerminal(tmuxLive(), 'hi', deps, {
      replaceDraft: 'first\nsecond',
      backup,
      clipboardText: () => clipboard,
    });
    assert.equal(first.status === 'needs-confirm' && first.clipboard, true);
    const again = () =>
      sendToTerminal(tmuxLive(), 'hi', deps, { backup, clipboardText: () => clipboard });
    assert.equal(((await again()) as { clipboard?: boolean }).clipboard, true);
    // The person copied something else: the earlier text is gone from there, and so is the note.
    clipboard = 'something else';
    assert.equal(((await again()) as { clipboard?: boolean }).clipboard, undefined);
  });
});

test('The send flow only types for agents whose composer it can read', async () => {
  for (const composer of [codexQueueComposer, composerFor('openclaw')]) {
    const { deps, calls } = fakeDeps('/x');
    await assert.rejects(
      sendToTerminal(tmuxLive(), 'hi', deps, { composer }),
      /여기서 보낼 수 없어요/,
    );
    assert.ok(!typedAny(calls) && !sent(calls), composer.agent);
    assert.ok(!calls.some((c) => c.args.includes('capture-pane')));
  }
});

test('While working, the default footer still lets a follow-up through', async () => {
  await withSessions({ '4242.json': record(4242, { status: 'busy' }) }, async (dir) => {
    const { deps, calls } = fakeDeps(dir, {
      screen: (typed) =>
        `${claudeScreen(typed)}${typed ? '' : '\n  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt'}`,
    });
    assert.match(await said(sendToTerminal(tmuxLive('busy'), 'stop, do B', deps)), /대기열/);
    assert.ok(sent(calls));
  });
});

test('A leading ! never reaches the prompt, where it would switch to shell mode', async () => {
  const { deps, calls } = fakeDeps('/x');
  await assert.rejects(sendToTerminal(tmuxLive(), '!rm -rf build', deps), /셸 명령/);
  assert.equal(calls.length, 0);
});

test('A scrolled-back tmux pane or an unreadable screen gets nothing', async () => {
  const scrolled = fakeDeps('/x', { paneMode: '1' });
  await assert.rejects(sendToTerminal(tmuxLive(), 'hi', scrolled.deps), TerminalInputError);
  assert.ok(!typedAny(scrolled.calls));
  const unreadable = fakeDeps('/x', {
    fail: (file, args) =>
      file === '/bin/orca' && args[1] === 'read' ? new Error('old Orca') : undefined,
  });
  await assert.rejects(sendToTerminal(orcaLive(), 'hi', unreadable.deps), /화면을 읽지 못해서/);
  assert.ok(!typedAny(unreadable.calls));
  // Past output standing in for a screen Orca cannot render is never trusted.
  const fallback = fakeDeps('/x', { orcaSource: 'screen-unavailable' });
  await assert.rejects(sendToTerminal(orcaLive(), 'hi', fallback.deps), /화면을 읽지 못해서/);
  assert.ok(!typedAny(fallback.calls));
});

test('Orca taking the text but refusing Enter says the text is waiting there', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    const { deps } = fakeDeps(dir, { enterRefused: true });
    await assert.rejects(
      sendToTerminal(orcaLive(), 'hi', deps),
      /글은 넣었지만 Enter를 보내지 못했어요/,
    );
  });
});

test('A permission prompt opening right after Enter is reported, not hidden', async () => {
  await withSessions({ '4242.json': record(4242, { status: 'busy' }) }, async (dir) => {
    const { deps } = fakeDeps(dir);
    const run = deps.run;
    deps.run = async (file, args, options) => {
      const out = await run(file, args, options);
      if (args.includes('send-keys'))
        await writeFile(path.join(dir, '4242.json'), record(4242, { status: 'waiting' }));
      return out;
    };
    assert.match(await said(sendToTerminal(tmuxLive('busy'), 'hi', deps)), /바로 승인 창이 떴어요/);
  });
});

test('tmux does not press Enter when the record shows a prompt after the paste', async () => {
  for (const [from, to] of [
    ['idle', 'waiting'],
    ['busy', 'waiting'],
    ['shell', 'waiting'],
  ]) {
    await withSessions({ '4242.json': record(4242, { status: from }) }, async (dir) => {
      const { deps, calls } = fakeDeps(dir);
      const wait = deps.wait;
      deps.wait = async (ms) => {
        await writeFile(path.join(dir, '4242.json'), record(4242, { status: to }));
        await wait(ms);
      };
      await assert.rejects(sendToTerminal(tmuxLive(from), 'hi', deps), TerminalInputError);
      assert.ok(!sent(calls), `${from} → ${to}`);
    });
  }
});

test('A turn starting or ending around the paste still submits', async () => {
  for (const [from, to] of [
    ['idle', 'busy'],
    ['busy', 'idle'],
    ['busy', 'shell'],
  ]) {
    await withSessions({ '4242.json': record(4242, { status: from }) }, async (dir) => {
      const { deps, calls } = fakeDeps(dir);
      const wait = deps.wait;
      deps.wait = async (ms) => {
        await writeFile(path.join(dir, '4242.json'), record(4242, { status: to }));
        await wait(ms);
      };
      const message = await said(sendToTerminal(tmuxLive(from), 'hi', deps));
      assert.ok(sent(calls), `${from} → ${to}`);
      assert.equal(/대기열/.test(message), to === 'busy', message);
    });
  }
});

test('A working session takes a follow-up into its queue', async () => {
  assert.equal(terminalTarget(orcaLive('busy')).canSend, true);
  // At rest with a background shell running, the prompt is open too.
  assert.equal(terminalTarget(orcaLive('shell')).canSend, true);
  await withSessions({ '4242.json': record(4242, { status: 'busy' }) }, async (dir) => {
    for (const live of [orcaLive('busy'), tmuxLive('busy')]) {
      const { deps, calls } = fakeDeps(dir);
      assert.match(await said(sendToTerminal(live, 'stop, do B', deps)), /대기열/);
      assert.ok(sent(calls), live.host.kind);
    }
  });
});

test('Sends to one session wait their turn instead of typing into each other', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    for (const live of [orcaLive(), tmuxLive()]) {
      const { deps, calls } = fakeDeps(dir);
      const results = await Promise.all([
        sendToTerminal(live, 'first', deps),
        sendToTerminal(live, 'second', deps),
      ]);
      assert.equal(results.length, 2, live.host.kind);
      const order = calls
        .filter(
          (c) =>
            c.args.includes('send-keys') ||
            c.args.includes('--enter') ||
            c.args.includes('load-buffer') ||
            c.args.some((a) => a.startsWith('--text=')),
        )
        .map((c) =>
          c.args.includes('send-keys') || c.args.includes('--enter') ? 'enter' : 'type',
        );
      assert.deepEqual(order, ['type', 'enter', 'type', 'enter'], live.host.kind);
    }
  });
});

test('A send that waited its turn looks again before typing', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    const { deps, calls } = fakeDeps(dir);
    const run = deps.run;
    deps.run = async (file, args, options) => {
      const out = await run(file, args, options);
      // The first text was `/clear`: the same process moves on to a new session.
      if (args.includes('send-keys'))
        await writeFile(
          path.join(dir, '4242.json'),
          record(4242, { sessionId: 'another-session-0001' }),
        );
      return out;
    };
    const [first, second] = await Promise.allSettled([
      sendToTerminal(tmuxLive(), '/clear', deps),
      sendToTerminal(tmuxLive(), 'follow-up', deps),
    ]);
    assert.equal(first.status, 'fulfilled');
    assert.equal(second.status, 'rejected');
    assert.equal(calls.filter((c) => c.args.includes('paste-buffer')).length, 1);
  });
});

test('A pause during the screen checks stops Enter', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    let paused = false;
    const { deps, calls } = fakeDeps(dir, {
      screen: (typed, read) => {
        if (read === 2) paused = true;
        return claudeScreen(read < 2 ? '' : typed);
      },
    });
    const run = deps.run;
    deps.run = (file, args, options) =>
      args.includes('stat=,pgid=,tpgid=') && paused
        ? Promise.resolve('T 4242 4242\n')
        : run(file, args, options);
    await assert.rejects(sendToTerminal(tmuxLive(), 'hi', deps), TerminalInputError);
    assert.ok(!sent(calls));
  });
});

test('A failed tmux paste removes the buffer holding the text', async () => {
  const { deps, calls } = fakeDeps('/x', {
    fail: (_file, args) => (args.includes('paste-buffer') ? new Error('no pane') : undefined),
  });
  await assert.rejects(sendToTerminal(tmuxLive(), 'secret draft', deps));
  const buffer = calls.find((c) => c.args.includes('load-buffer'))!.args[4];
  assert.ok(calls.some((c) => c.args.join(' ') === `-S ${SOCKET} delete-buffer -b ${buffer}`));
  assert.ok(!sent(calls));
});

test('A prompt awaiting an answer, or any status not known to be open, never receives input', async () => {
  for (const status of ['waiting', 'starting', '']) {
    // A permission prompt or plan approval on screen would take the text as its answer.
    assert.equal(terminalTarget(orcaLive(status)).canSend, false, status);
    const { deps, calls } = fakeDeps('/x');
    await assert.rejects(sendToTerminal(orcaLive(status), 'hi', deps), TerminalInputError);
    await assert.rejects(sendToTerminal(tmuxLive(status), 'hi', deps), TerminalInputError);
    assert.equal(calls.length, 0);
  }
});

test('Input is refused unless the Claude process owns the terminal foreground', async () => {
  for (const fg of ['T 4242 4242', 'S 4242 5000', 'S+ 4242 -1', '']) {
    const { deps, calls } = fakeDeps('/x', { fg });
    await assert.rejects(sendToTerminal(orcaLive(), 'hi', deps), TerminalInputError, fg);
    assert.ok(!calls.some((c) => c.file === '/bin/orca' || c.file === '/bin/tmux'), fg);
  }
});

test('Focus switches the exact Orca terminal or tmux pane', async () => {
  const orca = fakeDeps('/x');
  await focusTerminal(orcaLive(), orca.deps);
  assert.deepEqual(orca.calls[0].args, ['terminal', 'switch', `--terminal=${HANDLE}`, '--json']);
  assert.equal(orca.calls[1].file, '/usr/bin/open');
  assert.deepEqual(orca.calls[1].args, ['-a', 'Orca']);
  const lost = fakeDeps('/x', {
    orcaSwitch: { ok: true, result: { focus: { navigated: false } } },
  });
  await assert.rejects(focusTerminal(orcaLive(), lost.deps), TerminalInputError);
  const transportError = new Error('private command details');
  const broken = fakeDeps('/x', { fail: () => transportError });
  await assert.rejects(
    focusTerminal(orcaLive(), broken.deps),
    (error) => error === transportError && !(error instanceof TerminalInputError),
  );
  const tmux = fakeDeps('/x', {
    fail: (_file, args) => (args.includes('switch-client') ? new Error('no client') : undefined),
  });
  await focusTerminal(tmuxLive(), tmux.deps);
  assert.deepEqual(
    tmux.calls.map((c) => c.args.slice(2)),
    [
      ['select-window', '-t', '%3'],
      ['select-pane', '-t', '%3'],
      ['switch-client', '-t', '%3'],
    ],
  );
});

test('The shared service (also the web preview RPC) can neither reach terminals nor enable sending', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-terminal-rpc-'));
  const service = new OfficeService(path.join(temp, 'data'), temp);
  try {
    for (const method of ['terminal', 'jump', 'send', 'terminal-send', 'terminalSend'])
      await assert.rejects(service.call(method, ['id', 'text']), /지원하지 않는 요청/);
    await assert.rejects(service.call('preferences', [{ terminalSend: true }]));
    assert.equal('terminalSend' in service.store.preferences(), false);
  } finally {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  }
});

test('Cheap polls reuse host checks, while actions always look again', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    const { deps, calls } = fakeDeps(dir, { env: ORCA_ENV, orcaShow: orcaShow() });
    const orcaCalls = () => calls.filter((c) => c.file === '/bin/orca').length;
    assert.ok(await locateTerminal(SESSION, { deps }));
    await new Promise((r) => setTimeout(r, 1600)); // past the merge window
    assert.ok(await locateTerminal(SESSION, { deps }));
    assert.equal(orcaCalls(), 1, 'a poll within 15s reuses the host check');
    assert.ok(await locateTerminal(SESSION, { deps, fresh: true }));
    assert.equal(orcaCalls(), 2, 'a fresh lookup (send/jump) asks Orca again');
    // The process record is re-read by a fresh lookup too: a session that started working is seen.
    await writeFile(path.join(dir, '4242.json'), record(4242, { status: 'busy' }));
    assert.equal((await locateTerminal(SESSION, { deps, fresh: true }))?.process.status, 'busy');
  });
});

test('A failed process inspection is not remembered', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    let broken = true;
    const { deps } = fakeDeps(dir, {
      env: ORCA_ENV,
      orcaShow: orcaShow(),
      fail: (file, args) => (broken && args.includes('-axo') ? new Error('ps failed') : undefined),
    });
    assert.equal(await locateTerminal(SESSION, { deps, fresh: true }), null);
    broken = false;
    await new Promise((r) => setTimeout(r, 1100)); // the shared process table expires
    assert.ok(await locateTerminal(SESSION, { deps, fresh: true }));
  });
});

test('Optional mobile authority is checked before paste and again before Enter', async () => {
  for (const live of [orcaLive(), tmuxLive()]) {
    await withSessions({ '4242.json': record(4242) }, async (dir) => {
      const first = fakeDeps(dir);
      await assert.rejects(
        sendToTerminal(live, 'hi', first.deps, {
          beforeSend: () => {
            throw new Error('revoked');
          },
        }),
        /revoked/,
      );
      assert.ok(!typedAny(first.calls) && !sent(first.calls));
      const second = fakeDeps(dir);
      let checks = 0;
      await assert.rejects(
        sendToTerminal(live, 'hi', second.deps, {
          beforeSend: () => {
            if (++checks === 2) throw new Error('revoked');
          },
        }),
        /revoked/,
      );
      assert.ok(typedAny(second.calls) && !sent(second.calls));
    });
  }
});

test('Partial replacement needs its own opt-in, then verifies empty and sends with a partial backup notice', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    for (const live of [tmuxLive(), orcaLive()]) {
      let draft = 'see [Pasted text #1 +12 lines]';
      const { deps, calls } = fakeDeps(dir, {
        screen: (typed) => claudeScreen(typed || draft),
        ...(live.host.kind === 'orca' && { orcaDraft: (typed: string) => typed || draft }),
      });
      const { log, backup } = steps(deps);
      const first = await sendToTerminal(live, 'hi', deps, { backup });
      assert.equal(first.status === 'needs-confirm' && first.partial, true);
      assert.ok(!typedAny(calls) && !sent(calls));
      const again = await sendToTerminal(live, 'hi', deps, { replaceDraft: draft, backup });
      assert.equal(again.status, 'needs-confirm');
      assert.ok(!calls.some((c) => clears(c.args)));
      const run = deps.run;
      deps.run = async (file, args, options) => {
        if (clears(args)) draft = '';
        return run(file, args, options);
      };
      const result = await sendToTerminal(live, 'hi', deps, {
        replaceDraft: draft,
        allowPartialDraft: true,
        backup,
      });
      assert.equal(result.status, 'sent');
      assert.equal(result.status === 'sent' && result.partialBackup, true);
      assert.ok(sent(calls));
      assert.ok(log.indexOf('clipboard:see [Pasted text #1 +12 lines]') < log.indexOf('clear'));
    }
  });
});

test('Even opted-in partial clearing rechecks changed content and never submits if clearing stays stuck', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    const draft = '[Image #1]';
    const { deps, calls } = fakeDeps(dir, { screen: () => claudeScreen(draft) });
    assert.equal(
      (
        await sendToTerminal(tmuxLive(), 'hi', deps, {
          replaceDraft: 'different',
          allowPartialDraft: true,
          backup: async () => {},
        })
      ).status,
      'needs-confirm',
    );
    assert.ok(!calls.some((c) => clears(c.args)));
    await assert.rejects(
      sendToTerminal(tmuxLive(), 'hi', deps, {
        replaceDraft: draft,
        allowPartialDraft: true,
        backup: async () => {},
      }),
      /비우지 못해/,
    );
    assert.ok(!typedAny(calls) && !sent(calls));
  });
});

test('lookupTerminal: none only without a live Claude; an unverified terminal is unknown', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    const found = fakeDeps(dir, { env: ORCA_ENV, orcaShow: orcaShow() });
    assert.equal((await lookupTerminal(SESSION, { deps: found.deps, fresh: true })).kind, 'found');
    // Running in another terminal app: the conversation is somewhere, never "no terminal".
    const elsewhere = fakeDeps(dir, {
      table: processTable('/Applications/iTerm.app/Contents/MacOS/iTerm2'),
    });
    assert.equal(
      (await lookupTerminal(SESSION, { deps: elsewhere.deps, fresh: true })).kind,
      'unknown',
    );
    const gone = fakeDeps(dir, { alive: [] });
    assert.equal((await lookupTerminal(SESSION, { deps: gone.deps, fresh: true })).kind, 'none');
  });
});

test('claudeAbsent: "none" only after a successful absence check', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    // A reused PID (another start time) or a gone process is absent.
    assert.equal(await claudeAbsent(SESSION, fakeDeps(dir, { alive: [] }).deps), true);
    assert.equal(
      await claudeAbsent(
        SESSION,
        fakeDeps(dir, { lstart: { 4242: 'Wed Oct  7 10:00:00 2026' } }).deps,
      ),
      true,
    );
    assert.equal(await claudeAbsent('another-session', fakeDeps(dir).deps), true);
    // Alive with its start time: present.
    assert.equal(await claudeAbsent(SESSION, fakeDeps(dir).deps), false);
    // `ps` failing while the PID is alive proves nothing.
    const psFails = fakeDeps(dir, {
      fail: (file, args) =>
        file === '/bin/ps' && args.includes('lstart=') ? new Error('ps') : undefined,
    });
    assert.equal(await claudeAbsent(SESSION, psFails.deps), false);
    assert.equal(
      (await lookupTerminal(SESSION, { deps: psFails.deps, fresh: true })).kind,
      'unknown',
    );
  });
  // An unparsable record that mentions the session is not evidence of absence.
  await withSessions({ '4242.json': `{"sessionId":"${SESSION}",` }, async (dir) => {
    assert.equal(await claudeAbsent(SESSION, fakeDeps(dir).deps), false);
  });
  await withSessions({ '4242.json': '{broken' }, async (dir) => {
    assert.equal(await claudeAbsent(SESSION, fakeDeps(dir).deps), true);
  });
  // No records folder at all: nothing runs. A folder that cannot be read: unknown.
  assert.equal(await claudeAbsent(SESSION, fakeDeps('/nonexistent/claude-sessions').deps), true);
  await withSessions({ 'not-a-dir': '' }, async (dir) => {
    assert.equal(await claudeAbsent(SESSION, fakeDeps(path.join(dir, 'not-a-dir')).deps), false);
  });
});
