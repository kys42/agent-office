import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error The release helpers run as plain Node scripts.
import { releaseArchitecture, releaseStem, sha256 } from '../scripts/release-utils.mjs';

test('Release filenames bind a validated version, architecture and source commit', () => {
  const commit = 'a'.repeat(40);
  assert.equal(releaseStem('0.1.0', 'arm64', commit), 'Agent-Office-0.1.0-macOS-arm64-aaaaaaa');
  assert.equal(releaseArchitecture('x64'), 'x64');
  for (const arch of ['../outside', 'universal', 'linux'])
    assert.throws(() => releaseArchitecture(arch));
  for (const version of ['../outside', '1.0', 'v1.0.0', '1.0.0/../../'])
    assert.throws(() => releaseStem(version, 'arm64', commit));
  assert.throws(() => releaseStem('0.1.0', 'arm64', 'unknown'));
});

test('Artifact hashing uses exact file bytes and rejects missing files', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-release-hash-'));
  try {
    const file = path.join(temp, 'artifact');
    await writeFile(file, 'abc');
    assert.equal(
      await sha256(file),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    await assert.rejects(sha256(path.join(temp, 'missing')));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
