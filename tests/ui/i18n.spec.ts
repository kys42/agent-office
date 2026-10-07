import { test, expect, type Page } from '@playwright/test';
// The other specs pin Korean; these cover the English default and switching languages.
const hangul = /[가-힣]/;
const visibleText = (page: Page) => page.locator('body').innerText();

test.describe('English system', () => {
  test.use({ locale: 'en-US' });

  test('opens in English and switches to Korean from Settings', async ({ page }) => {
    await page.goto('/?demo');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('button', { name: 'Open Inbox' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Coco, / })).toBeVisible();
    await expect(page).toHaveTitle(/Agent Office/);
    expect(await visibleText(page)).not.toMatch(hangul);

    await page.getByRole('button', { name: 'Connections & Settings' }).click();
    const language = page.getByRole('combobox', { name: 'Language' });
    await expect(language).toHaveValue('auto');
    await language.selectOption('ko');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page.getByRole('combobox', { name: '언어' })).toHaveValue('ko');

    // Demo teammates follow the language without losing the saved preference.
    await page.getByRole('button', { name: '우리 사무실' }).click();
    await expect(page.getByRole('button', { name: /^코코, / })).toBeVisible();
    await expect(page.getByRole('button', { name: '소식함 열기' })).toBeVisible();
    await page.getByRole('button', { name: '연결과 설정' }).click();
    await page.getByRole('combobox', { name: '언어' }).selectOption('en');
    await expect(page.getByRole('combobox', { name: 'Language' })).toHaveValue('en');
  });

  test('?lang=ko pins Korean for previews', async ({ page }) => {
    await page.goto('/?demo&lang=ko');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page.getByRole('button', { name: /^코코, / })).toBeVisible();
  });

  test('English work card, inbox and command palette', async ({ page }) => {
    await page.goto('/?demo');
    await page.getByRole('button', { name: /^Coco, / }).click();
    const card = page.getByRole('complementary', { name: "Teammate's work card" });
    await expect(card).toBeVisible();
    expect(await card.innerText()).not.toMatch(hangul);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Open Inbox' }).click();
    const inbox = page.getByRole('complementary', { name: 'Inbox' });
    await expect(inbox).toBeVisible();
    expect(await inbox.innerText()).not.toMatch(hangul);
    await page.keyboard.press('Escape');

    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog');
    await expect(palette).toBeVisible();
    expect(await palette.innerText()).not.toMatch(hangul);
  });
});

test.describe('Korean system', () => {
  test.use({ locale: 'ko-KR' });

  test('follows the system language', async ({ page }) => {
    await page.goto('/?demo');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page.getByRole('button', { name: /^코코, / })).toBeVisible();
  });
});

test.describe('Unsupported system language', () => {
  test.use({ locale: 'ja-JP' });

  test('falls back to English', async ({ page }) => {
    await page.goto('/?demo');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('button', { name: /^Coco, / })).toBeVisible();
  });
});
