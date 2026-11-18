import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  builtinScreen,
  composerHost,
  findHost,
  inspectTerminalDraft,
  locateTerminal,
  parseProcessEnv,
  promptHost,
  sendToTerminal,
  terminalTarget,
  type LiveTerminal,
  type RunOptions,
  type TerminalDeps,
  type TerminalHost,
} from '../desktop/terminals.js';
import {
  focusHost,
  focusTarget,
  hostName,
  hostWhere,
  ptyLeader,
  screenTitle,
  TerminalFocusError,
} from '../desktop/terminal-host.js';
import { placeOfProcess, reachHost } from '../desktop/host-app.js';
import { claudeLiveness } from '../desktop/launch-guard.js';
import { claudeTarget } from '../desktop/prompts/claude-target.js';
import type { BuiltinTerminals } from '../desktop/term-builtin.js';
import { TermHostError } from '../desktop/term-host/client.js';
import type { ScreenRead } from '../desktop/term-host/protocol.js';
import { setLocale } from '../src/shared/i18n/index.js';

/**
 * The built-in terminal as a place agents run (#401): recognised from its session's variable
 * only when the daemon vouches for it, read and typed into through the same send flow as tmux
 * and Orca (every check before typing and Enter included).
 */
process.env.AGENT_OFFICE_LOCALE = 'ko';
setLocale('ko');

const SESSION = '6dfc48fb-f723-4025-aab6-eaa73f743e5b';
const START = 'Tue Oct  6 13:05:12 2026';
const ARGS = 'claude --resume x';
const DAEMON = '/Applications/Agent Office.app/Contents/MacOS/Agent Office';
const BUILTIN: TerminalHost = { kind: 'builtin', session: 'ao-1', label: 'proj' };

/** claude(4242) leads ttys012, held by the daemon (3000): a built-in terminal session. */
const TABLE = [
  `  4242  3000 ttys012    claude`,
  `  5555  4242 ttys012    /bin/zsh`,
  `  3000     1 ??       ${DAEMON}`,
  `  9999     1 ttys099  -zsh`,
].join('\n');

const RULE = '─'.repeat(40);
const claudeScreen = (typed: string) =>
  [
    '⏺ Done.',
    '',
    `${RULE} proj ─`,
    `❯ ${typed.split('\n').join('\n  ')}`.trimEnd(),
    RULE,
    '  ⏸ manual mode on · ← for agents',
  ].join('\n');

const record = (pid: number, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    pid,
    sessionId: SESSION,
    procStart: START,
    status: 'idle',
    kind: 'interactive',
    updatedAt: 1000,
    ...over,
  });

/** A screen as the daemon reads it: rows and faint ranges. */
const read = (text: string, faint: [number, number][][] = [], title = '✳ proj'): ScreenRead => {
  const lines = text.split('\n');
  return {
    lines,
    faint: lines.map((_, i) => faint[i] ?? []),
    cols: 200,
    rows: lines.length,
    cursor: { x: 2, y: 3 },
    alternate: false,
    title,
  };
};

/**
 * A daemon with one session `ao-1` whose screen is Claude's prompt: what is written into it is
 * typed there (bracketed paste markers dropped), Ctrl+K/Ctrl+U empty it, Enter submits it.
 */
