// Real tmux + node-pty, on a throwaway tmux server (never the app's own): open a shell, type,
// detach, reattach and find it still there, then end it. `npx tsx scripts/mini-shell-smoke.ts`
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { MiniShells, defaultShellDeps } from '../desktop/mini-shell';
import { runCommand } from '../server/adapters/claude-live';

const root = await mkdtemp(path.join(os.tmpdir(), 'office-shell-smoke-'));
// A folder name ending in `;` (tmux's command separator) must still be the shell's folder.
const dir = path.join(root, 'project;');
await mkdir(dir);
const server = `office-shell-smoke-${process.pid}`;
const deps = { ...defaultShellDeps(), server };
const shells = new MiniShells(deps);
const tmux = await deps.binary('tmux');
const wait = async (check: () => boolean | Promise<boolean>, what: string, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out: ${what}`);
};
try {
  let screen = '';
  const sink = { data: (_: string, d: string) => void (screen += d), exit: () => {} };
  const first = await shells.open(1, dir, 80, 12, sink);
  assert.equal(first.created, true);
  await wait(() => screen.length > 0, 'first output');
  shells.write(1, first.ptyId, 'echo office-$((40+2)) > marker.txt\r');
  await wait(
    async () => (await readFile(path.join(dir, 'marker.txt'), 'utf8').catch(() => '')) !== '',
    'command ran in the folder',
  );
  assert.equal((await readFile(path.join(dir, 'marker.txt'), 'utf8')).trim(), 'office-42');
  shells.detach(1, first.ptyId);
  // Panel closed (or the app quit): the shell is still on the tmux server.
  const listed = await new MiniShells(deps).list();
  assert.deepEqual(
    listed.map((s) => [s.name, s.cwd]),
    [[first.name, path.resolve(dir)]],
  );
  screen = '';
  const again = await new MiniShells(deps).open(2, dir, 80, 12, sink);
  assert.equal(again.created, false);
  assert.equal(again.name, first.name);
  await wait(() => screen.includes('office-'), 'reattached screen shows the earlier command');
  assert.equal(await shells.kill(first.name, async () => true), true);
  assert.deepEqual(await shells.list(), []);
  console.log(JSON.stringify({ ok: true, server, name: first.name }));
} finally {
  shells.dispose();
  await runCommand(tmux, ['-L', server, 'kill-server']).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
process.exit(0);
