import { test, expect, type Locator, type Page } from '@playwright/test';
import './korean';

const width = async (l: Locator) => (await l.boundingBox())!.width;
async function drag(page: Page, handle: Locator, dx: number) {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y);
  await page.mouse.move(x + dx, y);
  await page.mouse.up();
}

test('The right column is dragged wider, keeps that width for the card, and resets on double click', async ({
  page,
}) => {
  await page.goto('/?demo');
  const roster = page.locator('.office-layout > .roster');
  const handle = page.getByRole('separator', { name: /오른쪽 칸 폭/ });
  const before = await width(roster);
  await drag(page, handle, -200);
  await expect.poll(() => width(roster)).toBeGreaterThan(before + 150);
  const wide = await width(roster);
  // The card takes the same column: as wide as the list was.
  await page.locator('.session-row').first().click();
  const card = page.getByRole('complementary', { name: '동료의 업무 카드' });
  await expect.poll(() => width(card)).toBeGreaterThan(wide - 4);
  await page.screenshot({ path: '.local/panel-resize-wide.png' });
  // Remembered after a reload (the demo opens without a card: the list has the width).
  await page.reload();
  await expect.poll(() => width(roster)).toBeGreaterThan(wide - 4);
  await page.getByRole('separator', { name: /오른쪽 칸 폭/ }).dblclick();
  await expect.poll(() => width(roster)).toBeLessThan(before + 4);
});

test('The right column stops at its limits, and the keyboard moves the edge too', async ({
  page,
}) => {
  await page.goto('/?demo');
  const roster = page.locator('.office-layout > .roster');
  const handle = page.getByRole('separator', { name: /오른쪽 칸 폭/ });
  await drag(page, handle, 600);
  await expect.poll(() => width(roster)).toBeLessThan(302);
  await expect(handle).toHaveAttribute('aria-valuenow', '300');
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', '316');
  await drag(page, handle, -2000);
  // The office keeps its room.
  const stage = page.locator('.office-column');
  expect(await width(stage)).toBeGreaterThan(470);
});

test('The left menu is dragged wider and narrower within its limits', async ({ page }) => {
  await page.goto('/?demo');
  const menu = page.getByRole('complementary', { name: '주 메뉴' });
  const handle = page.getByRole('separator', { name: /왼쪽 메뉴 폭/ });
  await drag(page, handle, 80);
  await expect.poll(() => width(menu)).toBeGreaterThan(290);
  await drag(page, handle, -400);
  await expect.poll(() => width(menu)).toBeLessThan(182);
  await page.reload();
  await expect.poll(() => width(menu)).toBeLessThan(182);
});

test('Narrow windows float the card and phones stack: no edges to drag there', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto('/?demo');
  await expect(page.getByRole('separator', { name: /오른쪽 칸 폭/ })).toBeHidden();
  await expect(page.getByRole('separator', { name: /왼쪽 메뉴 폭/ })).toBeHidden();
});

test('A width dragged on a wide window gives way when the window narrows; bad saved values are ignored', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('office:panel-widths', JSON.stringify({ side: 360, dock: 760 })),
  );
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/?demo');
  const stage = page.locator('.office-column');
  expect(await width(stage)).toBeGreaterThanOrEqual(470);
  // Narrower than the edges: the stylesheet's floating layout, not the dragged widths.
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.locator('.session-row').first().click();
  const card = page.getByRole('complementary', { name: '동료의 업무 카드' });
  await expect.poll(() => width(card)).toBeLessThan(340);
  await page.setViewportSize({ width: 1440, height: 970 });
  await page.evaluate(() =>
    localStorage.setItem('office:panel-widths', '{"side":"300px","dock":-1}'),
  );
  await page.reload();
  // The menu keeps its default width; the column its minimum.
  const menu = page.getByRole('complementary', { name: '주 메뉴' });
  await expect.poll(() => width(menu)).toBeGreaterThan(200);
  await expect(page.locator('.app')).toHaveCSS('grid-template-columns', /px .*px/);
});
