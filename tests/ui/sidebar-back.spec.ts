import { test, expect } from '@playwright/test';
import './korean';

test('The left menu folds away and comes back, remembered after a reload', async ({ page }) => {
  await page.goto('/?demo');
  const menu = page.getByRole('complementary', { name: '주 메뉴' });
  await expect(menu).toBeVisible();
  const office = page.locator('.office-layout');
  const before = (await office.boundingBox())!.width;
  const toggle = page.getByRole('button', { name: '왼쪽 메뉴', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(menu).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // The office takes the room the menu gave up.
  await expect.poll(async () => (await office.boundingBox())!.width).toBeGreaterThan(before + 150);
  await page.screenshot({ path: '.local/sidebar-hidden.png' });
  await page.reload();
  await expect(menu).toBeHidden();
  // The command palette folds and unfolds it too.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('option', { name: /왼쪽 메뉴 펼치기/ }).click();
  await expect(menu).toBeVisible();
  await page.reload();
  await expect(menu).toBeVisible();
});

test('Phones keep their bottom menu: no folding there, even when folded on a wide window', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('office:sidebar', 'hidden'));
  await page.setViewportSize({ width: 400, height: 860 });
  await page.goto('/?demo');
  await expect(page.getByRole('button', { name: '왼쪽 메뉴', exact: true })).toBeHidden();
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

test('Outside the office the card just closes: no way back to a list it did not replace', async ({
  page,
}) => {
  await page.goto('/?demo');
  await page.getByRole('button', { name: '활동 기록' }).click();
  await page.locator('.activity-row').first().click();
  const card = page.getByRole('complementary', { name: '동료의 업무 카드' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: '명단으로 돌아가기' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: '업무 카드 닫기' })).toBeVisible();
});
