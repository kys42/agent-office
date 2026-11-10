import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { codexConversationOpener } from '../desktop/codex-open.js';
const link =
  'codex://threads/11111111-2222-3333-4444-555555555555?hostId=remote-control%3Aenv_fixture';
test('Windows opens only the existing remote conversation through its registered protocol', async () => {
  const calls: Array<{
    file: string;
    args: string[];
    options: { timeout: number; windowsHide: boolean };
  }> = [];
  const open = codexConversationOpener('win32', async (file, args, options) => {
    calls.push({ file, args, options });
  });
  assert.ok(open);
  assert.equal(calls.length, 0, 'Target discovery never opens a conversation');
  await open(link);
  assert.equal(calls.length, 1);
  assert.match(calls[0].file, /\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.equal(calls[0].options.windowsHide, true);
  const args = calls[0].args;
  assert.equal(args.at(-2), '-EncodedCommand');
  const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
  assert.ok(script.includes(Buffer.from(link).toString('base64')));
  assert.ok(script.includes('UseShellExecute=$true'));
  for (const bad of [
    'https://example.com/',
    link + '&message=unexpected',
    link + '&hostId=ssh%3Aother',
    link.replace('remote-control%3Aenv_fixture', 'local'),
    link.replace('/11111111-2222-3333-4444-555555555555', '/settings'),
  ])
    await assert.rejects(open(bad));
  assert.equal(calls.length, 1, 'Invalid links never execute a helper');
  assert.equal(
    codexConversationOpener(
      'win32',
      async () => {
        throw Error('must not run');
      },
      path.join(os.tmpdir(), 'isolated-office'),
    ),
    undefined,
  );
});
test('macOS keeps its native opener and unsupported platforms have no prepare capability', async () => {
  let file = '',
    url = '';
  await codexConversationOpener('darwin', async (f, a) => {
    file = f;
    url = a[0];
  })!(link);
  assert.equal(file, '/usr/bin/open');
  assert.equal(url, link);
  assert.equal(codexConversationOpener('linux'), undefined);
});
