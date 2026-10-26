import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MiniShells,
  describeShell,
  loginShell,
  shellEnv,
  shellServer,
  type PtyLike,
  type ShellDeps,
} from '../desktop/mini-shell';
import {
  SHELL_LIMITS,
  canOpenShell,
  parseShellCommand,
  shellFolders,
  shellLabel,
  validShellInput,
} from '../src/shared/mini-shell';
import type { Session } from '../src/shared/types';

const b64 = (s: string) => Buffer.from(s).toString('base64');
class FakePty implements PtyLike {
  written: string[] = [];
  sizes: [number, number][] = [];
  killed = false;
  private data?: (d: string) => void;
  private exit?: (e: { exitCode: number }) => void;
  onData(cb: (d: string) => void) {
    this.data = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exit = cb;
  }
  write(d: string) {
    this.written.push(d);
  }
  resize(c: number, r: number) {
    this.sizes.push([c, r]);
  }
  kill() {
    this.killed = true;
    this.exit?.({ exitCode: 0 });
  }
  emit(d: string) {
    this.data?.(d);
  }
}
/** A fake tmux server: `rows` are its sessions; every call is recorded. */
function fixture(options: { rows?: string[]; noServer?: boolean; platform?: string } = {}) {
  const calls: string[][] = [];
  const spawned: { file: string; args: string[]; pty: FakePty }[] = [];
  let rows = options.rows ?? [];
  let noServer = options.noServer ?? true;
  const deps: ShellDeps = {
    async run(file, args) {
      calls.push([file, ...args]);
      const cmd = args[2] === '-f' ? args[4] : args[2];
      if (cmd === 'list-sessions') {
        if (noServer && !rows.length) throw new Error('no server running on /tmp/tmux-501/x');
        return rows.join('\n');
      }
      if (cmd === 'new-session') {
        const name = args[args.indexOf('-s') + 1];
        const cwd = args[args.indexOf('-c') + 1];
        const token = args[args.indexOf('@agent_office_shell') + 1];
        rows = [...rows, `${name}\t${token}\t${b64(cwd)}\t0`];
        noServer = false;
      }
      if (cmd === 'kill-session') {
        const name = args[args.indexOf('-t') + 1].slice(1);
        rows = rows.filter((r) => !r.startsWith(name + '\t'));
      }
      return '';
    },
    binary: async (name) => `/fake/bin/${name}`,
    directory: async (cwd) => cwd.startsWith('/work'),
    loginShell: async () => '/bin/zsh',
    async spawn(file, args) {
      const pty = new FakePty();
      spawned.push({ file, args, pty });
      return pty;
    },
    platform: options.platform ?? 'darwin',
    server: 'office-shell-test',
  };
  const sink = () => {
    const out: string[] = [];
    const exits: string[] = [];
    return {
      out,
      exits,
      data: (_: string, d: string) => out.push(d),
      exit: (id: string) => exits.push(id),
    };
  };
  return { deps, calls, spawned, sink, shells: new MiniShells(deps) };
}

test('one stable shell name per folder, never a relative or control-character path', () => {
  const a = describeShell('/work/app');
  assert.match(a.name, /^shell-[0-9a-f]{16}$/);
  assert.equal(describeShell('/work/app/').name, a.name);
  assert.equal(describeShell('/work/x/../app').name, a.name);
  assert.notEqual(describeShell('/work/other').name, a.name);
  for (const bad of ['', 'work/app', '/work/a\nb', '/work/\x07'])
    assert.throws(() => describeShell(bad));
});

test('the tmux server is dedicated: tests may rename it, never to the resume server', () => {
  assert.equal(shellServer({}), 'agent-office-shell');
  assert.equal(shellServer({ AGENT_OFFICE_SHELL_SERVER: 'office-test-1' }), 'office-test-1');
  assert.equal(shellServer({ AGENT_OFFICE_SHELL_SERVER: 'agent-office' }), 'agent-office-shell');
  assert.equal(shellServer({ AGENT_OFFICE_SHELL_SERVER: 'a b; rm' }), 'agent-office-shell');
});

