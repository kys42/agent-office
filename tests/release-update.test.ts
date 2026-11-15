import assert from 'node:assert/strict';
import test from 'node:test';
import { startupRelease } from '../desktop/release-update.js';

const published = { tag_name: 'v0.10.0', draft: false, prerelease: false };
test('startup checks once and compares numeric versions; only opens the official release URL', async () => {
  let calls = 0;
  const check = startupRelease('0.9.9', async () => {
    calls++;
    return Response.json({ ...published, html_url: 'https://example.invalid/' });
  });
  const [first, second] = await Promise.all([check(), check()]);
  assert.deepEqual(first, {
    version: '0.10.0',
    url: 'https://github.com/kys42/agent-office/releases/tag/v0.10.0',
  });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});
test('same, older, invalid, prerelease and unpublished versions do not notify', async () => {
  for (const override of [
    { tag_name: '0.9.9' },
    { tag_name: '0.8.2' },
    { tag_name: 'latest' },
    { tag_name: 'v1.0.0-beta.1' },
    { prerelease: true },
    { draft: true },
  ]) {
    assert.equal(
      await startupRelease('0.9.9', async () => Response.json({ ...published, ...override }))(),
      null,
    );
  }
});
test('first release absent, API rate limit, offline and bad JSON stay quiet', async () => {
  for (const request of [
    async () => new Response(null, { status: 404 }),
    async () => new Response(null, { status: 403 }),
    async () => {
      throw Error('offline');
    },
    async () => new Response('not json'),
  ]) {
    assert.equal(await startupRelease('0.1.0', request)(), null);
  }
});
