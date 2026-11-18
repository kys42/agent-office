// Dev-only check of the terminal host daemon with real PTYs (only /bin/sh and coreutils; never an
// agent), in a throwaway data dir: create, detach, reconnect, restore, measure, kill, shut down.
//
//   npm run test:term-host                          # source entry on Node (tsx)
//   TERM_HOST_ELECTRON=<electron binary> npm run test:term-host
//                                                   # dist-desktop/term-host.cjs on Electron as Node
//   TERM_HOST_ENTRY=<path to term-host.cjs>         # e.g. one inside an app.asar
//   TERM_HOST_SESSIONS=20 TERM_HOST_COLS=200        # memory: N sessions with full scrollback
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import headless from '@xterm/headless';
import { connectTermHost, type ConnectOptions } from '../desktop/term-host/client';
import { termHostPaths } from '../desktop/term-host/endpoint';
import { restoreSequence } from '../desktop/term-host/protocol';

const sessions = Number(process.env.TERM_HOST_SESSIONS ?? 20);
const cols = Number(process.env.TERM_HOST_COLS ?? 200);
const scrollback = Number(process.env.TERM_HOST_SCROLLBACK ?? 200);
const electron = process.env.TERM_HOST_ELECTRON;
const entry = process.env.TERM_HOST_ENTRY ?? path.resolve('dist-desktop/term-host.cjs');
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'term-host-smoke-'));
const options: ConnectOptions = {
  dataDir,
  daemon: electron
    ? { execPath: electron, args: ['--max-semi-space-size=4', '--expose-gc', entry] }
    : {
        execPath: process.execPath,
        args: [
          '--max-semi-space-size=4',
          '--expose-gc',
          '--import',
          import.meta.resolve('tsx'),
          path.resolve('desktop/term-host/daemon.ts'),
        ],
      },
  daemonOptions: { idleMs: 5_000, scrollback },
  timeoutMs: 20_000,
};
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C' };
let daemonPid = 0;
try {
  const client = await connectTermHost(options);
  const idle = await client.list();
  daemonPid = idle.daemon.pid;
  console.log(
    `daemon ${daemonPid} (${electron ? 'Electron as Node' : 'Node'}): idle rss ${mb(idle.total.rss)}`,
  );

  // Throughput: 30 MB through one PTY, detached and then attached, until the screen has it all.
  const flood = `yes "$(printf '%099d' 0)" | head -n 300000`;
  for (const attach of [false, true]) {
    const id = `flood-${attach ? 'attached' : 'detached'}`;
    const exited = new Promise<void>((resolve) => client.onExit((sid) => sid === id && resolve()));
    let received = 0;
    client.onOutput((sid, data) => void (sid === id && (received += data.length)));
    const started = performance.now();
    await client.create({ id, argv: ['/bin/sh', '-c', flood], cwd: dataDir, env, cols, rows: 50 });
    if (attach) await client.attach(id);
    await exited;
    const seconds = (performance.now() - started) / 1000;
    const stats = (await client.list()).sessions.find((s) => s.id === id)!;
    console.log(
      `${id}: ${mb(stats.bytesIn)} in ${seconds.toFixed(2)} s = ${mb(stats.bytesIn / seconds)}/s` +
        (attach ? `, forwarded ${mb(received)}` : '') +
        `, dropped ${stats.droppedBytes}`,
    );
  }

  // Memory: N sessions, each with its scrollback full, nobody attached.
  const fill = `i=0; while [ $i -lt ${scrollback + 200} ]; do printf '%s %0${cols - 10}d\\n' $i $i; i=$((i+1)); done; exec cat`;
  for (let i = 0; i < sessions; i++) {
    await client.create({
      id: `s${i}`,
      argv: ['/bin/sh', '-c', fill],
      cwd: dataDir,
      env,
      cols,
      rows: 50,
    });
  }
  const full = async () =>
    (await client.list()).sessions
      .filter((s) => s.id.startsWith('s'))
      .every((s) => s.scrollbackLines >= scrollback);
  for (let i = 0; i < 300 && !(await full()); i++) await sleep(100);
  const loaded = await client.list();
  const one = loaded.sessions.find((s) => s.id === 's0')!;
  console.log(
    `${sessions} sessions × ${cols} cols × ${one.scrollbackLines} lines: rss ${mb(loaded.total.rss)}, ` +
      `heap ${mb(loaded.total.heapUsed)}, array buffers ${mb(loaded.total.arrayBuffers)}, ` +
      `estimate ${mb(loaded.total.approxBytes)} (${mb(one.approxBytes)} each)`,
  );
  const started = performance.now();
  const restore = await client.attach('s0', { scrollback: 0 });
  const screenMs = performance.now() - started;
  const full0 = await client.attach('s0');
  console.log(
    `attach: screen only ${(restore.snapshot.length / 1024).toFixed(1)} KB in ${screenMs.toFixed(1)} ms; ` +
      `with history ${(full0.snapshot.length / 1024).toFixed(1)} KB`,
  );

  // Disconnect entirely, reconnect, and find the screen.
  client.write('s0', 'typed while attached\r');
  await sleep(200);
  client.close();
  const again = await connectTermHost(options);
  assert.equal((await again.list()).daemon.pid, daemonPid);
  const term = new headless.Terminal({ cols, rows: 50, allowProposedApi: true });
  const reattached = await again.attach('s0', { scrollback: 0 });
  await new Promise<void>((r) => term.write(restoreSequence(reattached), r));
  const text = Array.from({ length: 50 }, (_, i) =>
    term.buffer.active.getLine(i)!.translateToString(true),
  ).join('\n');
  assert.match(text, /typed while attached/);
  console.log('restore after reconnect: ok');

  // Ending sessions frees their screens.
  for (let i = 0; i < sessions; i++) await again.kill(`s${i}`);
  for (let i = 0; i < 100; i++) {
    if ((await again.list()).total.live === 0) break;
    await sleep(50);
  }
  await sleep(Number(process.env.TERM_HOST_SETTLE_MS ?? 300));
  const ended = await again.list();
  console.log(
    `after kill: live ${ended.total.live}, estimate ${mb(ended.total.approxBytes)}, rss ${mb(ended.total.rss)}, heap ${mb(ended.total.heapUsed)}, array buffers ${mb(ended.total.arrayBuffers)}`,
  );
  await again.shutdown();
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(daemonPid, 0);
      await sleep(50);
    } catch {
      daemonPid = 0;
      break;
    }
  }
  assert.equal(daemonPid, 0, 'daemon exited');
  console.log('term-host smoke: ok');
} finally {
  if (daemonPid) process.kill(daemonPid, 'SIGKILL');
  const paths = termHostPaths(dataDir);
  await rm(dataDir, { recursive: true, force: true });
  if (path.dirname(paths.socket) !== paths.dir) {
    await rm(path.dirname(paths.socket), { recursive: true, force: true });
  }
}