test('the login shell must be listed in /etc/shells', async () => {
  const shells = async () => '# comment\n/bin/zsh\n/opt/homebrew/bin/fish\n';
  assert.equal(
    await loginShell(['/opt/homebrew/bin/fish'], shells, 'darwin'),
    '/opt/homebrew/bin/fish',
  );
  assert.equal(await loginShell(['/tmp/evil', undefined], shells, 'darwin'), '/bin/zsh');
  assert.equal(await loginShell(['bash'], shells, 'linux'), '/bin/sh');
  const missing = async () => {
    throw new Error('ENOENT');
  };
  assert.equal(await loginShell(['/bin/zsh'], missing, 'linux'), '/bin/sh');
});

test('child environment drops the outer tmux and sets a UTF-8 terminal', () => {
  const env = shellEnv({ TMUX: '/tmp/x', TMUX_PANE: '%1', PATH: '/bin', CLAUDECODE: '1' });
  assert.equal(env.TMUX, undefined);
  assert.equal(env.TMUX_PANE, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(shellEnv({ LC_ALL: 'ko_KR.UTF-8' }).LANG, undefined);
});

test('open starts a marked login shell once, then reattaches to the same one', async () => {
  const f = fixture();
  const sink = f.sink();
  const first = await f.shells.open(7, '/work/app', 100, 12, sink);
  assert.equal(first.created, true);
  assert.equal(first.name, describeShell('/work/app').name);
  const create = f.calls.find((c) => c.includes('new-session'))!;
  assert.deepEqual(create.slice(0, 5), [
    '/fake/bin/tmux',
    '-L',
    'office-shell-test',
    '-f',
    '/dev/null',
  ]);
  // The shell is exec'd directly (no shell-command string), with the marks in the same queue.
  const at = create.indexOf('-c');
  assert.deepEqual(create.slice(at, at + 5), ['-c', '/work/app', '/bin/zsh', '-l', ';']);
  assert.ok(create.includes(describeShell('/work/app').token));
  assert.deepEqual(f.spawned[0].args, [
    '-u',
    '-L',
    'office-shell-test',
    'attach-session',
    '-t',
    '=' + first.name,
  ]);
  const second = await f.shells.open(7, '/work/app', 100, 12, sink);
  assert.equal(second.created, false);
  assert.equal(f.calls.filter((c) => c.includes('new-session')).length, 1);
  assert.notEqual(second.ptyId, first.ptyId);
});

test('a missing folder or an unsupported platform starts nothing', async () => {
  const f = fixture();
  await assert.rejects(f.shells.open(1, '/gone/app', 80, 12, f.sink()));
  await assert.rejects(f.shells.open(1, 'relative', 80, 12, f.sink()));
  const w = fixture({ platform: 'win32' });
  await assert.rejects(w.shells.open(1, '/work/app', 80, 12, w.sink()));
  assert.deepEqual(await w.shells.list(), []);
  assert.equal(f.calls.filter((c) => c.includes('new-session')).length, 0);
  assert.equal(f.spawned.length, 0);
});

test('list keeps only shells whose mark matches their folder', async () => {
  const good = describeShell('/work/app');
  const f = fixture({
    rows: [
      `${good.name}\t${good.token}\t${b64('/work/app')}\t2`,
      // Someone else's session, or a forged mark: never listed, never attachable.
      `${good.name.replace(/.$/, '0')}\t${good.token}\t${b64('/work/app')}\t0`,
      `${describeShell('/work/b').name}\tforged\t${b64('/work/b')}\t0`,
      'main\t\t\t1',
    ],
    noServer: false,
  });
  assert.deepEqual(await f.shells.list(), [{ name: good.name, cwd: '/work/app', attached: 2 }]);
  await assert.rejects(
    f.shells.attach(1, describeShell('/work/b').name, 80, 12, f.sink()),
    /no longer running/,
  );
  assert.equal(f.spawned.length, 0);
});

test('keys reach only the window that attached; closing detaches without ending the shell', async () => {
  const f = fixture();
  const sink = f.sink();
  const a = await f.shells.open(1, '/work/app', 80, 12, sink);
  const pty = f.spawned[0].pty;
  f.shells.write(2, a.ptyId, 'rm -rf ~\r');
  f.shells.resize(2, a.ptyId, 10, 10);
  f.shells.detach(2, a.ptyId);
  assert.deepEqual(pty.written, []);
  assert.deepEqual(pty.sizes, []);
  assert.equal(pty.killed, false);
  f.shells.write(1, a.ptyId, 'open .\r');
  f.shells.resize(1, a.ptyId, 120, 20);
  assert.deepEqual(pty.written, ['open .\r']);
  assert.deepEqual(pty.sizes, [[120, 20]]);
  pty.emit('hel');
  pty.emit('lo');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sink.out, ['hello'], 'output is coalesced');
  f.shells.detachOwner(1);
  assert.equal(pty.killed, true);
  assert.equal(f.shells.attachedCount, 0);
  assert.equal(f.calls.filter((c) => c.includes('kill-session')).length, 0);
  assert.equal((await f.shells.list()).length, 1, 'the shell keeps running in tmux');
});