function fakeBuiltin(
  options: {
    sessions?: { id: string; pid: number; cwd?: string }[] | null;
    daemonPid?: number;
    screen?: (typed: string) => string;
    fail?: 'sessions' | 'write' | 'screen';
  } = {},
) {
  let typed = '';
  const writes: string[] = [];
  let screens = 0;
  const builtin: BuiltinTerminals = {
    async sessions() {
      if (options.fail === 'sessions') throw new TermHostError('unavailable', 'no answer');
      const sessions =
        options.sessions === undefined ? [{ id: 'ao-1', pid: 4242 }] : options.sessions;
      return sessions === null
        ? null
        : {
            daemonPid: options.daemonPid ?? 3000,
            sessions: sessions.map((s) => ({ cwd: '/work/proj', ...s }) as never),
          };
    },
    async screen(id) {
      if (options.fail === 'screen' || id !== 'ao-1')
        throw new TermHostError('unknown-session', `no session ${id}`);
      screens++;
      return read((options.screen ?? claudeScreen)(typed));
    },
    async write(id, data) {
      if (options.fail === 'write') throw new TermHostError('closed', 'closed');
      assert.equal(id, 'ao-1');
      writes.push(data);
      if (data === '\r') typed = '';
      else if (data === '\x0b\x15') typed = '';
      else typed += data.replace(/\x1b\[20[01]~/g, '');
    },
    async create() {
      throw new Error('never from a lookup');
    },
  };
  return {
    builtin,
    writes,
    get screens() {
      return screens;
    },
  };
}

function fakeDeps(
  sessionsDir: string,
  builtin: BuiltinTerminals | undefined,
  options: { env?: string; table?: string; fg?: string } = {},
) {
  const calls: { file: string; args: string[]; options?: RunOptions }[] = [];
  const deps: TerminalDeps = {
    sessionsDir,
    codexHome: '/nonexistent/codex-home',
    alive: (pid) => pid === 4242,
    bin: (name) => `/bin/${name}`,
    wait: async () => {},
    builtin,
    async run(file, args, runOptions) {
      calls.push({ file, args, options: runOptions });
      if (file === '/bin/ps') {
        if (args.includes('lstart=')) return `${START}   \n`;
        if (args.includes('-axo')) return options.table ?? TABLE;
        if (args.includes('-wwE'))
          return `${ARGS} ${options.env ?? 'AGENT_OFFICE_TERM_SESSION=ao-1 TERM=xterm-256color'}\n`;
        if (args.includes('-ww')) return `${ARGS}\n`;
        if (args.includes('stat=,pgid=,tpgid=')) return `${options.fg ?? 'S+ 4242 4242'}\n`;
      }
      return '';
    },
  };
  return { deps, calls };
}

async function withSessions(files: Record<string, string>, fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-builtin-'));
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the session variable is read from the environment only, never from the arguments', () => {
  assert.equal(parseProcessEnv(`${ARGS} AGENT_OFFICE_TERM_SESSION=ao-1`, ARGS).termSession, 'ao-1');
  const args = 'claude AGENT_OFFICE_TERM_SESSION=ao-9';
  assert.equal(parseProcessEnv(`${args} HOME=/x`, args).termSession, undefined);
  assert.equal(
    parseProcessEnv(`${ARGS} AGENT_OFFICE_TERM_SESSION=../x`, ARGS).termSession,
    undefined,
  );
  assert.equal('termSession' in parseProcessEnv(`${ARGS} HOME=/x`, ARGS), false);
});

test('the pty leader and its holder: the session process and the daemon', () => {
  assert.deepEqual(ptyLeader(TABLE, 4242), { leader: 4242, holder: 3000 });
  // A program started inside the session leads nothing: its leader is still the session's.
  assert.deepEqual(ptyLeader(TABLE, 5555), { leader: 4242, holder: 3000 });
  assert.deepEqual(ptyLeader('  7  3 pts/4  claude\n  3  1 ?  node', 7), { leader: 7, holder: 3 });
  assert.equal(ptyLeader(TABLE, 3000), null);
  assert.equal(ptyLeader(TABLE, 1), null);
});

test('a built-in session is a host only when the daemon vouches for that very process', async () => {
  await withSessions({}, async (dir) => {
    const found = async (builtin: BuiltinTerminals | undefined, env?: string, table?: string) =>
      findHost(4242, fakeDeps(dir, builtin, { env, table }).deps);
    assert.deepEqual(await found(fakeBuiltin().builtin), BUILTIN);
    // No built-in terminal in this process (the collector), or no daemon running.
    assert.equal(await found(undefined), null);
    assert.equal(await found(fakeBuiltin({ sessions: null }).builtin), null);
    assert.equal(await found(fakeBuiltin({ fail: 'sessions' }).builtin), null);
    // Another session, another process leading it, another holder than the daemon.
    assert.equal(await found(fakeBuiltin({ sessions: [{ id: 'ao-2', pid: 4242 }] }).builtin), null);
    assert.equal(await found(fakeBuiltin({ sessions: [{ id: 'ao-1', pid: 4243 }] }).builtin), null);
    assert.equal(await found(fakeBuiltin({ daemonPid: 3001 }).builtin), null);
    // tmux inside the built-in terminal is tmux's (an unverified pane: no host at all).
    assert.equal(
      await found(
        fakeBuiltin().builtin,
        'AGENT_OFFICE_TERM_SESSION=ao-1 TMUX=/tmp/t,1,0 TMUX_PANE=%1',
      ),
      null,
    );
    assert.equal(await found(fakeBuiltin().builtin, 'TERM=xterm'), null);
  });
});

