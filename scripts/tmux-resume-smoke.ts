import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { TmuxResume, summonSession } from '../desktop/tmux-resume';
import { runCommand } from '../server/adapters/claude-live';
const dir = await mkdtemp(path.join(os.tmpdir(), 'office-tmux-test-'));
const server = `office-test-${process.pid}`;
const binary = path.join(dir, 'fake-agent');
await writeFile(
  binary,
  '#!/bin/sh\nprintf "%s\\n" "$@" > "' + dir + '/args"\nexec /bin/sleep 60\n',
);
await chmod(binary, 0o700);
const deps = {
  run: runCommand,
  binary: async (name: string) => (name === 'tmux' ? '/opt/homebrew/bin/tmux' : binary),
  directory: async () => true,
  platform: 'darwin',
  server,
};
const manager = new TmuxResume(deps);
const s = { provider: 'codex' as const, nativeId: 'synthetic-1234', cwd: dir };
try {
  assert.equal((await manager.status(s)).running, false);
  const result = await manager.start(s, async () => true);
  assert.equal(result.running, true);
  assert.equal((await new TmuxResume(deps).status(s)).running, true);
  await new Promise((r) => setTimeout(r, 1000));

  assert.equal(await readFile(path.join(dir, 'args'), 'utf8'), 'resume\nsynthetic-1234\n');
  await manager.start(s, async () => {
    throw new Error('must reuse');
  });
  await runCommand('/opt/homebrew/bin/tmux', [
    '-L',
    server,
    'set-window-option',
    '-t',
    result.name,
    'remain-on-exit',
    'on',
  ]);
  await runCommand('/opt/homebrew/bin/tmux', ['-L', server, 'send-keys', '-t', result.name, 'C-c']);
  for (let i = 0; i < 50 && (await manager.status(s)).running; i++)
    await new Promise((r) => setTimeout(r, 50));
  assert.equal((await manager.status(s)).running, false);
  assert.equal((await manager.start(s, async () => true)).running, true);

  await runCommand('/opt/homebrew/bin/tmux', [
    '-L',
    server,
    'kill-session',
    '-t',
    '=' + result.name,
  ]);
  assert.equal((await manager.status(s)).running, false);
  const fresh = summonSession(dir, 'claude');
  assert.equal((await manager.start(fresh, async () => true)).running, true);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await readFile(path.join(dir, 'args'), 'utf8'), '\n');
  assert.equal((await new TmuxResume(deps).status(fresh)).running, true);
  console.log(
    'Actual isolated tmux: create, literal resume arguments, rediscover, reuse, dead-pane resume, termination PASS',
  );
} finally {
  await runCommand('/opt/homebrew/bin/tmux', ['-L', server, 'kill-server']).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