test('ending a shell asks first and targets the exact session', async () => {
  const f = fixture();
  const a = await f.shells.open(1, '/work/app', 80, 12, f.sink());
  assert.equal(await f.shells.kill(a.name, async () => false), false);
  assert.equal(f.calls.filter((c) => c.includes('kill-session')).length, 0);
  let asked = '';
  assert.equal(
    await f.shells.kill(a.name, async (s) => {
      asked = s.cwd;
      return true;
    }),
    true,
  );
  assert.equal(asked, '/work/app');
  assert.deepEqual(f.calls.find((c) => c.includes('kill-session'))!.slice(-3), [
    'kill-session',
    '-t',
    '=' + a.name,
  ]);
  await assert.rejects(
    f.shells.kill(a.name, async () => true),
    /no longer running/,
  );
});

test('window commands: only exact shapes, sizes clamped, no folders or commands', () => {
  const ptyId = '0b0e2a7c-3a5e-4c58-9d38-5d4e9a1f2b3c';
  assert.deepEqual(parseShellCommand({ type: 'open', id: 's1', cols: 9999, rows: 0.4 }), {
    type: 'open',
    id: 's1',
    cols: SHELL_LIMITS.maxCols,
    rows: SHELL_LIMITS.minRows,
  });
  assert.deepEqual(parseShellCommand({ type: 'list', cwd: '/etc' }), { type: 'list' });
  assert.deepEqual(parseShellCommand({ type: 'detach', ptyId }), { type: 'detach', ptyId });
  for (const bad of [
    null,
    [],
    'list',
    { type: 'run', command: 'ls' },
    { type: 'open', id: '', cols: 80, rows: 12 },
    { type: 'open', id: 's1', cols: 'wide', rows: 12 },
    { type: 'open', id: 's1', cols: NaN, rows: 12 },
    { type: 'attach', name: 'main', cols: 80, rows: 12 },
    { type: 'attach', name: 'shell-0123', cols: 80, rows: 12 },
    { type: 'kill', name: 'shell-0123456789abcdef; rm' },
    { type: 'detach', ptyId: '../x' },
    { type: 'resize', ptyId, cols: 80 },
  ])
    assert.throws(() => parseShellCommand(bad), JSON.stringify(bad));
  assert.equal(validShellInput(ptyId, 'ls\r'), true);
  assert.equal(validShellInput(ptyId, ''), false);
  assert.equal(validShellInput(ptyId, 'x'.repeat(SHELL_LIMITS.maxInput + 1)), false);
  assert.equal(validShellInput('nope', 'ls'), false);
  assert.equal(validShellInput(ptyId, { toString: () => 'ls' }), false);
});

test('zones offer local folders only, one per folder', () => {
  const s = (id: string, cwd: string | undefined, remote = false) =>
    ({ id, cwd, ...(remote ? { remote: { officeId: 'o' } } : {}) }) as unknown as Session;
  assert.deepEqual(
    shellFolders([
      s('a', '/work/app'),
      s('b', '/work/app'),
      s('c', '/work/lib'),
      s('d', '/work/remote', true),
      s('e', undefined),
      s('f', 'relative'),
    ]),
    [
      { id: 'a', cwd: '/work/app' },
      { id: 'c', cwd: '/work/lib' },
    ],
  );
  assert.equal(canOpenShell(s('a', '/work/app')), true);
  assert.equal(canOpenShell(s('d', '/work/app', true)), false);
  assert.equal(shellLabel('/work/app/'), 'app');
  assert.equal(shellLabel('/'), '/');
});
