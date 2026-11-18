// The real daemon, end to end: started by the client, a /bin/sh session that outlives the client,
// a fresh client that finds it and restores its screen. Never runs an agent, never touches the
// app's data dir. Skipped where node-pty cannot load (it is an optional native dependency).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import headless from '@xterm/headless';
import { connectTermHost, type ConnectOptions } from '../desktop/term-host/client';
import { termHostPaths } from '../desktop/term-host/endpoint';
import { restoreSequence, type ExitInfo } from '../desktop/term-host/protocol';
import { TermBuiltin } from '../desktop/term-builtin';
import { TermViews } from '../desktop/term-views';
import { findHost } from '../desktop/terminal-host';
import { runCommand } from '../server/adapters/claude-live';

function nodePtyMissing() {
  if (process.platform === 'win32') return 'needs /bin/sh';
  try {
    createRequire(import.meta.url)(['node', 'pty'].join('-'));
    return false;
  } catch (error) {
    return `node-pty unavailable: ${(error as Error).message.split('\n')[0]}`;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(20);
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function render(data: string) {
  const term = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  await new Promise<void>((r) => term.write(data, r));
  const lines: string[] = [];
  for (let i = 0; i < term.buffer.active.length; i++) {
    lines.push(term.buffer.active.getLine(i)!.translateToString(true));
  }
  term.dispose();
  return lines.join('\n');
}

test(
  'daemon keeps a shell across a full client disconnect and restores its screen',
  { skip: nodePtyMissing(), timeout: 60_000 },
  async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'th-daemon-'));
    const paths = termHostPaths(dataDir);
    const options: ConnectOptions = {
      dataDir,
      // Plain Node running the TypeScript entry; the app runs the bundle through Electron.
      daemon: {
        execPath: process.execPath,
        args: ['--import', import.meta.resolve('tsx'), path.resolve('desktop/term-host/daemon.ts')],
      },
      daemonOptions: { idleMs: 3_000 },
      timeoutMs: 20_000,
      clientName: 'integration-test',
    };
    let daemonPid = 0;
    let childPid = 0;
    let strayPid = 0;
    try {
      // Two app instances starting at once: both may start a daemon, one serves both.
      const [first, racer] = await Promise.all([
        connectTermHost(options),
        connectTermHost(options),
      ]);
      const before = await first.list();
      daemonPid = before.daemon.pid;
      assert.equal((await racer.list()).daemon.pid, daemonPid);
      racer.close();
      assert.equal(before.sessions.length, 0);
      const created = await first.create({
        id: 'shell',
        argv: [
          '/bin/sh',
          '-c',
          // Prints, then keeps printing after the client is gone, then echoes input.
          "printf 'ready-%s\\n' 42; (sleep 1; printf 'while-away\\n') & exec cat",
        ],
        cwd: dataDir,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C' },
        cols: 80,
        rows: 24,
      });
      childPid = created.pid;
      let live = '';
      first.onOutput((id, data) => {
        if (id === 'shell') live += data.toString('utf8');
      });
      const attached = await first.attach('shell');
      const seen = () => attached.snapshot + live;
      await waitFor(() => seen().includes('ready-42'), 'first output');
      first.write('shell', 'typed-before-detach\r');
      await waitFor(() => live.split('typed-before-detach').length >= 3, 'echo and cat output');
      await first.detach('shell');
      first.close();

      // Nobody connected: the session keeps running and its output keeps reaching the screen.
      await sleep(1_500);
      assert.ok(alive(childPid), 'the shell outlives the client');

      const second = await connectTermHost(options);
      const listed = await second.list();
      assert.equal(listed.daemon.pid, daemonPid, 'reconnected to the same daemon');
      const stats = listed.sessions.find((s) => s.id === 'shell')!;
      assert.equal(stats.attached, 0);
      assert.ok(stats.bytesIn > 0 && stats.approxBytes > 0);
      const restored = await render(restoreSequence(await second.attach('shell')));
      assert.match(restored, /ready-42/);
      assert.match(restored, /typed-before-detach/);
      assert.match(restored, /while-away/);

      // A helper that ignores the hangup must not outlive a killed session.
      await second.create({
        id: 'stray',
        argv: ['/bin/sh', '-c', "(trap '' HUP; exec sleep 300) & echo $! > stray.pid; exec cat"],
        cwd: dataDir,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        cols: 80,
        rows: 24,
      });
      const pidFile = path.join(dataDir, 'stray.pid');
      for (let i = 0; i < 200 && !strayPid; i++) {
        strayPid = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim()) || 0;
        if (!strayPid) await sleep(20);
      }
      assert.ok(strayPid && alive(strayPid), 'the helper is running');

      const exits: ExitInfo[] = [];
      second.onExit((_, exit) => exits.push(exit));
      assert.deepEqual(await second.kill('shell'), { killed: true });
      assert.deepEqual(await second.kill('stray'), { killed: true });
      await waitFor(() => exits.length === 2, 'exit events');
      await waitFor(() => !alive(childPid), 'the shell is gone');
      await waitFor(() => !alive(strayPid), 'the helper is gone');
      const after = (await second.list()).sessions.find((s) => s.id === 'shell')!;
      assert.ok(after.exit);
      assert.equal(after.approxBytes, 0);

      await second.shutdown();
      await waitFor(() => !alive(daemonPid), 'the daemon exits');
      const log = await readFile(paths.log, 'utf8');
      assert.equal(log.split('serving ').length - 1, 1, 'one daemon ever served');
    } catch (error) {
      const log = await readFile(paths.log, 'utf8').catch(() => '(no log)');
      throw new Error(`${(error as Error).message}\n--- daemon log ---\n${log}`, { cause: error });
    } finally {
      for (const pid of [childPid, strayPid, daemonPid]) {
        if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
      }
      await rm(dataDir, { recursive: true, force: true });
      if (path.dirname(paths.socket) !== paths.dir) {
        await rm(path.dirname(paths.socket), { recursive: true, force: true });
      }
    }
  },
);

