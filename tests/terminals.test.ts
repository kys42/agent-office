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
  sendToTerminal,
  terminalTarget,
  TerminalInputError,
  type LiveTerminal,
  type TerminalDeps,
} from '../desktop/terminals.js';
import { OfficeService } from '../server/service.js';

const SESSION = '6dfc48fb-f723-4025-aab6-eaa73f743e5b';
const START = 'Tue Oct  6 13:05:12 2026';
const HANDLE = 'term_205af179-74b5-4973-9cd8-0fb07bf63fa9';
const TAB = '75d9bc44-0187-4bcf-bec0-d3f8e1ce6a7f';
const ARGS = 'claude -n ao-send-test';

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

/** Fake process table and CLIs. Every call is recorded so tests can check exact arguments. */
function fakeDeps(
  sessionsDir: string,
  options: {
    alive?: number[];
    lstart?: Record<number, string>;
    env?: string;
    args?: string;
    tty?: string;
    tmuxShow?: string;
    orcaShow?: unknown;
    orcaSend?: unknown;
  } = {},
) {
  const calls: { file: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const deps: TerminalDeps = {
    sessionsDir,
    alive: (pid) => (options.alive ?? [4242]).includes(pid),
    bin: (name) => `/bin/${name}`,
    wait: async () => {},
    run: async (file, args, env) => {
      calls.push({ file, args, env });
      if (file === '/bin/ps') {
        const pid = Number(args.at(-1));
        if (args.includes('lstart=')) return `${options.lstart?.[pid] ?? START}   \n`;
        if (args.includes('-wwE')) return `${options.args ?? ARGS} ${options.env ?? ''}\n`;
        if (args.includes('-ww')) return `${options.args ?? ARGS}\n`;
        if (args.includes('tty=')) return `${options.tty ?? 'ttys012'} \n`;
      }
      if (file === '/bin/tmux' && args.includes('display-message')) return options.tmuxShow ?? '';
      if (file === '/bin/orca' && args[1] === 'show') return JSON.stringify(options.orcaShow ?? {});
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
      assert.equal(lstart.env?.TZ, 'UTC');
      assert.equal(lstart.env?.LC_ALL, 'C');

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
  const env = `HOME=/Users/me ORCA_TERMINAL_HANDLE=${HANDLE} ORCA_TAB_ID=${TAB} TMUX=/private/tmp/tmux-501/default,812,0 TMUX_PANE=%3`;
  assert.deepEqual(parseProcessEnv(`${args} ${env}`, args), {
    orcaHandle: HANDLE,
    orcaTab: TAB,
    tmuxSocket: '/private/tmp/tmux-501/default',
    tmuxPane: '%3',
  });
  // Arguments alone carry no environment.
  assert.deepEqual(parseProcessEnv(args, args), {
    orcaHandle: undefined,
    orcaTab: undefined,
    tmuxSocket: undefined,
    tmuxPane: undefined,
  });
  // Malformed values are ignored rather than passed to a CLI.
  assert.equal(parseProcessEnv(`x TMUX_PANE=%1;rm`, 'x').tmuxPane, undefined);
  assert.equal(parseProcessEnv(`x ORCA_TERMINAL_HANDLE=term_a$b`, 'x').orcaHandle, undefined);
});

test('tmux is accepted only when the pane tty is the process tty', async () => {
  const env = `TMUX=/private/tmp/tmux-501/default,812,0 TMUX_PANE=%3 ORCA_TERMINAL_HANDLE=${HANDLE}`;
  const ok = fakeDeps('/x', { env, tmuxShow: '/dev/ttys012\twork:1.0\n' });
  assert.deepEqual(await findHost(4242, ok.deps), {
    kind: 'tmux',
    socket: '/private/tmp/tmux-501/default',
    pane: '%3',
    label: 'work:1.0',
  });
  const display = ok.calls.find((c) => c.args.includes('display-message'))!;
  assert.deepEqual(display.args.slice(0, 6), [
    '-S',
    '/private/tmp/tmux-501/default',
    'display-message',
    '-p',
    '-t',
    '%3',
  ]);
  // A pane on another tty falls through to Orca, which is not running here.
  const other = fakeDeps('/x', { env, tmuxShow: '/dev/ttys099\twork:1.0\n' });
  assert.equal(await findHost(4242, other.deps), null);
});

test('Orca is accepted only for a connected, writable terminal of the same tab', async () => {
  const env = `ORCA_TERMINAL_HANDLE=${HANDLE} ORCA_TAB_ID=${TAB}`;
  const ok = fakeDeps('/x', { env, orcaShow: orcaShow() });
  assert.deepEqual(await findHost(4242, ok.deps), {
    kind: 'orca',
    handle: HANDLE,
    title: '✳ ao-send-test',
  });
  for (const over of [
    { connected: false },
    { writable: false },
    { orphaned: true },
    { tabId: 'another-tab' },
    { handle: 'term_other' },
  ]) {
    const bad = fakeDeps('/x', { env, orcaShow: orcaShow(over) });
    assert.equal(await findHost(4242, bad.deps), null, JSON.stringify(over));
  }
  const none = fakeDeps('/x', { env: 'HOME=/Users/me' });
  assert.equal(await findHost(4242, none.deps), null);
});

test('Locating combines process and host; the renderer view never carries a handle', async () => {
  await withSessions({ '4242.json': record(4242, { status: 'busy' }) }, async (dir) => {
    const { deps } = fakeDeps(dir, {
      env: `ORCA_TERMINAL_HANDLE=${HANDLE} ORCA_TAB_ID=${TAB}`,
      orcaShow: orcaShow(),
    });
    const live = await locateTerminal(SESSION, { fresh: true, deps });
    assert.ok(live);
    const view = terminalTarget(live);
    assert.deepEqual(view, {
      kind: 'orca',
      label: '✳ ao-send-test',
      status: 'busy',
      canSend: false,
    });
    assert.ok(!JSON.stringify(view).includes(HANDLE));
  });
});

test('Input is plain typed text within limits', () => {
  assert.equal(cleanInput('  hi\r\nthere\u001b[31m\u0007\t!  '), 'hi\nthere[31m\t!');
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
  host: { kind: 'tmux', socket: '/private/tmp/tmux-501/default', pane: '%3', label: 'work:1.0' },
});

test('Orca sends one submitted prompt and reports a started turn', async () => {
  const { deps, calls } = fakeDeps('/x', {
    orcaSend: {
      ok: true,
      result: { send: { accepted: true, prompt: { stages: ['input_accepted', 'turn_started'] } } },
    },
  });
  assert.match(await sendToTerminal(orcaLive(), 'next\nstep', deps), /작업이 시작됐어요/);
  assert.deepEqual(calls.at(-1)!.args, [
    'terminal',
    'send',
    '--terminal',
    HANDLE,
    '--text',
    'next\nstep',
    '--enter',
    '--wait-submit',
    '5',
    '--json',
  ]);
  const refused = fakeDeps('/x', { orcaSend: { ok: true, result: { send: { accepted: false } } } });
  await assert.rejects(sendToTerminal(orcaLive(), 'hi', refused.deps), TerminalInputError);
});

test('tmux pastes with bracketed paste, then submits with Enter', async () => {
  const { deps, calls } = fakeDeps('/x');
  await sendToTerminal(tmuxLive(), 'a\nb', deps);
  const tmux = calls.filter((c) => c.file === '/bin/tmux').map((c) => c.args);
  assert.equal(tmux.length, 3);
  const buffer = tmux[0][4];
  assert.match(buffer, /^agent-office-[\w-]+$/);
  assert.deepEqual(tmux[0], [
    '-S',
    '/private/tmp/tmux-501/default',
    'set-buffer',
    '-b',
    buffer,
    '--',
    'a\nb',
  ]);
  assert.deepEqual(tmux[1], [
    '-S',
    '/private/tmp/tmux-501/default',
    'paste-buffer',
    '-p',
    '-d',
    '-b',
    buffer,
    '-t',
    '%3',
  ]);
  assert.deepEqual(tmux[2], [
    '-S',
    '/private/tmp/tmux-501/default',
    'send-keys',
    '-t',
    '%3',
    'Enter',
  ]);
});

test('A working or shell-mode session never receives input', async () => {
  for (const status of ['busy', 'shell', 'waiting']) {
    const { deps, calls } = fakeDeps('/x');
    await assert.rejects(sendToTerminal(orcaLive(status), 'hi', deps), TerminalInputError);
    await assert.rejects(sendToTerminal(tmuxLive(status), 'hi', deps), TerminalInputError);
    assert.equal(calls.length, 0);
  }
});

test('Focus switches the exact Orca terminal or tmux pane', async () => {
  const orca = fakeDeps('/x');
  await focusTerminal(orcaLive(), orca.deps);
  assert.deepEqual(orca.calls[0].args, ['terminal', 'switch', '--terminal', HANDLE, '--json']);
  assert.deepEqual(orca.calls[1], { file: '/usr/bin/open', args: ['-a', 'Orca'], env: undefined });
  const tmux = fakeDeps('/x');
  await focusTerminal(tmuxLive(), tmux.deps);
  assert.deepEqual(
    tmux.calls.map((c) => c.args.slice(2)),
    [
      ['select-window', '-t', '%3'],
      ['select-pane', '-t', '%3'],
    ],
  );
});

test('The shared service (also the web preview RPC) cannot reach terminals; the opt-in is off by default', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-terminal-rpc-'));
  const service = new OfficeService(path.join(temp, 'data'), temp);
  try {
    for (const method of ['terminal', 'jump', 'send'])
      await assert.rejects(service.call(method, ['id', 'text']), /지원하지 않는 요청/);
    assert.equal(service.store.preferences().terminalSend, false);
    await service.call('preferences', [{ terminalSend: true }]);
    assert.equal(service.store.preferences().terminalSend, true);
    await assert.rejects(service.call('preferences', [{ terminalSend: 'yes' }]));
  } finally {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  }
});
