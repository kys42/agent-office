import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDetails, privacyPane } from '../src/shared/app-health';

test('support metadata never copies paths, source branches, credentials or malformed values', () => {
  assert.deepEqual(
    buildDetails({
      sourceCommit: 'a'.repeat(40),
      builtAt: '2026-10-29T00:00:00.000Z',
      path: '/secret',
      token: 'secret',
      sourceBranch: 'private-name',
    }),
    {
      commit: 'a'.repeat(40),
      builtAt: '2026-10-29T00:00:00.000Z',
    },
  );
  for (const value of [null, { sourceCommit: '/secret' }, { builtAt: '<script>' }])
    assert.deepEqual(buildDetails(value), { commit: null, builtAt: null });
});

test('permission navigation only accepts the fixed OS pane names', () => {
  assert.match(privacyPane('files')!, /^x-apple\.systempreferences:/);
  for (const value of ['https://evil', 'constructor', '__proto__', null, {}, 'full-disk'])
    assert.equal(privacyPane(value), null);
});
