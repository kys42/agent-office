import { expect, test } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

test('open the release, skip it across restarts, then see the next version', async ({ page }) => {
  await page.addInitScript((snapshot) => {
    (window as any).office = {
      snapshot: async () => structuredClone(snapshot),
      subscribe: () => () => {},
      startupRelease: async () => {
        const version = localStorage.getItem('fixture:latest') || '0.2.0';
        return { version, url: 'https://github.com/kys42/agent-office/releases/tag/v' + version };
      },
      openLink: async (url: string) => sessionStorage.setItem('fixture:opened', url),
    };
  }, demoSnapshot());
  await page.goto('/');
  const banner = page.locator('.release-banner');
  await expect(banner).toContainText('0.2.0');
  await banner.getByRole('button', { name: '새 버전 보기' }).click();
  expect(await page.evaluate(() => sessionStorage.getItem('fixture:opened'))).toBe(
    'https://github.com/kys42/agent-office/releases/tag/v0.2.0',
  );
  await banner.getByRole('button', { name: '이 버전 건너뛰기' }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.toolbar')).toBeVisible();
  await expect(banner).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem('fixture:latest', '0.3.0'));
  await page.reload();
  await expect(banner).toContainText('0.3.0');
});
