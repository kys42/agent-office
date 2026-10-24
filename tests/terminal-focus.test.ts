import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appBundleOf,
  focusHost,
  parseTmuxClients,
  TerminalFocusError,
  type TerminalHost,
  type TerminalHostDeps,
} from '../desktop/terminal-host.js';
import { setLocale } from '../src/shared/i18n/index.js';
import type { RunOptions } from '../server/adapters/claude-live.js';

setLocale('ko');

const SOCKET = '/private/tmp/tmux-501/agent-office';
const host: TerminalHost = {
  kind: 'tmux',
  socket: SOCKET,
  pane: '%7',
  label: 'office-claude-abc:0.0',
};

// The tmux client (pid 900) runs in a shell under login, under the terminal app.
const table = (app: string) =>
  [
    `  1     0 /sbin/launchd`,
    `500     1 ${app}`,
    `700   500 /usr/bin/login`,
    `800   700 -zsh`,
    `900   800 /opt/homebrew/bin/tmux`,
  ].join('\n');

interface Options {
  clients?: string;
  ps?: string;
  /** What osascript prints. */
  osascript?: string;
  /** The tmux client's environment (`ps -wwE`). */
  clientEnv?: string;
  orcaList?: Record<string, unknown>[];
  platform?: string;
  fail?: (file: string, args: string[]) => boolean;
}

function fake(options: Options = {}) {
  const calls: { file: string; args: string[]; options?: RunOptions }[] = [];
  const deps: TerminalHostDeps = {
    platform: options.platform ?? 'darwin',
    bin: (name) => `/bin/${name}`,
    async run(file, args, runOptions) {
      calls.push({ file, args, options: runOptions });
      if (options.fail?.(file, args)) throw new Error('failed');
      if (file === '/bin/tmux' && args.includes('list-clients')) return options.clients ?? '';
      if (file === '/bin/tmux' && args.includes('display-message')) return 'office-claude-abc\n';
      if (file === '/bin/ps' && args.includes('-wwE'))
        return `/opt/homebrew/bin/tmux ${options.clientEnv ?? ''}\n`;
      if (file === '/bin/ps' && args.includes('-ww')) return '/opt/homebrew/bin/tmux\n';
      if (file === '/bin/ps') return options.ps ?? '';
      if (file === '/usr/bin/osascript') return options.osascript ?? '';
      if (file === '/bin/orca' && args[1] === 'list')
        return JSON.stringify({ ok: true, result: { terminals: options.orcaList ?? [] } });
      if (file === '/bin/orca' && args[1] === 'switch')
        return JSON.stringify({ ok: true, result: { focus: { navigated: true } } });
      return '';
    },
  };
  return { deps, calls };
}

const tmuxArgs = (calls: { file: string; args: string[] }[]) =>
  calls.filter((c) => c.file === '/bin/tmux').map((c) => c.args.slice(2));

test('No attached client: macOS opens Terminal attached to the session, command passed as argv', async () => {
  const { deps, calls } = fake();
  const text = await focusHost(host, deps);
  assert.equal(text, '터미널을 열어 tmux office-claude-abc:0.0에 연결했어요');
  assert.deepEqual(tmuxArgs(calls), [
    ['select-window', '-t', '%7'],
    ['select-pane', '-t', '%7'],
    ['list-clients', '-t', '%7', '-F', '#{client_tty}\t#{client_pid}\t#{client_activity}'],
    ['display-message', '-p', '-t', '%7', '#{session_name}'],
  ]);
  const osa = calls.filter((c) => c.file === '/usr/bin/osascript');
  assert.equal(osa.length, 1);
  assert.deepEqual(osa[0].args, [
    '-e',
    'on run argv\ntell application "Terminal"\nactivate\ndo script (item 1 of argv)\nend tell\nend run',
    `'/bin/tmux' -S '${SOCKET}' attach-session -t '=office-claude-abc'`,
  ]);
  assert.ok(!calls.some((c) => c.args.includes('switch-client') || c.args.includes('send-keys')));
});

test('A session name with quotes stays one shell word', async () => {
  const { deps, calls } = fake();
  const run = deps.run;
  deps.run = async (file, args, o) =>
    args.includes('display-message') ? "it's\n" : run(file, args, o);
  await focusHost(host, deps);
  const osa = calls.find((c) => c.file === '/usr/bin/osascript');
  assert.equal(osa?.args[2], `'/bin/tmux' -S '${SOCKET}' attach-session -t '=it'\\''s'`);
});

