import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { demoSnapshot } from '../src/lib/demo.js';
import { resumeOrigin } from '../server/federation/wake.js';

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
