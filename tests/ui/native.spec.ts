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
  await expect(page.locator('.roster-scope')).toHaveText('api-server');
  // An exact project scope, not a text search that could also match look-alike names.
  await expect(page.getByLabel('동료 이름 검색')).toHaveValue('');
  await expect(page.locator('.session-row')).toHaveCount(1);
  expect(await seats()).toEqual(before);
  await page.getByRole('button', { name: '모든 프로젝트 보기' }).click();
  await expect(page.locator('.session-row')).toHaveCount(6);
});

test('A sidebar project chosen from another page still scopes the office', async ({ page }) => {
  await page.goto('/?demo&lang=ko');
  const sidebar = page.getByRole('complementary', { name: '주 메뉴' });
  await sidebar.getByRole('button', { name: '기억 서랍' }).click();
  await sidebar.getByRole('button', { name: /design-system/ }).click();
  await expect(page.locator('.roster-scope')).toHaveText('design-system');
  await expect(page.locator('.session-row')).toHaveCount(1);
});

test('The saved zone shows in the title and sidebar from the first paint', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('office:view:demo', JSON.stringify({ zone: 'waiting', sort: 'recent' }));
  });
  await page.goto('/?demo&lang=ko');
  await expect(page.getByRole('tab', { name: /대기 라운지/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.toolbar-title h1')).toHaveText('대기 라운지');
  await expect(
    page
      .getByRole('complementary', { name: '주 메뉴' })
      .getByRole('button', { name: /대기 라운지/ }),
  ).toHaveClass(/active/);
});

test('Turning on privacy clears a typed name from the roster search', async ({ page }) => {
  await page.goto('/?demo&lang=ko');
  await page.getByLabel('동료 이름 검색').fill('네모');
  await page.getByRole('button', { name: '화면 내용 숨기기' }).click();
  await expect(page.getByLabel('동료 이름 검색')).toHaveValue('');
});

test('Dialogs opened inside a page cover the whole window', async ({ page }) => {
  await page.goto('/?demo&lang=ko');
  await page
    .getByRole('complementary', { name: '주 메뉴' })
    .getByRole('button', { name: '연결과 설정' })
    .click();
  // The pet customizer is a Modal rendered inside the settings page.
  await page.locator('.settings-page button[aria-label*="Claude"]').first().click();
  const backdrop = (await page.locator('.modal-backdrop').boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(backdrop.x).toBe(0);
  expect(Math.round(backdrop.width)).toBe(viewport.width);
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
