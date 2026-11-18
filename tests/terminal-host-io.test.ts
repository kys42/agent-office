import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composerHost,
  promptHost,
  terminalTarget,
  type LiveTerminal,
  type RunOptions,
  type TerminalDeps,
  type TerminalHost,
} from '../desktop/terminals.js';
import { focusTarget, hostName, screenTitle } from '../desktop/terminal-host.js';
import { claudeTarget } from '../desktop/prompts/claude-target.js';
import { codexTarget } from '../desktop/codex-queue.js';
import { setLocale } from '../src/shared/i18n/index.js';

/**
 * What each terminal host does for the same request, call for call: the commands run, their
 * arguments and input, and what comes back. Pinned before the hosts were put in one table
 * (#401), so tmux and Orca behave exactly as they did, whatever else joins them.
 */
process.env.AGENT_OFFICE_LOCALE = 'ko';
setLocale('ko');

const SOCKET = '/private/tmp/tmux-501/default';
const HANDLE = 'term_205af179-74b5-4973-9cd8-0fb07bf63fa9';
const TMUX: TerminalHost = { kind: 'tmux', socket: SOCKET, pane: '%3', label: 'work:1.0' };
const ORCA: TerminalHost = {
  kind: 'orca',
  handle: HANDLE,
  title: '✳ ao-io',
  fullTitle: undefined,
};

interface Call {
  file: string;
  args: string[];
  input?: string;
  env?: boolean;
  timeout?: number;
}

/** `tmux capture-pane -e`: a faint suggestion after the prompt marker. */
const STYLED = '\x1b[0m❯ \x1b[2mtry this\x1b[0m\nplain row';

function fakeDeps(answers: (file: string, args: string[]) => string = () => '') {
  const calls: Call[] = [];
  const waits: number[] = [];
  const deps: TerminalDeps = {
    sessionsDir: '/nonexistent/sessions',
    codexHome: '/nonexistent/codex',
    alive: () => true,
    bin: (name) => `/bin/${name}`,
    wait: async (ms) => void waits.push(ms),
    async run(file: string, args: string[], options?: RunOptions) {
      calls.push({
        file,
        // A paste buffer's name is random: the rest of the call is what is pinned.
        args: args.map((a) => a.replace(/agent-office-[0-9a-f-]{36}/, 'agent-office-<uuid>')),
        ...(options?.input !== undefined && { input: options.input }),
        ...(options?.env && { env: true }),
        ...(options?.timeout !== undefined && { timeout: options.timeout }),
      });
      return answers(file, args);
    },
  };
  return { deps, calls, waits };
}

const tmuxAnswers = (_file: string, args: string[]) => {
  if (args.includes('display-message') && args.at(-1)?.startsWith('#{pane_in_mode}'))
    return '0 40 1 1 2 0\n';
  if (args.includes('display-message') && args.at(-1) === '#{pane_title}') return '✳ ao-io\n';
  if (args.includes('capture-pane')) return STYLED;
  return '';
};
const ORCA_ACCEPTED = JSON.stringify({ ok: true, result: { send: { accepted: true } } });
const orcaAnswers = (_file: string, args: string[]) => {
  if (args[1] === 'read')
    return JSON.stringify({
      ok: true,
      result: { terminal: { source: 'screen', tail: ['❯ hello', 'next'], draft: 'hello' } },
    });
  if (args[1] === 'show')
    return JSON.stringify({
      ok: true,
      result: {
        terminal: { handle: HANDLE, title: '✳ ao-io', connected: true, writable: true },
      },
    });
  if (args[1] === 'send') return ORCA_ACCEPTED;
  return '';
};

