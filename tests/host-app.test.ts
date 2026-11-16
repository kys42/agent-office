import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appOfBundle,
  hostOf,
  NOWHERE,
  placeOfProcess,
  reachHost,
  type HostPlace,
} from '../desktop/host-app.js';
import { parseProcessEnv, TerminalFocusError, type ProcessEnv } from '../desktop/terminal-host.js';
import type { RunOptions } from '../server/adapters/claude-live.js';
import { m, setLocale } from '../src/shared/i18n/index.js';

setLocale('en');

const HANDLE = 'term_205af179-74b5-4973-9cd8-0fb07bf63fa9';
const ORCA_HELPER =
  '/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper';
const NO_ENV: ProcessEnv = { inTmux: false };
const env = (text: string) => parseProcessEnv(`claude ${text}`, 'claude');

/**
 * A fake `ps -axo pid=,ppid=,tty=,comm=`: claude(4242) ← zsh(4000) ← login(3900) on one tty,
 * under the program holding the pty (`owner`, 3146), itself under `above` when given.
 */
const table = (owner: string, above?: string, tty = 'ttys012') =>
  [
    `  4242  4000 ${tty}    /Users/me/.local/bin/claude`,
    `  4000  3900 ${tty}    -/bin/zsh`,
    `  3900  3146 ${tty}    /usr/bin/login`,
    `  3146  ${above ? 3000 : 1} ??       ${owner}`,
    ...(above ? [`  3000     1 ??       ${above}`] : []),
  ].join('\n');

test('The app hosting a process is read from its parents: the pty owner first', () => {
  const at = (owner: string, over: Partial<ProcessEnv> = {}, above?: string) =>
    placeOfProcess(table(owner, above), 4242, { ...NO_ENV, ...over }, 'darwin');
  // Orca: a way there even when its env names no terminal (Orca itself is brought forward).
  assert.deepEqual(at(ORCA_HELPER, { orcaHandle: HANDLE }), {
    where: 'orca',
    host: { app: 'orca', canGo: true },
    way: { kind: 'orca', handle: HANDLE },
  });
  assert.deepEqual(at(ORCA_HELPER).way, { kind: 'orca' });
  for (const [owner, app] of [
    ['/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal', 'terminal'],
    ['/Applications/iTerm.app/Contents/MacOS/iTerm2', 'iterm'],
    ['/Applications/Ghostty.app/Contents/MacOS/ghostty', 'ghostty'],
    ['/Applications/cmux.app/Contents/MacOS/cmux', 'cmux'],
    ['/Applications/Warp.app/Contents/MacOS/stable', 'warp'],
    // A helper nested in the app belongs to the outer app.
    [
      '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
      'vscode',
    ],
  ] as const) {
    const place = at(owner);
    assert.equal(place.where, 'other', owner);
    assert.deepEqual(place.host, { app, canGo: true }, owner);
    assert.equal(place.way.kind, 'app', owner);
    assert.equal(place.way.kind === 'app' && place.way.tty, '/dev/ttys012', owner);
  }
  // Any other app is named as it is.
  assert.deepEqual(at('/Applications/WezTerm.app/Contents/MacOS/wezterm-gui').host, {
    app: 'app',
    name: 'WezTerm',
    canGo: true,
  });
  // No app among its parents (ssh, a daemonized server): nowhere.
  assert.deepEqual(at('/usr/sbin/sshd'), NOWHERE);
  // A program between the pty and the app (a terminal multiplexer other than tmux, `script`):
  // the first app above it still hosts it; inside Orca, the Orca terminal it was started in.
  assert.equal(
    at('/usr/bin/script', {}, '/Applications/Ghostty.app/Contents/MacOS/ghostty').host.app,
    'ghostty',
  );
  assert.deepEqual(at('/usr/bin/script', { orcaHandle: HANDLE }, ORCA_HELPER).way, {
    kind: 'orca',
    handle: HANDLE,
  });
});