test(
  'the app recognises a real built-in session from its process, reads its screen and types into it',
  {
    // The process lookup reads macOS terminals (`ttys…`, `ps -E`): Linux `pts/N` is not read yet.
    skip:
      nodePtyMissing() || (process.platform !== 'darwin' && 'process lookup reads macOS ttys only'),
    timeout: 60_000,
  },
  async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'th-builtin-'));
    const paths = termHostPaths(dataDir);
    const daemon = {
      execPath: process.execPath,
      args: ['--import', import.meta.resolve('tsx'), path.resolve('desktop/term-host/daemon.ts')],
    };
    const builtin = new TermBuiltin({ dataDir, daemon, requestMs: 5_000 });
    let childPid = 0;
    let daemonPid = 0;
    try {
      // Nothing runs yet: a lookup says so without starting anything.
      assert.equal(await builtin.sessions(true), null);
      const created = await builtin.create({
        id: 'ao-real',
        // Node, not `cat`: macOS hides the environment of its own platform binaries from `ps -E`,
        // and the lookup reads the session's variable there (an agent CLI is never one of them).
        argv: [
          process.execPath,
          '-e',
          "process.stdout.write('\\x1b]0;real-title\\x07\\x1b[2mfaint\\x1b[0m plain\\n'); process.stdin.pipe(process.stdout)",
        ],
        cwd: dataDir,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          TERM: 'xterm-256color',
          LANG: 'C',
          AGENT_OFFICE_TERM_SESSION: 'ao-real',
        },
        cols: 80,
        rows: 10,
      });
      childPid = created.pid;
      const inventory = await builtin.sessions(true);
      daemonPid = inventory!.daemonPid;
      let screen = await builtin.screen('ao-real');
      for (let i = 0; i < 100 && !screen.lines[0].includes('plain'); i++) {
        await sleep(20);
        screen = await builtin.screen('ao-real');
      }
      assert.equal(screen.lines[0], 'faint plain');
      assert.deepEqual(screen.faint[0], [[0, 5]]);
      assert.equal(screen.title, 'real-title');
      // The session's own process leads its pty, the daemon holds it.
      const deps = { run: runCommand, bin: (name: string) => name, builtin };
      assert.deepEqual(await findHost(childPid, deps, undefined, true), {
        kind: 'builtin',
        session: 'ao-real',
        label: path.basename(dataDir),
      });
      // A window's view: the screen as it is, then what is typed shows up live.
      const views = new TermViews({ connect: () => builtin.connectView() });
      let live = '';
      const view = await views.attach(
        1,
        'ao-real',
        { cols: 80, rows: 10 },
        {
          data: (_id, data) => void (live += Buffer.from(data).toString('utf8')),
          resync() {},
          exit() {},
        },
      );
      assert.match(await render(view.restore), /faint plain/);
      views.write(1, view.viewId, 'via-view\r');
      await waitFor(() => live.includes('via-view'), 'typed through the view');
      views.detachOwner(1);
      await builtin.write('ao-real', 'typed-in\r');
      for (let i = 0; i < 100 && !screen.lines.some((l) => l === 'typed-in'); i++) {
        await sleep(20);
        screen = await builtin.screen('ao-real');
      }
      assert.ok(screen.lines.filter((l) => l === 'typed-in').length >= 1);
      builtin.close();
      const control = await connectTermHost({ dataDir });
      await control.shutdown();
      await waitFor(() => !alive(daemonPid), 'the daemon exits');
    } catch (error) {
      const log = await readFile(paths.log, 'utf8').catch(() => '(no log)');
      throw new Error(`${(error as Error).message}\n--- daemon log ---\n${log}`, { cause: error });
    } finally {
      builtin.close();
      for (const pid of [childPid, daemonPid]) if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
      await rm(dataDir, { recursive: true, force: true });
      if (path.dirname(paths.socket) !== paths.dir) {
        await rm(path.dirname(paths.socket), { recursive: true, force: true });
      }
    }
  },
);