test('tmux composer host: styled screen, key names and Enter, exactly as before', async () => {
  const { deps, calls } = fakeDeps(tmuxAnswers);
  const io = composerHost(TMUX, deps);
  assert.equal(io.styled, true);
  const screen = await io.read();
  assert.deepEqual(screen, {
    text: '❯ try this\nplain row',
    faint: [
      [false, false, true, true, true, true, true, true, true, true],
      [false, false, false, false, false, false, false, false, false],
    ],
    height: 40,
    alternate: true,
    cursor: { x: 2, y: 0 },
  });
  await io.press(['C-k', 'C-u']);
  await io.press([]);
  await io.press(['l', 'BSpace', 'Right']);
  await io.submit();
  assert.deepEqual(calls, [
    {
      file: '/bin/tmux',
      args: [
        '-S',
        SOCKET,
        'display-message',
        '-p',
        '-t',
        '%3',
        '#{pane_in_mode} #{pane_height} #{alternate_on} #{alternate-screen} #{cursor_x} #{cursor_y}',
      ],
    },
    { file: '/bin/tmux', args: ['-S', SOCKET, 'capture-pane', '-p', '-e', '-t', '%3'] },
    { file: '/bin/tmux', args: ['-S', SOCKET, 'send-keys', '-t', '%3', 'C-k', 'C-u'] },
    {
      file: '/bin/tmux',
      args: ['-S', SOCKET, 'send-keys', '-t', '%3', 'l', 'BSpace', 'Right'],
    },
    { file: '/bin/tmux', args: ['-S', SOCKET, 'send-keys', '-t', '%3', 'Enter'] },
  ]);
});

test('tmux composer host: a pane in copy mode reads as no prompt; a failed read is null', async () => {
  const scrolled = fakeDeps((_f, args) => (args.includes('display-message') ? '1 40 0 1 0 0' : ''));
  assert.deepEqual(await composerHost(TMUX, scrolled.deps).read(), { text: '' });
  assert.equal(scrolled.calls.length, 1);
  const failing = fakeDeps(() => {
    throw new Error('no server');
  });
  assert.equal(await composerHost(TMUX, failing.deps).read(), null);
});

test('Orca composer host: plain screen, keys as bytes, its own Enter, exactly as before', async () => {
  const { deps, calls } = fakeDeps(orcaAnswers);
  const io = composerHost(ORCA, deps);
  assert.equal(io.styled, false);
  assert.deepEqual(await io.read(), { text: '❯ hello\nnext', composer: 'hello' });
  await io.press(['C-k', 'C-u']);
  await io.press(['l', 'BSpace', 'Right']);
  await io.submit();
  const send = (input: string) => ({
    file: '/bin/orca',
    args: ['terminal', 'send', `--terminal=${HANDLE}`, input, '--json'],
    env: true,
    timeout: 20000,
  });
  assert.deepEqual(calls, [
    {
      file: '/bin/orca',
      args: ['terminal', 'read', `--terminal=${HANDLE}`, '--screen', '--limit=200', '--json'],
      env: true,
    },
    send('--text=\x0b\x15'),
    send('--text=l\x7f\x1b[C'),
    send('--enter'),
  ]);
});

test('Orca composer host: past output instead of a screen is unreadable', async () => {
  const { deps } = fakeDeps((_f, args) =>
    args[1] === 'read'
      ? JSON.stringify({ result: { terminal: { source: 'history', tail: ['x'] } } })
      : '',
  );
  assert.equal(await composerHost(ORCA, deps).read(), null);
  const older = fakeDeps((_f, args) =>
    args[1] === 'read'
      ? JSON.stringify({ result: { terminal: { source: 'screen', tail: ['❯ a', 3] } } })
      : '',
  );
  assert.deepEqual(await composerHost(ORCA, older.deps).read(), { text: '❯ a' });
});

test('Orca refusing keys throws its reason', async () => {
  const { deps } = fakeDeps((_f, args) =>
    args[1] === 'send'
      ? JSON.stringify({ result: { send: { accepted: false, refusedReason: 'busy' } } })
      : '',
  );
  await assert.rejects(composerHost(ORCA, deps).press(['C-u']), /busy/);
});

test('tmux prompt host: dialog keys by name, text through a paste buffer', async () => {
  const { deps, calls } = fakeDeps(tmuxAnswers);
  const io = promptHost(TMUX, deps);
  assert.equal(io.kind, 'tmux');
  await io.press(['Up', 'Down', 'Left', 'Right', 'Space', 'Enter']);
  await io.press([]);
  await io.type('two\nlines;');
  assert.deepEqual(calls, [
    {
      file: '/bin/tmux',
      args: [
        '-S',
        SOCKET,
        'send-keys',
        '-t',
        '%3',
        'Up',
        'Down',
        'Left',
        'Right',
        'Space',
        'Enter',
      ],
    },
    {
      file: '/bin/tmux',
      args: ['-S', SOCKET, 'load-buffer', '-b', 'agent-office-<uuid>', '-'],
      input: 'two\nlines;',
    },
    {
      file: '/bin/tmux',
      args: ['-S', SOCKET, 'paste-buffer', '-p', '-d', '-b', 'agent-office-<uuid>', '-t', '%3'],
    },
  ]);
});

