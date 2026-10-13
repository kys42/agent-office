import { test, expect } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

test("The big office's right column is the same card as the pop-up, without the window's tools", async ({
  page,
}) => {
  await page.addInitScript((s) => {
    const w = window as any;
    w.cardCalls = [];
    w.office = {
      snapshot: async () => structuredClone(s),
      detail: async (id: string) => structuredClone(s.sessions.find((x: any) => x.id === id)),
      visit: async () => structuredClone(s),
      artifacts: async () => [],
      subscribe: () => () => {},
      // The desktop bridge has the card window's calls too: the office must not use them.
      card: async (what: string) => {
        w.cardCalls.push(what);
      },
    };
  }, demoSnapshot());
  await page.goto('/');
  await page.locator('.speech-bubble').first().click();
  const aside = page.getByRole('complementary', { name: '동료의 업무 카드' });
  await expect(aside).toBeVisible();
  // The card's header, tabs and chat box — the pop-up card's layout.
  await expect(aside).toHaveClass(/inspector-card/);
  const head = aside.locator('.card-head');
  await expect(head.locator('h2')).not.toBeEmpty();
  for (const name of ['인수인계 꾸리기', '사무실에 고정', '카드 메뉴', '업무 카드 닫기'])
    await expect(head.getByRole('button', { name })).toBeVisible();
  await expect(aside.getByRole('tab')).toHaveCount(4);
  await expect(aside.locator('.card-composer')).toBeVisible();
  // Already in the big office, and it is not a window of its own: no 'full view' or 'keep open'.
  await expect(head.getByRole('button', { name: '큰 사무실에서 보기' })).toHaveCount(0);
  await expect(head.getByRole('button', { name: '카드 열어 두기' })).toHaveCount(0);
  // Pressing the header does not move the card window (the office window drags by CSS).
  const box = (await head.locator('.card-title').boundingBox())!;
  await page.mouse.move(box.x + box.width + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 40, box.y + box.height / 2);
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).cardCalls)).toEqual([]);
  // Details live in the card's tab: branch and where it works.
  await aside.getByRole('tab', { name: '작업 정보' }).click();
  await expect(aside.locator('.card-info')).toBeVisible();
  await page.getByRole('button', { name: '업무 카드 닫기' }).click();
  await expect(aside).toHaveCount(0);
});
