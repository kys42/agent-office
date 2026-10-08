import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('office:guide:seen', '1');
    } catch {}
  });
});

test('Sidebar source list switches spaces and records, and mirrors the current zone', async ({
  page,
}) => {
  await page.goto('/?demo&lang=ko');
  const sidebar = page.getByRole('complementary', { name: '주 메뉴' });
  await sidebar.getByRole('button', { name: /대기 라운지/ }).click();
  await expect(page.getByRole('tab', { name: /대기 라운지/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(sidebar.getByRole('button', { name: /대기 라운지/ })).toHaveClass(/active/);
  await expect(page.locator('.toolbar-title h1')).toHaveText('대기 라운지');
  await sidebar.getByRole('button', { name: '기억 서랍' }).click();
  await expect(page.locator('.toolbar-title h1')).toHaveText('기억 서랍');
  await sidebar.getByRole('button', { name: '우리 사무실' }).click();
  await expect(page.getByRole('tab', { name: /^사무실/ })).toHaveAttribute('aria-selected', 'true');
});

test('Sidebar to-do items open the first teammate of that group', async ({ page }) => {
  await page.goto('/?demo&lang=ko');
  const sidebar = page.getByRole('complementary', { name: '주 메뉴' });
  await sidebar.getByRole('button', { name: /나를 기다려요/ }).click();
  await expect(page.locator('.inspector-heading h2')).toHaveText('당근');
  await sidebar.getByRole('button', { name: /확인할 결과/ }).click();
  await expect(page.locator('.inspector-heading h2')).toHaveText('모모');
});

test('Sidebar projects filter the roster without moving desks', async ({ page }) => {
  await page.goto('/?demo&lang=ko');
  await expect(page.locator('.office-pet')).toHaveCount(6);
  const seats = () =>
    page
      .locator('.desk-station')
      .evaluateAll((xs) => xs.map((x) => (x as HTMLElement).style.transform));
  const before = await seats();
  await page
    .getByRole('complementary', { name: '주 메뉴' })
    .getByRole('button', { name: /api-server/ })
    .click();
  await expect(page.getByLabel('동료 이름 검색')).toHaveValue('api-server');
  await expect(page.locator('.session-row')).toHaveCount(1);
  expect(await seats()).toEqual(before);
});

test('The zone switcher lives in the window toolbar', async ({ page }) => {
  await page.goto('/?demo&lang=ko');
  await expect(page.locator('.toolbar .zone-tabs[role="tablist"]')).toBeVisible();
  await expect(page.locator('.office-column .zone-tabs')).toHaveCount(0);
});

test('Appearance follows the system: light by default, dark when the system is dark', async ({
  browser,
}) => {
  for (const [scheme, dark] of [
    ['light', false],
    ['dark', true],
  ] as const) {
    const context = await browser.newContext({ colorScheme: scheme });
    const page = await context.newPage();
    await page.goto('/?demo&lang=ko');
    const lightness = await page.evaluate(() => {
      const [r, g, b] = getComputedStyle(document.querySelector('.main-content')!)
        .backgroundColor.match(/\d+/g)!
        .map(Number);
      return (r + g + b) / 3;
    });
    expect(lightness > 128).toBe(!dark);
    await context.close();
  }
});
