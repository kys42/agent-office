import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { demoSnapshot } from '../src/lib/demo.js';
import { chmod } from 'node:fs/promises';
import { peerBinary, resumeOrigin } from '../server/federation/wake.js';

test('a remote wake finds Codex: installed CLI, then PATH, then the desktop app as a last resort', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'peer-binary-'));
  const exe = async (name: string) => {
    const file = path.join(dir, name);
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o755);
    return file;
  };
  try {
    const [installed, onPath, bundled] = await Promise.all([
      exe('installed'),
      exe('on-path'),
      exe('bundled'),
    ]);
    const missing = async () => {
      throw Error('missing');
    };
    const deps = (over: Partial<Parameters<typeof peerBinary>[1]>) => ({
      installed: () => installed,
      onPath: async () => onPath,
      bundled: [path.join(dir, 'absent'), bundled],
      ...over,
    });
    assert.equal(await peerBinary('codex', deps({})), installed);
    // No native CLI found (`bin` falls back to the bare name): the one local resume would use.
    assert.equal(await peerBinary('codex', deps({ installed: () => 'codex' })), onPath);
    // Only the desktop app is installed: its bundled CLI.
    assert.equal(
      await peerBinary('codex', deps({ installed: () => 'codex', onPath: missing })),
      bundled,
    );
    await assert.rejects(
      peerBinary('codex', deps({ installed: () => 'codex', onPath: missing, bundled: [] })),
      /missing/,
    );
    // Other tools never look at Codex locations.
    assert.equal(
      await peerBinary('tmux', deps({ onPath: async (n: string) => '/x/' + n })),
      '/x/tmux',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('wake binds the source and origin to the selected ordinary Codex conversation', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'peer-wake-'));
  const nativeId = randomUUID();
  const sourcePath = path.join(cwd, 'rollout.jsonl');
  const s = {
    ...demoSnapshot().sessions[0],
    provider: 'codex' as const,
    nativeId,
    id: 'codex:' + nativeId,
    cwd,
    sourcePath,
    relation: undefined,
    origin: undefined,
  };
  const meta = (id: string, originator: string, source: unknown = 'cli') =>
    writeFile(
      sourcePath,
      JSON.stringify({ type: 'session_meta', payload: { id, originator, source } }) + '\n',
    );
  try {
    await meta(nativeId, 'Codex Desktop');
    assert.equal(await resumeOrigin(s), 'desktop');
    await meta(nativeId, 'codex-tui');
    assert.equal(await resumeOrigin(s), 'cli');
    await meta(randomUUID(), 'codex-tui');
    assert.equal(await resumeOrigin(s), null);
    await meta(nativeId, 'codex-tui', { subagent: {} });
    assert.equal(await resumeOrigin(s), null);
    await meta(nativeId, 'other');
    assert.equal(await resumeOrigin(s), null);
    await assert.rejects(resumeOrigin({ ...s, cwd: 'relative' }));
    await assert.rejects(resumeOrigin({ ...s, provider: 'claude' }));
    await assert.rejects(resumeOrigin({ ...s, origin: { kind: 'scheduled', source: 'fixture' } }));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
