import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dropAppMenu } from '../desktop/window-style';
import {
  MiniShells,
  describeShell,
  loadNodePty,
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
  fitSize,
  OutputFlow,
  splitInput,
  validShellInput,
} from '../src/shared/mini-shell';
import type { Session } from '../src/shared/types';

const b64 = (s: string) => Buffer.from(s).toString('base64');
class FakePty implements PtyLike {
  written: string[] = [];
  sizes: [number, number][] = [];
  killed = false;
  paused = false;
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
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
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
  let nextId = 1;
  const server = {
    /** Ends a session and starts another under the same name (another window did both). */
    restart(name: string) {
      rows = rows.map((r) => {
        const cells = r.split('\t');
        if (cells[0] !== name) return r;
        cells[4] = `$${nextId++}`;
        cells[5] = String(1700000000 + nextId);
        return cells.join('\t');
      });
    },
  };
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
        const encoded = args[args.indexOf('@agent_office_shell_cwd') + 1];
        const token = args[args.indexOf('@agent_office_shell') + 1];
        const once = args[args.indexOf('@agent_office_shell_once') + 1];
        rows = [
          ...rows,
          `${name}\t${token}\t${encoded}\t0\t$${nextId++}\t${1700000000 + nextId}\t${once}`,
        ];
        noServer = false;
      }
      if (cmd === 'if-shell') {
        // `if-shell -t $id -F '#{==:#{@agent_office_shell_once},<uuid>}' 'kill-session -t $id'`
        const target = args[args.indexOf('-t') + 1];
        const want = /,([0-9a-f-]{36})\}$/.exec(args[args.indexOf('-F') + 1])?.[1];
        const row = rows.find((r) => r.split('\t')[4] === target);
        if (row && row.split('\t')[6] === want) rows = rows.filter((r) => r !== row);
        return '';
      }
      if (cmd === 'kill-session') {
        const target = args[args.indexOf('-t') + 1];
        rows = rows.filter((r) =>
          target.startsWith('$')
            ? r.split('\t')[4] !== target
            : !r.startsWith(target.slice(1) + '\t'),
        );
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
  const setRows = (change: (rows: string[]) => string[]) => {
    rows = change(rows);
  };
  return { deps, calls, spawned, sink, server, setRows, shells: new MiniShells(deps) };
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
  assert.equal(f.calls.filter((c) => c.includes('if-shell')).length, 0);
  assert.equal((await f.shells.list()).length, 1, 'the shell keeps running in tmux');
});

