import { test, expect } from '@playwright/test';
import './korean';

test('The left menu folds away and comes back, remembered after a reload', async ({ page }) => {
  await page.goto('/?demo');
  const menu = page.getByRole('complementary', { name: '주 메뉴' });
  await expect(menu).toBeVisible();
  const office = page.locator('.office-layout');
  const before = (await office.boundingBox())!.width;
  await page.getByRole('button', { name: '왼쪽 메뉴 접기' }).click();
  await expect(menu).toBeHidden();
  // The office takes the room the menu gave up.
  await expect.poll(async () => (await office.boundingBox())!.width).toBeGreaterThan(before + 150);
  await page.screenshot({ path: '.local/sidebar-hidden.png' });
  await page.reload();
  await expect(menu).toBeHidden();
  await page.getByRole('button', { name: '왼쪽 메뉴 펼치기' }).click();
  await expect(menu).toBeVisible();
  await page.reload();
  await expect(menu).toBeVisible();
});

test('Phones keep their bottom menu: no folding there', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 860 });
  await page.goto('/?demo');
  await expect(page.getByRole('button', { name: '왼쪽 메뉴 접기' })).toBeHidden();
  await expect(page.getByRole('complementary', { name: '주 메뉴' })).toBeVisible();
});

test("The office's work card goes back to the list it took the place of", async ({ page }) => {
  await page.goto('/?demo');
  const roster = page.locator('.office-layout > .roster');
  await expect(roster).toBeVisible();
  await page.locator('.session-row').first().click();
  const card = page.getByRole('complementary', { name: '동료의 업무 카드' });
  await expect(card).toBeVisible();
  await expect(roster).toBeHidden();
  await page.screenshot({ path: '.local/card-back.png' });
  await card.getByRole('button', { name: '명단으로 돌아가기' }).click();
  await expect(card).toHaveCount(0);
  await expect(roster).toBeVisible();
});
