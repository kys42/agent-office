import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

async function card(page: Page) {
  await page.setViewportSize({ width: 480, height: 760 });
  await page.addInitScript((snapshot) => {
    const w = window as any;
    snapshot.sessions[0].provider = 'codex';
    snapshot.sessions[1].provider = 'codex';
    w.fixture = snapshot;
    w.lookups = [];
    w.sent = [];
    w.office = {
      snapshot: async () => structuredClone(snapshot),
      detail: async (id: string) => structuredClone(snapshot.sessions.find((s) => s.id === id)),
      visit: async () => structuredClone(snapshot),
      artifacts: async () => [],
      terminalSend: async () => true,
      subscribe: (cb: any) => {
        w.publish = () => cb(structuredClone(snapshot));
        return () => {};
      },
      onCard: (cb: any) => {
        w.show = (index: number) => cb({ id: snapshot.sessions[index].id });
        setTimeout(() => w.show(0), 20);
        return () => {};
      },
      terminals: (ids: string[]) =>
        new Promise((resolve, reject) => {
          w.lookups.push({
            ids,
            reject,
            finish: () =>
              resolve(
                Object.fromEntries(
                  ids.map((id) => [
                    id,
                    {
                      kind: 'codex',
                      status: 'queue',
                      canSend: true,
                      canFocus: true,
                      queues: true,
                      focus: { kind: 'orca', label: 'Current session' },
                    },
                  ]),
                ),
              ),
          });
        }),
      send: async (id: string, text: string) => {
        w.sent.push([id, text]);
        return { status: 'sent', message: '보냈어요' };
      },
    };
    w.update = () => {
      snapshot.sessions.forEach((s) => s.updatedAt++);
      snapshot.version++;
      w.publish();
    };
  }, demoSnapshot());
  await page.goto('/#card');
  await expect(page.locator('.terminal-send-chat textarea')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).lookups.length)).toBe(1);
}

test('activity while a connection lookup is pending keeps its result and coalesces refreshes', async ({
  page,
}) => {
  await card(page);
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => (window as any).update());
    // Each publication reaches the hook before the next one.
    await page.waitForTimeout(80);
  }
  expect(await page.evaluate(() => (window as any).lookups.length)).toBe(1);
  await page.evaluate(() => (window as any).lookups[0].finish());
  await expect(
    page.locator('.card-actions').getByRole('button', { name: 'Orca로 이동' }),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).lookups.length)).toBe(2);
  const input = page.locator('.terminal-send-chat textarea');
  await input.fill('연결 조회 중에도 보낼 말');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  expect(await page.evaluate(() => (window as any).sent)).toEqual([
    ['demo:0', '연결 조회 중에도 보낼 말'],
  ]);
});

test('a late lookup for the previous colleague cannot restore their connection in another card', async ({
  page,
}) => {
  await card(page);
  await page.evaluate(() => (window as any).show(1));
  await expect.poll(() => page.evaluate(() => (window as any).lookups.length)).toBe(2);
  await page.evaluate(() => (window as any).lookups[0].finish());
  await expect(
    page.locator('.card-actions').getByRole('button', { name: 'Orca로 이동' }),
  ).toHaveCount(0);
  await page.evaluate(() => (window as any).lookups[1].finish());
  await expect(
    page.locator('.card-actions').getByRole('button', { name: 'Orca로 이동' }),
  ).toBeVisible();
});

test('a failed lookup still runs a refresh requested while it was pending', async ({ page }) => {
  await card(page);
  await page.evaluate(() => (window as any).update());
  await page.waitForTimeout(80);
  await page.evaluate(() => (window as any).lookups[0].reject(new Error('temporary host failure')));
  await expect.poll(() => page.evaluate(() => (window as any).lookups.length)).toBe(2);
  await page.evaluate(() => (window as any).lookups[1].finish());
  await expect(
    page.locator('.card-actions').getByRole('button', { name: 'Orca로 이동' }),
  ).toBeVisible();
});