test('a live Claude in the built-in terminal is located, named and runs there for the duplicate check', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    const { deps } = fakeDeps(dir, fakeBuiltin().builtin);
    const live = await locateTerminal(SESSION, { deps, fresh: true });
    assert.deepEqual(live?.host, BUILTIN);
    assert.deepEqual(terminalTarget(live!), {
      kind: 'builtin',
      label: 'proj',
      status: 'idle',
      canSend: true,
      canFocus: true,
      focus: { kind: 'builtin', label: 'proj' },
      images: 'attach',
    });
    assert.deepEqual(await claudeLiveness.lookup(SESSION, true, deps), {
      kind: 'found',
      terminal: { where: 'builtin' },
    });
    assert.equal(hostName(BUILTIN), '내장 터미널');
    assert.equal(hostWhere(BUILTIN), '내장 터미널 proj');
    assert.deepEqual(focusTarget(BUILTIN), { kind: 'builtin', label: 'proj' });
    assert.equal(claudeTarget(live!, undefined, deps).where, '내장 터미널 proj');
  });
});

test('its title comes from the daemon; an ended session shows none', async () => {
  const deps = { run: async () => '', bin: (n: string) => n };
  assert.equal(await screenTitle(BUILTIN, { ...deps, builtin: fakeBuiltin().builtin }), '✳ proj');
  assert.equal(
    await screenTitle(
      { ...BUILTIN, session: 'ao-gone' },
      { ...deps, builtin: fakeBuiltin().builtin },
    ),
    null,
  );
  await assert.rejects(screenTitle(BUILTIN, deps));
});

test('a built-in screen reads as a styled screen: rows, faint characters, height, caret', () => {
  assert.deepEqual(
    builtinScreen({
      lines: ['❯ try this', ''],
      faint: [[[2, 10]], []],
      cols: 80,
      rows: 2,
      cursor: { x: 2, y: 0 },
      alternate: true,
      title: '',
    }),
    {
      text: '❯ try this\n',
      faint: [[false, false, true, true, true, true, true, true, true, true], []],
      height: 2,
      alternate: true,
      cursor: { x: 2, y: 0 },
    },
  );
});

test('the composer and dialog hosts write the bytes a terminal sends', async () => {
  const fake = fakeBuiltin();
  const { deps } = fakeDeps('/nonexistent', fake.builtin);
  const io = composerHost(BUILTIN, deps);
  assert.equal(io.styled, true);
  assert.equal((await io.read())?.text, claudeScreen(''));
  await io.press(['C-k', 'C-u']);
  await io.press([]);
  await io.press(['l', 'BSpace', 'Right']);
  await io.submit();
  const prompt = promptHost(BUILTIN, deps);
  assert.equal(prompt.kind, 'builtin');
  await prompt.press(['Up', 'Down', 'Left', 'Right', 'Space', 'Enter']);
  await prompt.type('two\nlines');
  assert.deepEqual(fake.writes, [
    '\x0b\x15',
    'l\x7f\x1b[C',
    '\r',
    '\x1b[A\x1b[B\x1b[D\x1b[C \r',
    '\x1b[200~two\nlines\x1b[201~',
  ]);
  // Unreachable: nothing was written, said as such.
  const down = composerHost(
    BUILTIN,
    fakeDeps('/nonexistent', fakeBuiltin({ fail: 'write' }).builtin).deps,
  );
  await assert.rejects(down.press(['C-u']), /내장 터미널에 연결하지 못해서/);
  assert.equal(
    await composerHost(
      BUILTIN,
      fakeDeps('/x', fakeBuiltin({ fail: 'screen' }).builtin).deps,
    ).read(),
    null,
  );
  assert.equal(await composerHost(BUILTIN, fakeDeps('/x', undefined).deps).read(), null);
});

test('a reply goes through the same send flow: checks, paste, the screen again, then Enter', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    const fake = fakeBuiltin();
    const { deps, calls } = fakeDeps(dir, fake.builtin);
    const live = (await locateTerminal(SESSION, { deps, fresh: true }))!;
    const result = await sendToTerminal(live, 'const a = 1;\nb', deps);
    assert.deepEqual(result, { status: 'sent', message: '내장 터미널 proj에 보냈어요' });
    assert.deepEqual(fake.writes, ['\x1b[200~const a = 1;\nb\x1b[201~', '\r']);
    // Read before typing, after typing, and once more right before Enter.
    assert.ok(fake.screens >= 3);
    // The foreground was checked like any terminal's.
    assert.ok(calls.some((c) => c.args.includes('stat=,pgid=,tpgid=')));
  });
});

