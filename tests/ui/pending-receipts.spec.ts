import { test, expect, type Page } from '@playwright/test';

async function prepare(page: Page) {
  await page.route('**/receipt-test', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Receipt isolation test</title>',
    }),
  );
  await page.goto('/receipt-test');
  await page.evaluate(async () => {
    const module = '/src/lib/pendingSends.ts';
    (window as any).receipts = await import(module);
  });
}
const stored = (page: Page) =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('office:sent:v1:'))
      .map((k) => JSON.parse(localStorage.getItem(k)!)),
  );

test('two windows keep unique, text-free receipts; dismiss and reconciliation survive a restart', async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  await prepare(page);
  await prepare(other);
  const at = Date.now();
  // Identical request timestamps from different renderers must still have unique identities.
  await Promise.all(
    [page, other].map((p) =>
      p.evaluate(async (at) => {
        await (window as any).receipts.rememberSend(
          's1',
          'private request sk-test-secret-value',
          at,
        );
      }, at),
    ),
  );
  await expect.poll(async () => (await stored(page)).length).toBe(2);
  expect((await stored(page)).every((p) => !('text' in p) && p.fingerprint.length === 64)).toBe(
    true,
  );
  await prepare(page);
  await prepare(other);
  const event = {
    id: 'user-1',
    kind: 'user',
    text: 'private request sk-test-secret-value',
    at: at + 1000,
  };
  await Promise.all(
    [page, other].map((p) =>
      p.evaluate(async (e) => {
        await (window as any).receipts.settlePending('s1', [e]);
      }, event),
    ),
  );
  expect((await stored(page)).length).toBe(1);
  // The already consumed transcript event must never settle the repeated request on restart.
  await prepare(page);
  await page.evaluate(async (e) => {
    await (window as any).receipts.settlePending('s1', [e]);
  }, event);
  expect((await stored(page)).length).toBe(1);
  const id = (await stored(page))[0].id;
  await other.evaluate((id) => (window as any).receipts.dismissSend(id), id);
  expect(await stored(page)).toEqual([]);
  await prepare(page);
  expect(await stored(page)).toEqual([]);
});

test('restored image receipts reconcile without storing request text or attachment paths', async ({
  page,
}) => {
  await prepare(page);
  const at = Date.now();
  await page.evaluate(async (at) => {
    await (window as any).receipts.rememberSend('s1', 'look here', at, 2);
  }, at);
  await prepare(page);
  await page.evaluate(async (at) => {
    await (window as any).receipts.settlePending('s1', [
      { id: 'u1', kind: 'user', at, text: '[Image #1] [Image #2]look here' },
    ]);
  }, at);
  expect(await stored(page)).toEqual([]);
});

test('expired receipts and legacy text-containing receipts are removed on startup', async ({
  page,
}) => {
  await prepare(page);
  await page.evaluate(() => {
    const base = { sessionId: 's1', at: Date.now() };
    localStorage.setItem(
      'office:sent:v1:sent:old',
      JSON.stringify({ ...base, id: 'sent:old', at: 0 }),
    );
    localStorage.setItem(
      'office:sent:v1:sent:legacy',
      JSON.stringify({ ...base, id: 'sent:legacy', text: 'private old text' }),
    );
  });
  await prepare(page);
  expect(await stored(page)).toEqual([]);
});

test('without WebCrypto a receipt remains visible and is never guessed to match a record', async ({
  page,
}) => {
  await prepare(page);
  const at = Date.now();
  await page.evaluate(async (at) => {
    Object.defineProperty(window, 'crypto', { value: undefined });
    await (window as any).receipts.rememberSend('s1', 'uncertain transcript', at);
  }, at);
  expect((await stored(page)).length).toBe(1);
  expect((await stored(page))[0].fingerprint).toBeUndefined();
  await prepare(page);
  await page.evaluate(async (at) => {
    await (window as any).receipts.settlePending('s1', [
      { id: 'u1', kind: 'user', at, text: 'uncertain transcript' },
    ]);
  }, at);
  expect((await stored(page)).length).toBe(1);
});
