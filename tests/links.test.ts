import test from 'node:test';
import assert from 'node:assert/strict';
import { webLink } from '../src/shared/links.js';

test('only ordinary web pages from session text can be opened', () => {
  assert.equal(
    webLink('https://github.com/kys42/agent-office/pull/9'),
    'https://github.com/kys42/agent-office/pull/9',
  );
  assert.equal(webLink('  http://localhost:5173/?demo  '), 'http://localhost:5173/?demo');
  for (const bad of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'vscode://file/Users/me/x',
    'codex://threads/abc',
    'https://user:secret@example.com/',
    'not a url',
    '',
    'https://example.com/' + 'x'.repeat(2100),
    42,
    undefined,
  ])
    assert.equal(webLink(bad), null, String(bad).slice(0, 40));
});
