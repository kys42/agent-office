import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  codexLoadedThreads,
  codexTarget,
  findCodexThread,
  queueToCodex,
  readCodexOrigin,
} from '../desktop/codex-queue.js';
import { TerminalInputError, type RunOptions, type TerminalDeps } from '../desktop/terminals.js';
import { setLocale } from '../src/shared/i18n/index.js';
// These tests assert the original Korean copy: pin the language so results never depend on the
// machine (services resolve `auto` through AGENT_OFFICE_LOCALE first).
process.env.AGENT_OFFICE_LOCALE = 'ko';
setLocale('ko');

const THREAD = '01a111a3-931f-7c31-9b3c-b73c30079654';

function meta(originator: string, source: unknown = 'cli') {
  return (
    JSON.stringify({
      type: 'session_meta',
      payload: { id: THREAD, originator, source, base_instructions: 'x'.repeat(200_000) },
    }) + '\n'
  );
}

/** A temporary CODEX_HOME with a lock file and a rollout. */
async function codexHome(options: { originator?: string; source?: unknown } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'office-codex-'));
  await mkdir(path.join(home, 'thread-writer-locks'));
  // Lock files outlive their sessions; only a Codex process holding one open counts.
  await writeFile(path.join(home, 'thread-writer-locks', `${THREAD}.lock`), '');
  const rollout = path.join(home, `rollout-${THREAD}.jsonl`);
  await writeFile(rollout, meta(options.originator ?? 'codex-tui', options.source));
  return { home, rollout };
}

/** `lsof -Fcn +d <locks>` output: which processes hold which lock files open. */
const held = (home: string, threads: string[], command = 'codex') =>
  threads
    .flatMap((t, i) => [
      `p${95500 + i}`,
      `c${command}`,
      'f39',
      `n${home}/thread-writer-locks/${t}.lock`,
    ])
    .join('\n');

function fakeDeps(
  home: string,
  options: {
    queueOut?: string;
    queueError?: Error;
    open?: string[];
    command?: string;
  } = {},
) {
  const calls: { file: string; args: string[]; options?: RunOptions }[] = [];
  const deps: TerminalDeps = {
    sessionsDir: '/nonexistent',
    codexHome: home,
    alive: () => true,
    bin: (name) => `/bin/${name}`,
    wait: async () => {},
    run: async (file, args, runOptions) => {
      calls.push({ file, args, options: runOptions });
      if (file === '/usr/sbin/lsof') {
        const open = options.open ?? [THREAD];
        // lsof exits 1 when nothing in the folder is open.
        if (!open.length) throw Object.assign(new Error('exit 1'), { stdout: '' });
        return held(home, open, options.command);
      }
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

test('Only a terminal Codex thread that a live Codex process holds open is a target', async () => {
  const ok = await codexHome();
  try {
    const { deps } = fakeDeps(ok.home);
    assert.deepEqual(await findCodexThread(THREAD, ok.rollout, { deps }), { threadId: THREAD });
    assert.equal(await findCodexThread('not-a-thread', ok.rollout, { deps }), null);
    assert.equal(await findCodexThread(THREAD, undefined, { deps }), null);
    // The lock file exists but nothing holds it: the session ended, a queued message would wait.
    const stale = fakeDeps(ok.home, { open: [] });
    assert.equal(await findCodexThread(THREAD, ok.rollout, { deps: stale.deps }), null);
    // Held by something that is not Codex.
    const other = fakeDeps(ok.home, { command: 'backupd' });
    assert.equal(await findCodexThread(THREAD, ok.rollout, { deps: other.deps }), null);
  } finally {
    await rm(ok.home, { recursive: true, force: true });
  }
  for (const options of [
    { originator: 'Codex Desktop' },
    { originator: 'codex_exec', source: 'exec' },
    { originator: 'codex-tui', source: { subagent: {} } },
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

test('Served threads come from one lsof over the lock folder, daemon or embedded alike', async () => {
  const env = await codexHome();
  try {
    const other = '01a1144c-f9c2-7a32-8e9b-ffcbb8663796';
    const { deps, calls } = fakeDeps(env.home, { open: [THREAD, other] });
    assert.deepEqual([...(await codexLoadedThreads(deps))].sort(), [other, THREAD].sort());
    assert.deepEqual(calls.find((c) => c.file === '/usr/sbin/lsof')!.args, [
      '-Fcn',
      '+d',
      path.join(env.home, 'thread-writer-locks'),
    ]);
    assert.equal((await codexLoadedThreads(fakeDeps(env.home, { open: [] }).deps)).size, 0);
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