test('tmux hosts it whenever a tmux marker says so; Claude teammates have their own server', () => {
  const tmux = env('TMUX=/private/tmp/tmux-501/default,812,0 TMUX_PANE=%3');
  assert.deepEqual(placeOfProcess(table('tmux'), 4242, tmux, 'darwin'), {
    where: 'tmux',
    host: { app: 'tmux', canGo: true },
    way: { kind: 'tmux', socket: '/private/tmp/tmux-501/default', pane: '%3' },
  });
  // A teammate inherits the lead's Orca terminal in its env, but runs in Claude's own tmux.
  const swarm = env(
    `TMUX=/private/tmp/tmux-501/claude-swarm-17949,35594,0 TMUX_PANE=%0 ORCA_TERMINAL_HANDLE=${HANDLE}`,
  );
  assert.deepEqual(placeOfProcess(table('tmux'), 4242, swarm, 'darwin'), {
    where: 'tmux',
    host: { app: 'swarm', canGo: true },
    way: { kind: 'tmux', socket: '/private/tmp/tmux-501/claude-swarm-17949', pane: '%0' },
  });
  // Under a tmux server without its pane in the env: tmux, but no pane to go to.
  assert.deepEqual(placeOfProcess(table('tmux'), 4242, NO_ENV, 'darwin'), {
    where: 'tmux',
    host: { app: 'tmux' },
    way: { kind: 'none' },
  });
  // tmux works the same on Linux; apps are macOS bundles only.
  assert.equal(placeOfProcess(table('tmux'), 4242, tmux, 'linux').way.kind, 'tmux');
  assert.deepEqual(placeOfProcess(table(ORCA_HELPER), 4242, NO_ENV, 'linux'), NOWHERE);
  // A process missing from the table: nowhere.
  assert.deepEqual(placeOfProcess(table(ORCA_HELPER), 9999, NO_ENV, 'darwin'), NOWHERE);
});

test('Bundles are named by their own file name, kept short and printable', () => {
  assert.deepEqual(appOfBundle('/Applications/Visual Studio Code - Insiders.app'), {
    app: 'vscode',
    name: 'Visual Studio Code - Insiders',
  });
  assert.deepEqual(appOfBundle('/Applications/iTerm.app'), { app: 'iterm', name: 'iTerm' });
  assert.equal(appOfBundle('/Applications/Bad\x1bName.app').name, 'Bad Name');
  assert.equal(appOfBundle(`/Applications/${'x'.repeat(200)}.app`).name.length, 60);
});

/** Fake CLIs: every call recorded. `orca terminal list` lists `listed`. */
function fakeDeps(
  options: {
    table?: string;
    env?: string;
    listed?: Record<string, unknown>[];
    switchNavigated?: boolean;
    tmuxLabel?: string;
    tmuxClients?: string;
    osascript?: string;
    fail?: (file: string, args: string[]) => boolean;
  } = {},
) {
  const calls: { file: string; args: string[] }[] = [];
  const deps = {
    platform: 'darwin',
    bin: (name: string) => `/bin/${name}`,
    run: async (file: string, args: string[], _options?: RunOptions) => {
      calls.push({ file, args });
      if (options.fail?.(file, args)) throw new Error('failed');
      if (file === '/bin/ps') {
        if (args.includes('-axo')) return options.table ?? table(ORCA_HELPER);
        if (args.includes('-wwE')) return `claude ${options.env ?? ''}\n`;
        if (args.includes('-ww')) return 'claude\n';
      }
      if (file === '/bin/orca' && args[1] === 'list')
        return JSON.stringify({ ok: true, result: { terminals: options.listed ?? [] } });
      if (file === '/bin/orca' && args[1] === 'switch')
        return JSON.stringify({
          ok: true,
          result: { focus: { navigated: options.switchNavigated ?? true } },
        });
      if (file === '/bin/tmux' && args.includes('display-message'))
        return args.at(-1) === '#{session_id}' ? '$1\n' : (options.tmuxLabel ?? '');
      if (file === '/bin/tmux' && args.includes('list-clients')) return options.tmuxClients ?? '';
      if (file === '/usr/bin/osascript') return options.osascript ?? 'none';
      return '';
    },
  };
  return { deps, calls };
}