test('ending a shell asks first and targets the exact session', async () => {
  const f = fixture();
  const a = await f.shells.open(1, '/work/app', 80, 12, f.sink());
  assert.equal(await f.shells.kill(a.name, async () => false), false);
  assert.equal(f.calls.filter((c) => c.includes('if-shell')).length, 0);
  let asked = '';
  assert.equal(
    await f.shells.kill(a.name, async (s) => {
      asked = s.cwd;
      return true;
    }),
    true,
  );
  assert.equal(asked, '/work/app');
  // By tmux's own session id, the one the person was asked about.
  const kill = f.calls.find((c) => c.includes('if-shell'))!;
  assert.equal(kill[kill.indexOf('-t') + 1], '$1');
  assert.equal(kill.at(-1), 'kill-session -t $1');
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

test('a window that closes while its terminal is starting leaves no client behind', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const spawn = f.deps.spawn;
  f.deps.spawn = async (...args) => {
    await gate;
    return spawn(...args);
  };
  const opening = f.shells.open(1, '/work/app', 80, 12, f.sink());
  await new Promise((r) => setTimeout(r, 10));
  f.shells.detachOwner(1); // the window reloaded mid-open
  release();
  await assert.rejects(opening, /no longer running/);
  assert.equal(f.spawned.length, 1);
  assert.equal(f.spawned[0].pty.killed, true);
  assert.equal(f.shells.attachedCount, 0);
  // The shell itself stays, and the same window can open it again afterwards.
  assert.equal((await f.shells.list()).length, 1);
  const again = await f.shells.open(1, '/work/app', 80, 12, f.sink());
  assert.equal(again.created, false);
  assert.equal(f.shells.attachedCount, 1);
});

test('node-pty is loaded by name at run time, not resolved at build time', () => {
  const asked: string[] = [];
  const fake = { spawn: () => new FakePty() };
  assert.equal(
    loadNodePty((id) => {
      asked.push(id);
      return fake;
    }),
    fake,
  );
  assert.deepEqual(asked, ['node-pty']);
});

test('large pastes split at code-point boundaries, never inside a surrogate pair', () => {
  const emoji = '😀';
  // A cut right after the high surrogate would land at 4: it steps back to 3.
  assert.deepEqual(splitInput('abc' + emoji + 'd', 4), ['abc', emoji + 'd']);
  const text = ('가' + emoji + 'x').repeat(30000);
  const pieces = splitInput(text);
  assert.equal(pieces.join(''), text);
  for (const p of pieces) {
    assert.ok(p.length <= SHELL_LIMITS.maxInput / 2);
    assert.ok(validShellInput('0b0e2a7c-3a5e-4c58-9d38-5d4e9a1f2b3c', p));
    assert.doesNotMatch(p, /^[\udc00-\udfff]|[\ud800-\udbff]$/);
  }
  assert.deepEqual(splitInput(''), []);
});

test('the install fix runs from a path with spaces and non-ASCII letters', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office pty 한글-'));
  try {
    const helper = path.join(dir, 'scripts', 'node-pty-helper.mjs');
    await mkdir(path.dirname(helper), { recursive: true });
    await copyFile('scripts/node-pty-helper.mjs', helper);
    const file = path.join(dir, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '');
    await chmod(file, 0o644);
    execFileSync(process.execPath, [helper], { cwd: dir });
    assert.equal((await stat(file)).mode & 0o777, 0o755);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a folder ending in `;` reaches tmux escaped, not as a command separator', async () => {
  const f = fixture();
  f.deps.directory = async () => true;
  const a = await f.shells.open(1, '/work/odd;', 80, 12, f.sink());
  const create = f.calls.find((c) => c.includes('new-session'))!;
  const at = create.indexOf('-c');
  assert.deepEqual(create.slice(at, at + 4), ['-c', '/work/odd\\;', '/bin/zsh', '-l']);
  // The real separators are the bare `;` entries only, and the mark keeps the real folder.
  assert.equal(create.filter((x) => x === ';').length, 5);
  assert.equal(a.cwd, '/work/odd;');
});

test('a request from a window that reloaded before it was served opens nothing', async () => {
  const f = fixture();
  const since = f.shells.epoch(1);
  f.shells.detachOwner(1); // reload while main was still reading the session
  await assert.rejects(f.shells.open(1, '/work/app', 80, 12, f.sink(), since), /no longer running/);
  assert.equal(f.calls.filter((c) => c.includes('new-session')).length, 0);
  assert.equal(f.spawned.length, 0);
  // A fresh request from the reloaded page works.
  assert.equal((await f.shells.open(1, '/work/app', 80, 12, f.sink())).created, true);
});

test('fitted terminal sizes use the same limits the PTY is clamped to', () => {
  assert.deepEqual(fitSize({ cols: 612, rows: 9 }), { cols: SHELL_LIMITS.maxCols, rows: 9 });
  assert.deepEqual(fitSize({ cols: 4, rows: 1 }), {
    cols: SHELL_LIMITS.minCols,
    rows: SHELL_LIMITS.minRows,
  });
  assert.deepEqual(fitSize({ cols: 120, rows: 400 }), { cols: 120, rows: SHELL_LIMITS.maxRows });
  assert.equal(fitSize(undefined), null);
  assert.equal(fitSize({ cols: NaN, rows: 10 }), null);
  const { cols, rows } = fitSize({ cols: 612, rows: 9 })!;
  assert.deepEqual(parseShellCommand({ type: 'open', id: 's', cols, rows }), {
    type: 'open',
    id: 's',
    cols,
    rows,
  });
});

test('ending asks about one shell: a replacement started meanwhile is not ended', async () => {
  const f = fixture();
  const a = await f.shells.open(1, '/work/app', 80, 12, f.sink());
  await assert.rejects(
    f.shells.kill(a.name, async () => {
      // While the dialog is open another window ends this shell and opens the folder again.
      f.server.restart(a.name);
      return true;
    }),
    /no longer running/,
  );
  assert.equal(f.calls.filter((c) => c.includes('if-shell')).length, 0);
  assert.equal((await f.shells.list()).length, 1, 'the replacement keeps running');
});

test('flow control pauses and resumes only the window’s own client', async () => {
  const f = fixture();
  const a = await f.shells.open(1, '/work/app', 80, 12, f.sink());
  const pty = f.spawned[0].pty;
  f.shells.flow(2, a.ptyId, true);
  assert.equal(pty.paused, false);
  f.shells.flow(1, a.ptyId, true);
  assert.equal(pty.paused, true);
  f.shells.flow(1, a.ptyId, false);
  assert.equal(pty.paused, false);
  assert.deepEqual(parseShellCommand({ type: 'flow', ptyId: a.ptyId, paused: true }), {
    type: 'flow',
    ptyId: a.ptyId,
    paused: true,
  });
  assert.throws(() => parseShellCommand({ type: 'flow', ptyId: a.ptyId, paused: 'yes' }));
});

test('the view pauses output above the high-water mark and resumes below the low', () => {
  const signals: boolean[] = [];
  const flow = new OutputFlow((p) => signals.push(p), 100, 20);
  flow.wrote(60);
  flow.wrote(60); // 120 queued: pause once
  flow.wrote(50);
  assert.deepEqual(signals, [true]);
  flow.drew(60);
  flow.drew(60); // 50 left: still above the low mark
  assert.deepEqual(signals, [true]);
  flow.drew(40); // 10 left: resume once
  flow.drew(10);
  assert.deepEqual(signals, [true, false]);
  assert.equal(flow.pending, 0);
  assert.equal(flow.isPaused, false);
  assert.ok(SHELL_LIMITS.flowLow < SHELL_LIMITS.flowHigh);
});

test('card and main windows drop the app menu on Windows/Linux so Ctrl keys reach the terminal', () => {
  const calls: string[] = [];
  const window = {
    removeMenu: () => calls.push('remove'),
    setMenuBarVisibility: (v: boolean) => calls.push(`bar:${v}`),
  };
  assert.equal(dropAppMenu(window, 'darwin'), false);
  assert.deepEqual(calls, []);
  assert.equal(dropAppMenu(window, 'linux'), true);
  assert.equal(dropAppMenu(window, 'win32'), true);
  assert.deepEqual(calls, ['remove', 'bar:false', 'remove', 'bar:false']);
});

test('ending asks about one start of the shell: a restart in the same second with a reused id is not ended', async () => {
  const f = fixture();
  f.deps.directory = async () => true;
  await f.shells.open(1, '/work/app', 80, 12, f.sink());
  const name = describeShell('/work/app').name;
  await assert.rejects(
    f.shells.kill(name, async () => {
      // tmux restarted: same name, same `$id`, same second, a new start.
      f.setRows((rows: string[]) =>
        rows.map((r) => r.replace(/\t[0-9a-f-]{36}$/, '\t00000000-0000-4000-8000-000000000000')),
      );
      return true;
    }),
    /no longer running/,
  );
  assert.equal(f.calls.filter((c) => c.includes('if-shell')).length, 0);
});

test('a running shell reattaches even after its folder went away', async () => {
  const f = fixture();
  f.deps.directory = async () => true;
  await f.shells.open(1, '/work/app', 80, 12, f.sink());
  f.deps.directory = async () => false;
  assert.equal(await f.shells.ensure('/work/app', 80, 12), false);
});
