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
  platform?: string;
  fail?: (file: string, args: string[]) => boolean;
}

function fake(options: Options = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const deps: TerminalHostDeps = {
    platform: options.platform ?? 'darwin',
    bin: (name) => `/bin/${name}`,
    async run(file, args) {
      calls.push({ file, args });
      if (options.fail?.(file, args)) throw new Error('failed');
      if (file === '/bin/tmux' && args.includes('list-clients')) return options.clients ?? '';
      if (file === '/bin/tmux' && args.includes('display-message')) return 'office-claude-abc\n';
      if (file === '/bin/ps') return options.ps ?? '';
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

for (const [name, app, bundle] of [
  [
    'Terminal',
    '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
    '/System/Applications/Utilities/Terminal.app',
  ],
  [
    'Orca',
    '/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper',
    '/Applications/Orca.app',
  ],
  ['Ghostty', '/Applications/Ghostty.app/Contents/MacOS/ghostty', '/Applications/Ghostty.app'],
]) {
  test(`A client in ${name}: switch that client to the pane and bring ${name} forward`, async () => {
    const { deps, calls } = fake({
      // The most recently active client wins.
      clients: '/dev/ttys003\t901\t100\n/dev/ttys009\t900\t200\n',
      ps: table(app),
    });
    const text = await focusHost(host, deps);
    assert.equal(text, `${name}에서 tmux office-claude-abc:0.0 패널로 이동했어요`);
    assert.deepEqual(tmuxArgs(calls).at(-1), ['switch-client', '-c', '/dev/ttys009', '-t', '%7']);
    const open = calls.filter((c) => c.file === '/usr/bin/open');
    assert.deepEqual(
      open.map((c) => c.args),
      [['-a', bundle]],
    );
    assert.ok(!calls.some((c) => c.file === '/usr/bin/osascript' || c.args.includes('send-keys')));
  });
}

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