/** Never a send, a new tab or a closed one: navigation only. */
const onlyNavigates = (calls: { file: string; args: string[] }[]) =>
  assert.ok(
    calls.every(
      (c) =>
        !(c.file === '/bin/orca' && ['send', 'create', 'close'].includes(c.args[1])) &&
        !(c.file === '/bin/tmux' && ['send-keys', 'paste-buffer'].some((a) => c.args.includes(a))),
    ),
  );

test('hostOf reads the environment and the shared process table, and keeps nothing failed', async () => {
  const { deps, calls } = fakeDeps({ env: `ORCA_TERMINAL_HANDLE=${HANDLE}` });
  const proc = { pid: 4242, procStart: 'Tue Oct  6 13:05:12 2026' };
  assert.deepEqual((await hostOf(proc, deps)).way, { kind: 'orca', handle: HANDLE });
  const reads = calls.length;
  // Its environment is fixed for its life, and the table is shared for a second.
  await hostOf(proc, deps);
  assert.equal(calls.length, reads);
  // A failed table read is not kept: the next lookup reads it again.
  const failing = fakeDeps({ fail: (file, args) => file === '/bin/ps' && args.includes('-axo') });
  assert.deepEqual(await hostOf(proc, failing.deps), NOWHERE);
  const before = failing.calls.filter((c) => c.args.includes('-axo')).length;
  await hostOf(proc, failing.deps);
  assert.equal(failing.calls.filter((c) => c.args.includes('-axo')).length, before + 1);
});

const place = (way: HostPlace['way'], host: HostPlace['host'] = { app: 'orca', canGo: true }) =>
  ({ where: 'orca', host, way }) as HostPlace;

test('Orca: the terminal its process was started in, else its tab by title, else Orca', async () => {
  const listed = [{ handle: HANDLE, tabId: 'tab', connected: false, executionHostId: 'local' }];
  // Listed (even not connected or in another tab now): Orca switches to it.
  const direct = fakeDeps({ listed });
  assert.deepEqual(await reachHost(place({ kind: 'orca', handle: HANDLE }), direct.deps), {
    action: 'focused',
    text: m().desktop.terminal.orcaFocused,
  });
  assert.ok(direct.calls.some((c) => c.args.includes(`--terminal=${HANDLE}`)));
  onlyNavigates(direct.calls);
  // Not listed any more, or on another machine: the conversation's tab by its title.
  const tab = { kind: 'orca', handle: 'term_tab', title: '✳ Fix it' } as const;
  for (const others of [[], [{ ...listed[0], executionHostId: 'ssh:box' }]]) {
    const byTitle = fakeDeps({ listed: others });
    const result = await reachHost(
      place({ kind: 'orca', handle: HANDLE }),
      byTitle.deps,
      async () => tab,
    );
    assert.equal(result.text, m().desktop.terminal.orcaFocused);
    assert.ok(byTitle.calls.some((c) => c.args.includes('--terminal=term_tab')));
    assert.ok(!byTitle.calls.some((c) => c.args.includes(`--terminal=${HANDLE}`)));
  }
  // Orca refuses the switch, and no tab matches: Orca itself comes forward.
  const refused = fakeDeps({ listed, switchNavigated: false });
  assert.deepEqual(
    await reachHost(place({ kind: 'orca', handle: HANDLE }), refused.deps, async () => null),
    { action: 'focused', text: m().desktop.terminal.appRaised('Orca') },
  );
  assert.deepEqual(refused.calls.at(-1), { file: '/usr/bin/open', args: ['-a', 'Orca'] });
  onlyNavigates(refused.calls);
});

