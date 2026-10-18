import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('mobile shared chat bundle cannot pull in the desktop RPC or native backend', async () => {
  const result = await build({
    entryPoints: ['src/mobile/main.tsx'],
    bundle: true,
    write: false,
    outdir: '/virtual-chat-build',
    metafile: true,
    platform: 'browser',
    format: 'esm',
    loader: { '.woff2': 'empty' },
    logLevel: 'silent',
  });
  const inputs = Object.keys(result.metafile!.inputs);
  assert.ok(inputs.includes('src/components/chat/ConversationMessage.tsx'));
  assert.ok(inputs.includes('src/components/chat/ChatComposer.tsx'));
  assert.ok(inputs.includes('src/components/chat/ChatMarkdown.tsx'));
  assert.equal(
    inputs.some(
      (file) =>
        /^(desktop|server)\//.test(file) ||
        file === 'src/lib/api.ts' ||
        file === 'src/lib/chat-actions.ts',
    ),
    false,
  );
});
