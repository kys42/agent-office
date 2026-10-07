import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cleanInput,
  findClaudeProcess,
  findHost,
  focusTerminal,
  locateTerminal,
  parseClaudeProcess,
  parseProcessEnv,
  ptyOwner,
  sendToTerminal,
  terminalTarget,
  TerminalInputError,
  type LiveTerminal,
  type RunOptions,
  type TerminalDeps,
} from '../desktop/terminals.js';
import { OfficeService } from '../server/service.js';

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
    fail?: (file: string, args: string[]) => Error | undefined;
  } = {},
) {
  const calls: { file: string; args: string[]; options?: RunOptions }[] = [];
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
      if (file === '/bin/tmux' && args.includes('display-message')) return options.tmuxShow ?? '';
      if (file === '/bin/orca' && args[1] === 'show') return JSON.stringify(options.orcaShow ?? {});
      if (file === '/bin/orca' && args[1] === 'switch')
        return JSON.stringify(
          options.orcaSwitch ?? { ok: true, result: { focus: { navigated: true } } },
        );
      if (file === '/bin/orca' && args[1] === 'send')
        return JSON.stringify(
          options.orcaSend ?? { ok: true, result: { send: { accepted: true } } },
        );
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
  assert.ok(ok.calls.some((c) => c.args.includes(`--terminal=${HANDLE}`)));
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
      canSend: false,
      canFocus: true,
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

test('Orca sends one submitted prompt, even text that starts with dashes', async () => {
  const { deps, calls } = fakeDeps('/x', {
    orcaSend: {
      ok: true,
      result: { send: { accepted: true, prompt: { stages: ['input_accepted', 'turn_started'] } } },
    },
  });
  assert.match(await sendToTerminal(orcaLive(), '--dry-run\nfirst', deps), /작업이 시작됐어요/);
  assert.deepEqual(calls.at(-1)!.args, [
    'terminal',
    'send',
    `--terminal=${HANDLE}`,
    '--text=--dry-run\nfirst',
    '--enter',
    '--wait-submit=5',
    '--json',
  ]);
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
    fail: (file) => (file === '/bin/orca' ? new Error('spawn failed') : undefined),
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
    assert.equal(tmux.length, 3);
    const buffer = tmux[0].args[4];
    assert.match(buffer, /^agent-office-[\w-]+$/);
    assert.deepEqual(tmux[0].args, ['-S', SOCKET, 'load-buffer', '-b', buffer, '-']);
    assert.equal(tmux[0].options?.input, 'const a = 1;\nb');
    assert.deepEqual(tmux[1].args, [
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
    assert.deepEqual(tmux[2].args, ['-S', SOCKET, 'send-keys', '-t', '%3', 'Enter']);
  });
});

test('tmux does not press Enter when the session started working after the paste', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    const { deps, calls } = fakeDeps(dir);
    const wait = deps.wait;
    deps.wait = async (ms) => {
      await writeFile(path.join(dir, '4242.json'), record(4242, { status: 'busy' }));
      await wait(ms);
    };
    await assert.rejects(sendToTerminal(tmuxLive(), 'hi', deps), TerminalInputError);
    assert.ok(!calls.some((c) => c.args.includes('send-keys')));
  });
});

test('A failed tmux paste removes the buffer holding the text', async () => {
  const { deps, calls } = fakeDeps('/x', {
    fail: (_file, args) => (args.includes('paste-buffer') ? new Error('no pane') : undefined),
  });
  await assert.rejects(sendToTerminal(tmuxLive(), 'secret draft', deps));
  const buffer = calls.find((c) => c.args.includes('load-buffer'))!.args[4];
  assert.ok(calls.some((c) => c.args.join(' ') === `-S ${SOCKET} delete-buffer -b ${buffer}`));
  assert.ok(!calls.some((c) => c.args.includes('send-keys')));
});

test('A working or shell-mode session never receives input', async () => {
  for (const status of ['busy', 'shell', 'waiting']) {
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