test('A session name ending in `;` is escaped for tmux, which would take it as a separator', async () => {
  const { deps, calls } = fake();
  const run = deps.run;
  deps.run = async (file, args, o) =>
    args.includes('display-message') ? 'work;\n' : run(file, args, o);
  await focusHost(host, deps);
  const osa = calls.find((c) => c.file === '/usr/bin/osascript');
  assert.equal(osa?.args[2], `'/bin/tmux' -S '${SOCKET}' attach-session -t '=work\\;'`);
});

test('Terminal failing to open is reported, not claimed as success', async () => {
  const { deps } = fake({ fail: (file) => file === '/usr/bin/osascript' });
  await assert.rejects(
    focusHost(host, deps),
    (e) => e instanceof TerminalFocusError && /터미널을 열지 못했어요/.test(e.message),
  );
});

test('No attached client off macOS: an honest refusal with the attach command, nothing opened', async () => {
  const { deps, calls } = fake({ platform: 'linux' });
  await assert.rejects(
    focusHost(host, deps),
    (e) =>
      e instanceof TerminalFocusError &&
      e.message.includes('연결된 터미널이 없어요') &&
      e.message.includes(`attach-session -t '=office-claude-abc'`),
  );
  assert.ok(!calls.some((c) => c.file === '/usr/bin/osascript' || c.file === '/usr/bin/open'));
});

const TERMINAL = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal';
const ITERM = '/Applications/iTerm.app/Contents/MacOS/iTerm2';
const ORCA =
  '/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper';
// The most recently active client wins.
const CLIENTS = '/dev/ttys003\t901\t100\n/dev/ttys009\t900\t200\n';

for (const [name, app, scripted] of [
  ['Terminal', TERMINAL, 'tell application "Terminal"'],
  ['iTerm', ITERM, 'tell application "iTerm"'],
] as const) {
  test(`A client in ${name}: switched to the pane, and the tab with that client's tty selected`, async () => {
    const { deps, calls } = fake({ clients: CLIENTS, ps: table(app), osascript: 'ok\n' });
    const text = await focusHost(host, deps);
    assert.equal(text, `${name}에서 tmux office-claude-abc:0.0 패널로 이동했어요`);
    assert.deepEqual(tmuxArgs(calls).at(-1), ['switch-client', '-c', '/dev/ttys009', '-t', '%7']);
    const osa = calls.filter((c) => c.file === '/usr/bin/osascript');
    assert.equal(osa.length, 1);
    assert.equal(osa[0].args.length, 3);
    assert.equal(osa[0].args[0], '-e');
    assert.ok(osa[0].args[1].includes(scripted));
    // The tty is an argument, never part of the script.
    assert.ok(!osa[0].args[1].includes('ttys'));
    assert.equal(osa[0].args[2], '/dev/ttys009');
    assert.ok(!calls.some((c) => c.file === '/usr/bin/open' || c.args.includes('send-keys')));
  });

  test(`A client in ${name} whose tab is not found: the app raised, honestly no window picked`, async () => {
    for (const answer of ['none\n', undefined]) {
      const { deps, calls } = fake({
        clients: CLIENTS,
        ps: table(app),
        osascript: answer,
        fail: (file) => answer === undefined && file === '/usr/bin/osascript',
      });
      const text = await focusHost(host, deps);
      assert.match(text, /창·탭을 고르지는 못했어요/);
      assert.ok(text.includes(name));
      assert.equal(calls.filter((c) => c.file === '/usr/bin/open').length, 1);
    }
  });
}

test('A client in an Orca terminal: that terminal (from the client env, confirmed in the list) is switched to', async () => {
  const env = 'ORCA_TERMINAL_HANDLE=term_abc ORCA_TAB_ID=tab-1 HOME=/Users/x';
  const { deps, calls } = fake({
    clients: CLIENTS,
    ps: table(ORCA),
    clientEnv: env,
    orcaList: [{ handle: 'term_abc', tabId: 'tab-1', connected: true }],
  });
  const previous = process.env.ORCA_PAIRING_CODE;
  process.env.ORCA_PAIRING_CODE = 'remote';
  try {
    const text = await focusHost(host, deps);
    assert.equal(text, 'Orca에서 tmux office-claude-abc:0.0 패널로 이동했어요');
  } finally {
    if (previous === undefined) delete process.env.ORCA_PAIRING_CODE;
    else process.env.ORCA_PAIRING_CODE = previous;
  }
  const sw = calls.find((c) => c.file === '/bin/orca' && c.args[1] === 'switch');
  assert.deepEqual(sw?.args, ['terminal', 'switch', '--terminal=term_abc', '--json']);
  assert.equal(sw?.options?.env?.ORCA_PAIRING_CODE, undefined);
  assert.deepEqual(
    calls.filter((c) => c.file === '/usr/bin/open').map((c) => c.args),
    [['-a', 'Orca']],
  );
});