test('tmux prompt host: a failed paste deletes its buffer', async () => {
  const { deps, calls } = fakeDeps((_f, args) => {
    if (args.includes('paste-buffer')) throw new Error('no pane');
    return '';
  });
  await assert.rejects(promptHost(TMUX, deps).type('x'), /no pane/);
  assert.deepEqual(calls.at(-1), {
    file: '/bin/tmux',
    args: ['-S', SOCKET, 'delete-buffer', '-b', 'agent-office-<uuid>'],
  });
});

test('Orca prompt host: keys as bytes, Enter as its own submit, text as a bracketed paste', async () => {
  const { deps, calls } = fakeDeps(orcaAnswers);
  const io = promptHost(ORCA, deps);
  assert.equal(io.kind, 'orca');
  await io.press(['Up', 'Down', 'Left', 'Right', 'Space', 'Enter']);
  await io.press(['Enter']);
  await io.type('two\nlines');
  const send = (input: string) => ({
    file: '/bin/orca',
    args: ['terminal', 'send', `--terminal=${HANDLE}`, input, '--json'],
    env: true,
    timeout: 20000,
  });
  assert.deepEqual(calls, [
    send('--text=\x1b[A\x1b[B\x1b[D\x1b[C '),
    send('--enter'),
    send('--enter'),
    send('--text=\x1b[200~two\nlines\x1b[201~'),
  ]);
});

test('titles, names and what a window may know of each host', async () => {
  const tmux = fakeDeps(tmuxAnswers);
  assert.equal(await screenTitle(TMUX, tmux.deps), '✳ ao-io');
  assert.deepEqual(tmux.calls, [
    {
      file: '/bin/tmux',
      args: ['-S', SOCKET, 'display-message', '-p', '-t', '%3', '#{pane_title}'],
    },
  ]);
  const orca = fakeDeps(orcaAnswers);
  assert.equal(await screenTitle(ORCA, orca.deps), '✳ ao-io');
  assert.deepEqual(orca.calls, [
    {
      file: '/bin/orca',
      args: ['terminal', 'show', `--terminal=${HANDLE}`, '--json'],
      env: true,
    },
  ]);
  assert.equal(hostName(TMUX), 'tmux');
  assert.equal(hostName(ORCA), 'Orca');
  assert.deepEqual(focusTarget(TMUX), { kind: 'tmux', label: 'work:1.0' });
  assert.deepEqual(focusTarget(ORCA), { kind: 'orca', label: '✳ ao-io' });
  const live = (host: TerminalHost, status = 'idle'): LiveTerminal => ({
    host,
    process: {
      pid: 4242,
      sessionId: 's',
      procStart: 'x',
      status,
      kind: 'interactive',
    } as LiveTerminal['process'],
  });
  assert.deepEqual(terminalTarget(live(TMUX)), {
    kind: 'tmux',
    label: 'work:1.0',
    status: 'idle',
    canSend: true,
    canFocus: true,
    focus: { kind: 'tmux', label: 'work:1.0' },
    images: 'attach',
  });
  assert.deepEqual(terminalTarget(live(ORCA, 'waiting')), {
    kind: 'orca',
    label: '✳ ao-io',
    status: 'waiting',
    canSend: false,
    canFocus: true,
    focus: { kind: 'orca', label: '✳ ao-io' },
    images: 'attach',
  });
  assert.equal(claudeTarget(live(TMUX), undefined, tmux.deps).where, 'tmux work:1.0');
  assert.equal(claudeTarget(live(ORCA), undefined, orca.deps).where, 'Orca');
  assert.deepEqual(codexTarget(TMUX), {
    kind: 'codex',
    label: '',
    status: 'queue',
    canSend: true,
    canFocus: true,
    focus: { kind: 'tmux', label: 'work:1.0' },
    queues: true,
  });
});