test('tmux: the pane its environment names, while it exists', async () => {
  const way = { kind: 'tmux', socket: '/private/tmp/tmux-501/claude-swarm-1', pane: '%2' } as const;
  const swarm = { app: 'swarm', canGo: true } as const;
  // No client attached (Claude's teammate server runs detached): Terminal opens attached to it.
  const { deps, calls } = fakeDeps({ tmuxLabel: 'claude-swarm:0.2\n' });
  const result = await reachHost(place(way, swarm), deps);
  assert.equal(result.action, 'focused');
  assert.equal(result.text, m().desktop.terminal.tmuxAttached('claude-swarm:0.2'));
  assert.ok(calls.some((c) => c.args.includes('select-pane') && c.args.includes('%2')));
  onlyNavigates(calls);
  // The pane is gone: nothing to go to.
  await assert.rejects(reachHost(place(way, swarm), fakeDeps().deps), TerminalFocusError);
});

test('Terminal and iTerm2 select the tab on its tty, else the app comes forward', async () => {
  const way = {
    kind: 'app',
    bundle: '/System/Applications/Utilities/Terminal.app',
    name: 'Terminal',
    tty: '/dev/ttys012',
  } as const;
  const terminal = { app: 'terminal', canGo: true } as const;
  const tab = fakeDeps({ osascript: 'ok\n' });
  assert.deepEqual(await reachHost(place(way, terminal), tab.deps), {
    action: 'focused',
    text: m().desktop.terminal.appTabFocused('Terminal'),
  });
  assert.equal(tab.calls[0].args.at(-1), '/dev/ttys012');
  const app = fakeDeps();
  assert.deepEqual(await reachHost(place(way, terminal), app.deps), {
    action: 'focused',
    text: m().desktop.terminal.appRaised('Terminal'),
  });
  assert.deepEqual(app.calls.at(-1), { file: '/usr/bin/open', args: ['-a', way.bundle] });
  // Another app has no tabs to ask for: only the app, by its own name.
  const ghostty = fakeDeps();
  const raised = await reachHost(
    place(
      { kind: 'app', bundle: '/Applications/WezTerm.app', name: 'WezTerm', tty: '/dev/ttys1' },
      {
        app: 'app',
        name: 'WezTerm',
        canGo: true,
      },
    ),
    ghostty.deps,
  );
  assert.equal(raised.text, m().desktop.terminal.appRaised('WezTerm'));
  assert.ok(!ghostty.calls.some((c) => c.file === '/usr/bin/osascript'));
  // The app cannot be opened: a reason to show.
  await assert.rejects(
    reachHost(place(way, terminal), fakeDeps({ fail: (file) => file === '/usr/bin/open' }).deps),
    TerminalFocusError,
  );
});

test('A parked window says how to open it there; a background session is attached; else no way', async () => {
  const parked = await reachHost(
    place(
      { kind: 'terminal', host: { kind: 'orca', handle: HANDLE, title: 'agents' } },
      {
        app: 'orca',
        parked: true,
        canGo: true,
      },
    ),
    fakeDeps().deps,
  );
  assert.equal(
    parked.text,
    `${m().desktop.terminal.orcaFocused} ${m().desktop.terminal.parkedHint}`,
  );
  assert.deepEqual(
    await reachHost(
      place({ kind: 'attach', command: 'claude attach 89fe72dc' }, { app: 'background' }),
      fakeDeps().deps,
    ),
    { action: 'copy', text: 'claude attach 89fe72dc' },
  );
  await assert.rejects(reachHost(NOWHERE, fakeDeps().deps), (error: Error) => {
    assert.ok(error instanceof TerminalFocusError);
    assert.equal(error.message, m().desktop.terminal.noWay);
    return true;
  });
});