test('An Orca client whose terminal cannot be confirmed: Orca raised, honestly no tab picked', async () => {
  for (const [clientEnv, orcaList] of [
    ['HOME=/Users/x', [{ handle: 'term_abc', tabId: 'tab-1', connected: true }]],
    ['ORCA_TERMINAL_HANDLE=term_abc ORCA_TAB_ID=tab-1', []],
    [
      'ORCA_TERMINAL_HANDLE=term_abc ORCA_TAB_ID=tab-1',
      [{ handle: 'term_abc', tabId: 'tab-2', connected: true }],
    ],
  ] as const) {
    const { deps, calls } = fake({
      clients: CLIENTS,
      ps: table(ORCA),
      clientEnv,
      orcaList: [...orcaList],
    });
    assert.match(await focusHost(host, deps), /창·탭을 고르지는 못했어요/);
    assert.ok(!calls.some((c) => c.file === '/bin/orca' && c.args[1] === 'switch'));
    assert.deepEqual(
      calls.filter((c) => c.file === '/usr/bin/open').map((c) => c.args),
      [['-a', '/Applications/Orca.app']],
    );
  }
});

test('A client in another app (Ghostty): raised, and the message says no window was picked', async () => {
  const { deps, calls } = fake({
    clients: CLIENTS,
    ps: table('/Applications/Ghostty.app/Contents/MacOS/ghostty'),
  });
  const text = await focusHost(host, deps);
  assert.match(text, /Ghostty 앱을 앞으로 가져왔지만.*고르지는 못했어요/);
  assert.deepEqual(
    calls.filter((c) => c.file === '/usr/bin/open').map((c) => c.args),
    [['-a', '/Applications/Ghostty.app']],
  );
  assert.ok(!calls.some((c) => c.file === '/usr/bin/osascript'));
});

test('A client whose app cannot be found (ssh, daemonized server): pane switched, honestly not raised', async () => {
  const sshd = [
    '  1     0 /sbin/launchd',
    '600     1 /usr/sbin/sshd',
    '800   600 -zsh',
    '900   800 tmux',
  ].join('\n');
  for (const ps of [sshd, '']) {
    const { deps, calls } = fake({ clients: '/dev/ttys009\t900\t200\n', ps });
    const text = await focusHost(host, deps);
    assert.match(text, /앞으로 가져오지 못했어요/);
    assert.ok(calls.some((c) => c.args.includes('switch-client')));
    assert.ok(!calls.some((c) => c.file === '/usr/bin/open' || c.file === '/usr/bin/osascript'));
  }
  const failing = fake({
    clients: '/dev/ttys009\t900\t200\n',
    ps: table('/Applications/kitty.app/Contents/MacOS/kitty'),
    fail: (file) => file === '/usr/bin/open',
  });
  assert.match(await focusHost(host, failing.deps), /앞으로 가져오지 못했어요/);
});

test('A failing tmux selection is a transport error, not a success message', async () => {
  const { deps } = fake({ fail: (_f, args) => args.includes('select-pane') });
  await assert.rejects(focusHost(host, deps), (e) => !(e instanceof TerminalFocusError));
});

test('Client and bundle parsing', () => {
  assert.deepEqual(parseTmuxClients('/dev/ttys1\t5\t10\njunk\n/dev/ttys2\t6\t20\n'), [
    { tty: '/dev/ttys2', pid: 6, activity: 20 },
    { tty: '/dev/ttys1', pid: 5, activity: 10 },
  ]);
  assert.equal(
    appBundleOf(table('/Applications/WezTerm.app/Contents/MacOS/wezterm-gui'), 900),
    '/Applications/WezTerm.app',
  );
  assert.equal(appBundleOf(table('/Applications/iTerm.app/Contents/MacOS/iTerm2'), 404), null);
});
