import { test, expect, type Page } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';

test.use({ storageState: { cookies: [], origins: [] } });

async function liveFixture(page: Page, empty = false) {
  const s = demoSnapshot();
  s.preferences.locale = 'ko';
  if (empty) {
    s.sessions = [];
    s.notices = [];
    s.connectors.forEach((c) => {
      c.state = 'missing';
      c.count = 0;
    });
  }
  await page.addInitScript((s) => {
    window.office = {
      snapshot: async () => structuredClone(s),
      subscribe: () => () => {},
      artifacts: async () => [],
      visit: async () => structuredClone(s),
      detail: async (id: string) => structuredClone(s.sessions.find((x) => x.id === id)),
    } as any;
  }, s);
}

test('fresh launch tours, isolates keyboard commands, persists completion and reopens from menu/palette', async ({
  page,
}) => {
  await liveFixture(page);
  await page.goto('/?lang=ko');
  const guide = page.getByRole('dialog', { name: '사무실 사용 가이드' });
  await expect(guide).toBeVisible();
  await expect(guide.getByRole('heading', { level: 1 })).toContainText('작은 사무실');
  await page.keyboard.press('j');
  await page.keyboard.press('Meta+k');
  await expect(page.locator('.inspector')).toHaveCount(0);
  await expect(page.locator('.palette')).toHaveCount(0);
  for (let i = 0; i < 3; i++)
    await guide.getByRole('button', { name: '다음', exact: true }).click();
  await expect(guide).toContainText('어떤 동료가 들어올 수 있나요?');
  await guide.getByRole('button', { name: '내 사무실 열기', exact: true }).click();
  await expect(guide).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.office-pet').first()).toBeVisible();
  await expect(guide).toHaveCount(0);
  await page.getByRole('button', { name: '사무실 사용 가이드', exact: true }).click();
  await expect(guide.getByRole('button', { name: '기능 찾아보기' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+k');
  await page.locator('.palette input').fill('가이드');
  await page.locator('.palette-list').getByRole('option').first().click();
  await expect(guide).toBeVisible();
});

test('skipping and Escape both remember the tour and preserve existing preferences', async ({
  page,
}) => {
  await liveFixture(page);
  await page.addInitScript(() => localStorage.setItem('office:test-existing', 'keep-me'));
  await page.goto('/?lang=ko');
  await page.getByRole('button', { name: '직접 둘러볼게요' }).click();
  expect(await page.evaluate(() => localStorage.getItem('office:test-existing'))).toBe('keep-me');
  await page.reload();
  await expect(page.locator('.office-guide')).toHaveCount(0);
  await page.getByRole('button', { name: '사무실 사용 가이드', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.office-guide')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('office:onboarding:v1:live'))).toBe('seen');
});

test('demo guide is optional and never completes the live onboarding', async ({ page }) => {
  await liveFixture(page);
  await page.goto('/?demo&lang=ko');
  await expect(page.locator('.office-pet').first()).toBeVisible();
  await expect(page.locator('.office-guide')).toHaveCount(0);
  await page.getByRole('button', { name: '사무실 사용 가이드', exact: true }).click();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => localStorage.getItem('office:onboarding:v1:live'))).toBeNull();
  await page.goto('/?lang=ko');
  await expect(page.locator('.office-guide')).toBeVisible();
});

test('empty office explains connections and routes setup without a fake work card', async ({
  page,
}) => {
  await liveFixture(page, true);
  await page.goto('/?lang=ko');
  const guide = page.getByRole('dialog');
  await guide.getByRole('button', { name: '4 / 4 단계 · 내 사무실 만들기' }).click();
  await expect(guide).toContainText('아직 동료가 없나요?');
  await guide.getByRole('button', { name: '기능 찾아보기' }).click();
  await expect(
    guide.getByRole('button', { name: '동료가 들어오면 사용할 수 있어요' }),
  ).toBeDisabled();
  await guide.getByRole('button', { name: '캐릭터 고르기' }).click();
  await expect(page.locator('.pet-settings')).toBeVisible();
  await expect(page.locator('.office-guide')).toHaveCount(0);
});

test('feature guide routes to inbox, memory, usage, activity and shortcuts', async ({ page }) => {
  await page.goto('/?demo&lang=ko');
  const menu = page.getByRole('button', { name: '사무실 사용 가이드', exact: true });
  for (const [action, target] of [
    ['소식함 열기', '.news-inbox'],
    ['기억 서랍 열기', '.memory-page'],
    ['사용량 보기', '.usage-dock'],
    ['활동 열기', '.activity-page'],
    ['단축키 보기', '.shortcut-grid'],
  ]) {
    await menu.click();
    await page.getByRole('dialog').getByRole('button', { name: action, exact: true }).click();
    await expect(page.locator(target)).toBeVisible();
    if (action === '단축키 보기') await page.keyboard.press('Escape');
  }
});

test('setup actions reach the matching settings section and work cards and pets open from the guide', async ({
  page,
}) => {
  await page.goto('/?demo&lang=ko');
  const menu = page.getByRole('button', { name: '사무실 사용 가이드', exact: true });
  for (const [action, section] of [
    ['캐릭터 고르기', 'appearance'],
    ['사무실 설정하기', 'office'],
    ['설정 열기', 'rhythm'],
  ]) {
    await menu.click();
    await page.getByRole('dialog').getByRole('button', { name: action, exact: true }).click();
    await expect(page.locator(`[data-guide-section="${section}"]`)).toBeInViewport();
    await expect(page.locator(`[data-guide-section="${section}"]`)).toBeFocused();
  }
  await menu.click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '업무 카드 열기', exact: true })
    .click();
  await expect(page.locator('.inspector')).toBeVisible();
  await menu.click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '데스크 펫 써보기', exact: true })
    .click();
  await expect(page.locator('.desk-pet')).toBeVisible();
  await expect(page.locator('.office-guide')).toHaveCount(0);
});

test('English tour remains readable at small window sizes with trapped focus', async ({ page }) => {
  await page.setViewportSize({ width: 440, height: 580 });
  await page.goto('/?demo&onboarding&lang=en');
  const guide = page.getByRole('dialog', { name: 'Your guide to Agent Office' });
  await expect(guide).toBeVisible();
  expect(await guide.innerText()).not.toMatch(/[가-힣]/);
  await guide.getByRole('button', { name: 'Next', exact: true }).click();
  await guide.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(guide.getByRole('heading', { level: 1 })).toContainText('beside your work');
  const bounds = await guide.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(440);
  expect(bounds!.height).toBeLessThanOrEqual(580);
  await guide.getByRole('button', { name: 'Next', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(guide.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await guide.getByRole('button', { name: 'Find a feature', exact: true }).click();
  await expect(guide.getByRole('button', { name: 'Desktop app only' })).toBeDisabled();
  await guide.getByRole('button', { name: 'Open my office', exact: true }).click();
  await expect(guide).toHaveCount(0);
});