test('a suspended Claude or a draft in the box gets nothing typed', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    const paused = fakeBuiltin();
    const p = fakeDeps(dir, paused.builtin, { fg: 'T 4242 9999' });
    const live = (await locateTerminal(SESSION, { deps: p.deps, fresh: true }))!;
    await assert.rejects(sendToTerminal(live, 'hi', p.deps), /터미널 앞에 있지 않아요/);
    assert.deepEqual(paused.writes, []);
    const drafted = fakeBuiltin({ screen: () => claudeScreen('my draft') });
    const d = fakeDeps(dir, drafted.builtin);
    const liveD = (await locateTerminal(SESSION, { deps: d.deps, fresh: true }))!;
    await assert.rejects(sendToTerminal(liveD, 'hi', d.deps), /이미 글이 있어요/);
    const asked = await sendToTerminal(liveD, 'hi', d.deps, { backup: async () => {} });
    assert.equal(asked.status, 'needs-confirm');
    assert.deepEqual(drafted.writes, []);
    const inspected = await inspectTerminalDraft(liveD, undefined, d.deps);
    assert.equal(inspected?.draft, 'my draft');
  });
});

test('where a built-in session runs, unverified, and the way there', async () => {
  const env = parseProcessEnv(`${ARGS} AGENT_OFFICE_TERM_SESSION=ao-1`, ARGS);
  assert.deepEqual(placeOfProcess(TABLE, 4242, env, 'linux'), {
    where: 'builtin',
    host: { app: 'builtin', canGo: true },
    way: { kind: 'builtin', session: 'ao-1' },
  });
  // tmux inside it is tmux's.
  const inTmux = parseProcessEnv(
    `${ARGS} AGENT_OFFICE_TERM_SESSION=ao-1 TMUX=/tmp/t,1,0 TMUX_PANE=%2`,
    ARGS,
  );
  assert.equal(placeOfProcess(TABLE, 4242, inTmux, 'darwin').where, 'tmux');
  const deps = { run: async () => '', bin: (n: string) => n };
  // The app cannot show its screen yet: going there says so.
  await assert.rejects(
    reachHost(placeOfProcess(TABLE, 4242, env, 'darwin'), deps),
    (e: unknown) => e instanceof TerminalFocusError && /아직 여기서 열 수 없어요/.test(e.message),
  );
  const shown: string[] = [];
  const builtin = {
    ...fakeBuiltin().builtin,
    show: async (id: string) => (shown.push(id), 'opened'),
  };
  assert.deepEqual(
    await reachHost(placeOfProcess(TABLE, 4242, env, 'darwin'), { ...deps, builtin }),
    {
      action: 'focused',
      text: 'opened',
    },
  );
  assert.equal(await focusHost(BUILTIN, { ...deps, builtin }), 'opened');
  assert.deepEqual(shown, ['ao-1', 'ao-1']);
});

test('a built-in host sends nothing when the daemon cannot be reached mid-send', async () => {
  await withSessions({ '4242.json': record(4242) }, async (dir) => {
    const fake = fakeBuiltin();
    const { deps } = fakeDeps(dir, fake.builtin);
    const live: LiveTerminal = (await locateTerminal(SESSION, { deps, fresh: true }))!;
    const down = fakeBuiltin({ fail: 'write' });
    const d = fakeDeps(dir, down.builtin);
    await assert.rejects(sendToTerminal(live, 'hi', d.deps), /내장 터미널에 연결하지 못해서/);
    assert.deepEqual(down.writes, []);
  });
});

test('a Codex screen in the built-in terminal is found by the thread in its title', async () => {
  const { lookupCodexTerminal } = await import('../desktop/codex-focus.js');
  const THREAD = '019a0000-0000-7000-8000-000000000001';
  const fake = fakeBuiltin();
  fake.builtin.screen = async () => read('codex', [], `${THREAD} | proj`);
  const { deps } = fakeDeps('/nonexistent', fake.builtin, {
    table: TABLE.replace('ttys012    claude', 'ttys012    codex'),
  });
  const run = deps.run;
  // `ps -axo pid=,tty=,comm=` lists the screens; the four-column table finds the pty's leader.
  deps.run = async (file, args, options) =>
    file === '/bin/ps' && args.includes('pid=,tty=,comm=')
      ? `  4242 ttys012 codex\n  9999 ttys099 -zsh\n`
      : run(file, args, options);
  const found = await lookupCodexTerminal(THREAD, { deps, fresh: true });
  assert.equal(found.kind, 'found');
  assert.deepEqual(found.kind === 'found' && found.terminal.host, BUILTIN);
});
