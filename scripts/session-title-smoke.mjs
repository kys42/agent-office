import { build } from 'esbuild';
import { sdkImportMeta } from './node-bundle.mjs';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(os.tmpdir(), 'office-title-bundle-'));
try {
  const bundle = path.join(root, 'title.cjs');
  await build({
    entryPoints: ['server/session-title.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: bundle,
    plugins: [sdkImportMeta],
  });
  const { nativeSessionRenamer } = createRequire(import.meta.url)(bundle);
  const id = randomUUID(),
    sourcePath = path.join(root, 'project', id + '.jsonl');
  await mkdir(path.dirname(sourcePath));
  const original =
    JSON.stringify({ type: 'user', sessionId: id, message: { role: 'user', content: 'fixture' } }) +
    '\n';
  await writeFile(sourcePath, original);
  await nativeSessionRenamer({ claudeRoot: root }).rename(
    { id: 'claude:' + id, nativeId: id, provider: 'claude', sourcePath, cwd: root },
    'Bundled title',
    () => {},
  );
  const content = await readFile(sourcePath, 'utf8');
  assert.ok(content.startsWith(original));
  assert.equal(JSON.parse(content.trim().split('\n')[1]).customTitle, 'Bundled title');
  console.log('Bundled Claude SDK title mutation: PASS');
} finally {
  await rm(root, { recursive: true, force: true });
}
