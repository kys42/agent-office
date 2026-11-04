import { test, expect } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

// The way back to the desk pet is a labelled accent pill, easy to spot in both themes; a narrow
// toolbar keeps it as an icon pill with the same name.
async function open(page: import('@playwright/test').Page) {
  const fixture = demoSnapshot();
  await page.addInitScript((s) => {
    (window as any).office = {
      snapshot: async () => structuredClone(s),
      detail: async (id: string) => structuredClone(s.sessions.find((x) => x.id === id)),
      visit: async () => structuredClone(s),
      preferences: async (patch: object) => {
        Object.assign(s.preferences, patch);
        return structuredClone(s);
      },
      artifacts: async () => [],
      subscribe: () => () => {},
    };
  }, fixture);
  await page.goto('/');
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the desk pet button reads as a labelled pill (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await open(page);
    const button = page.getByRole('button', { name: '데스크 펫', exact: true });
    await expect(button).toBeVisible();
    await expect(button).toContainText('데스크 펫');
    const look = await button.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, border: s.borderTopWidth };
    });
    expect(look.bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(look.border).toBe('1px');
    await page
      .locator('.toolbar')
      .screenshot({ path: `.local/header-mini-${colorScheme}.png` })
      .catch(() => {});
  });
}

test('a narrow toolbar keeps the desk pet button as an icon pill with its name', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1050, height: 740 });
  await open(page);
  // Open a card so the dock narrows the toolbar.
  await page.locator('.session-row').first().click();
  const button = page.getByRole('button', { name: '데스크 펫', exact: true });
  await expect(button).toBeVisible();
  const width = await page.locator('.toolbar').evaluate((el) => el.getBoundingClientRect().width);
  if (width <= 720) await expect(button.locator('span')).toBeHidden();
  const box = (await button.boundingBox())!;
  const bar = (await page.locator('.toolbar').boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
  await page.locator('.toolbar').screenshot({ path: '.local/header-mini-narrow.png' });
});
