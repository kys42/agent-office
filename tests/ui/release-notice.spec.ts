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

test('with the update check off nothing is asked; turning it on in Settings checks once', async ({
  page,
}) => {
  const snapshot = demoSnapshot();
  snapshot.preferences = { ...snapshot.preferences, startupUpdateCheck: false };
  await page.addInitScript((s) => {
    const w = window as any;
    w.fixture = s;
    w.asked = 0;
    w.listeners = [];
    w.office = {
      snapshot: async () => structuredClone(w.fixture),
      subscribe: (cb: any) => {
        w.listeners.push(cb);
        return () => {};
      },
      preferences: async (p: any) => {
        w.fixture = {
          ...w.fixture,
          version: (w.fixture.version ?? 0) + 1,
          preferences: { ...w.fixture.preferences, ...p },
        };
        for (const cb of w.listeners) cb(structuredClone(w.fixture));
        return structuredClone(w.fixture);
      },
      startupRelease: async () => {
        w.asked++;
        return {
          version: '0.2.0',
          url: 'https://github.com/kys42/agent-office/releases/tag/v0.2.0',
        };
      },
    };
  }, snapshot);
  await page.goto('/');
  await expect(page.locator('.toolbar')).toBeVisible();
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  const toggle = page.getByRole('switch', { name: '시작할 때 새 버전 확인' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.release-banner')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).asked)).toBe(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.release-banner')).toContainText('0.2.0');
  expect(await page.evaluate(() => (window as any).asked)).toBe(1);
  // Off again hides the notice already shown.
  await toggle.click();
  await expect(page.locator('.release-banner')).toHaveCount(0);
});
