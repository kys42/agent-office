import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficeService } from '../server/service.js';

test('Newest activity wins when two rollout files describe the same session', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-duplicate-'));
  const root = path.join(temp, 'sessions');
  await mkdir(root);
  const id = '01a102c7-f8f8-71a0-82a0-aaaa4defdf64';
  const now = Date.now();
  const service = new OfficeService(path.join(temp, 'data'), temp);
  service.roots.codex = root;
  service.store.preferences({ enabledProviders: ['codex'] });
  try {
    for (const [label, at] of [
      ['new', now],
      ['old', now - 3600_000],
    ] as const) {
      const file = path.join(root, `rollout-${label}-${id}.jsonl`);
      await writeFile(
        file,
        [
          { type: 'session_meta', timestamp: new Date(at).toISOString(), payload: { id } },
          {
            type: 'response_item',
            timestamp: new Date(at).toISOString(),
            payload: { type: 'function_call', name: 'exec', call_id: label },
          },
        ]
          .map((x) => JSON.stringify(x))
          .join('\n') + '\n',
      );
      await utimes(file, at / 1000, at / 1000);
    }
    const snapshot = await service.refresh();
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0].updatedAt, now);
    assert.equal(snapshot.sessions[0].status, 'work');
    assert.match(snapshot.sessions[0].sourcePath, /rollout-new-/);
  } finally {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  }
});
