import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  codexDaemonAlive,
  codexTarget,
  findCodexThread,
  queueToCodex,
  readCodexOrigin,
} from '../desktop/codex-queue.js';
import { TerminalInputError, type RunOptions, type TerminalDeps } from '../desktop/terminals.js';

const THREAD = '01a111a3-931f-7c31-9b3c-b73c30079654';
const STARTED = 'Tue Oct  6 23:14:50 2026';

function meta(originator: string, source: unknown = 'cli') {
  return (
    JSON.stringify({
      type: 'session_meta',
      payload: { id: THREAD, originator, source, base_instructions: 'x'.repeat(200_000) },
    }) + '\n'
  );
}

/** A temporary CODEX_HOME with a running daemon, a loaded thread and a rollout file. */
async function codexHome(
  options: { originator?: string; source?: unknown; loaded?: boolean; daemon?: unknown } = {},
) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'office-codex-'));
  await mkdir(path.join(home, 'thread-writer-locks'));
  await mkdir(path.join(home, 'app-server-daemon'));
  if (options.loaded !== false)
    await writeFile(path.join(home, 'thread-writer-locks', `${THREAD}.lock`), '');
  await writeFile(
    path.join(home, 'app-server-daemon', 'daemon.pid'),
    JSON.stringify(options.daemon ?? { pid: 95500, processStartTime: STARTED }),
  );
  const rollout = path.join(home, `rollout-${THREAD}.jsonl`);
  await writeFile(rollout, meta(options.originator ?? 'codex-tui', options.source));
  return { home, rollout };
}

function fakeDeps(
  home: string,
  options: { alive?: number[]; lstart?: string; queueOut?: string; queueError?: Error } = {},
) {
  const calls: { file: string; args: string[]; options?: RunOptions }[] = [];
  const deps: TerminalDeps = {
    sessionsDir: '/nonexistent',
    codexHome: home,
    alive: (pid) => (options.alive ?? [95500]).includes(pid),
    bin: (name) => `/bin/${name}`,
    wait: async () => {},
    run: async (file, args, runOptions) => {
      calls.push({ file, args, options: runOptions });
      if (file === '/bin/ps') return `${options.lstart ?? STARTED}\n`;
      if (file === '/bin/codex') {
        if (options.queueError) throw options.queueError;
        return options.queueOut ?? `Queued message 01a111aa-5761 for thread ${THREAD}.\n`;
      }
      return '';
    },
  };
  return { deps, calls };
}

test('The rollout header tells a terminal Codex session from the desktop app and helpers', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-codex-meta-'));
  try {
    const file = path.join(dir, 'a.jsonl');
    await writeFile(file, '\n' + meta('codex-tui', 'cli') + '{"type":"event_msg"}\n');
    assert.deepEqual(await readCodexOrigin(file), { originator: 'codex-tui', subagent: false });
    await writeFile(file, meta('Codex Desktop', { subagent: { parent: 'x' } }));
    assert.deepEqual(await readCodexOrigin(file), { originator: 'Codex Desktop', subagent: true });
    await writeFile(file, '{"type":"event_msg"}\n'.repeat(8));
    assert.equal(await readCodexOrigin(file), null);
    await writeFile(file, '{broken\n');
    assert.equal(await readCodexOrigin(file), null);
    assert.equal(await readCodexOrigin(path.join(dir, 'missing.jsonl')), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Only a loaded terminal Codex thread on a live daemon is a target', async () => {
  const ok = await codexHome();
  try {
    const { deps } = fakeDeps(ok.home);
    assert.deepEqual(await findCodexThread(THREAD, ok.rollout, { deps }), { threadId: THREAD });
    assert.equal(await findCodexThread('not-a-thread', ok.rollout, { deps }), null);
    assert.equal(await findCodexThread(THREAD, undefined, { deps }), null);
    // A dead daemon, or a recycled pid that started at another time.
    assert.equal(
      await findCodexThread(THREAD, ok.rollout, { deps: fakeDeps(ok.home, { alive: [] }).deps }),
      null,
    );
    assert.equal(
      await findCodexThread(THREAD, ok.rollout, {
        deps: fakeDeps(ok.home, { lstart: 'Wed Oct  7 01:00:00 2026' }).deps,
      }),
      null,
    );
  } finally {
    await rm(ok.home, { recursive: true, force: true });
  }
  for (const options of [
    { loaded: false },
    { originator: 'Codex Desktop' },
    { originator: 'codex_exec', source: 'exec' },
    { originator: 'codex-tui', source: { subagent: {} } },
    { daemon: { pid: 'x' } },
  ]) {
    const env = await codexHome(options);
    try {
      const { deps } = fakeDeps(env.home);
      assert.equal(
        await findCodexThread(THREAD, env.rollout, { deps }),
        null,
        JSON.stringify(options),
      );
    } finally {
      await rm(env.home, { recursive: true, force: true });
    }
  }
});

test('The daemon start time is compared in the local clock, as Codex writes it', async () => {
  const env = await codexHome();
  try {
    const { deps, calls } = fakeDeps(env.home);
    assert.equal(await codexDaemonAlive(deps), true);
    const ps = calls.find((c) => c.file === '/bin/ps')!;
    assert.deepEqual(ps.args, ['-o', 'lstart=', '-p', '95500']);
    assert.equal(ps.options?.env?.LC_ALL, 'C');
    assert.equal(ps.options?.env?.TZ, process.env.TZ);
  } finally {
    await rm(env.home, { recursive: true, force: true });
  }
});

test('Queueing passes text as one flag value and checks the daemon answer', async () => {
  const { deps, calls } = fakeDeps('/x');
  assert.equal(
    await queueToCodex({ threadId: THREAD }, '  --dry-run first\nthen;  ', deps),
    'Codex 세션에 전달했어요',
  );
  assert.deepEqual(calls[0].args, [
    'queue',
    `--thread=${THREAD}`,
    '--message=--dry-run first\nthen;',
  ]);
  assert.equal(calls[0].options?.timeout, 20_000);
  const odd = fakeDeps('/x', { queueOut: 'something else' });
  await assert.rejects(queueToCodex({ threadId: THREAD }, 'hi', odd.deps), TerminalInputError);
  const failed = fakeDeps('/x', { queueError: new Error('socket') });
  await assert.rejects(queueToCodex({ threadId: THREAD }, 'hi', failed.deps), (e: Error) => {
    assert.ok(!(e instanceof TerminalInputError));
    return true;
  });
  await assert.rejects(queueToCodex({ threadId: THREAD }, ' \u0007 ', deps), TerminalInputError);
});

test('A Codex target queues instead of refusing a working session, and cannot be focused', () => {
  assert.deepEqual(codexTarget(), {
    kind: 'codex',
    label: '',
    status: 'queue',
    canSend: true,
    canFocus: false,
    queues: true,
  });
});
