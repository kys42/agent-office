import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import type { ProviderQuota } from '../../src/shared/types';

/**
 * The demo office served live, with Claude's five-hour limit used up (resetting `resetIn` ms
 * from now) or a failed read. Demo desks: 0 Claude working, 3 Claude calling, 5 Claude done,
 * 1 Codex thinking.
 */
async function serve(
  page: Page,
  read: 'used-up' | 'failed',
  resetIn = 2 * 3600_000,
  prefs: Record<string, unknown> = {},
) {
  const resetsAt = Date.now() + resetIn;
  const calls = { quotas: 0 };
  await page.route('**/api/rpc', (route) => {
    const { method } = route.request().postDataJSON();
    const now = Date.now();
    if (method === 'quotas') {
      calls.quotas++;
      const claude: ProviderQuota = {
        provider: 'claude',
        state: read === 'failed' ? 'error' : 'ok',
        windows:
          read === 'failed'
            ? []
            : [
                { key: 'five_hour', label: '5시간', usedPercent: 100, resetsAt },
                { key: 'seven_day', label: '1주', usedPercent: 40, resetsAt: null },
              ],
        checkedAt: now,
        source: 'test',
        message: '',
      };
      return route.fulfill({ json: { result: [claude] } });
    }
    const snapshot = demoSnapshot();
    snapshot.preferences = { ...snapshot.preferences, ...prefs };
    Object.assign(snapshot.sessions[0], {
      runtime: { phase: 'working', at: now, evidence: 'observed', reason: 'fixture' },
      updatedAt: now,
    });
    return route.fulfill({ json: { result: snapshot } });
  });
  return calls;
}
const desk = (page: Page, id: string) => page.locator(`.desk-station[data-station-id="${id}"]`);

test('A desk whose tool used up its limit goes dark, with a badge that explains it', async ({
  page,
}) => {
  await serve(page, 'used-up');
  await page.goto('/');
  await expect(desk(page, 'demo:5')).toHaveClass(/lights-out/);
  await expect(desk(page, 'demo:5').locator('.desk-screen')).toHaveCSS('background-image', 'none');
  // A running turn and a call keep their look; the badge still tells.
  for (const id of ['demo:0', 'demo:3']) {
    await expect(desk(page, id)).not.toHaveClass(/lights-out/);
    await expect(desk(page, id).locator('.quota-badge')).toBeVisible();
  }
  // Another tool's desk is untouched.
  await expect(desk(page, 'demo:1').locator('.quota-badge')).toHaveCount(0);
  const badge = desk(page, 'demo:5').getByRole('button', { name: 'Claude 사용 한도 소진' });
  const tip = badge.locator('.quota-tip');
  await expect(tip).toBeHidden();
  await badge.hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Claude 사용 한도를 다 썼어요');
  await expect(tip).toContainText('5시간 · 계정 전체 · 100% 사용');
  await expect(tip).toContainText('재설정');
  await expect(tip).toContainText('확인');
  await expect(tip).not.toContainText('1주');
  // Pressing it never opens the desk.
  await badge.click();
  await expect(page.locator('.inspector-heading')).toHaveCount(0);
  // From the keyboard too.
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();
  await badge.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(badge).toBeFocused();
  await expect(tip).toBeVisible();
});

test('The lights come back on once the limit resets', async ({ page }) => {
  await page.clock.install();
  await serve(page, 'used-up', 40_000);
  await page.goto('/');
  await expect(desk(page, 'demo:5')).toHaveClass(/lights-out/);
  await page.clock.fastForward('01:00');
  await expect(desk(page, 'demo:5')).not.toHaveClass(/lights-out/);
  await expect(page.locator('.quota-badge')).toHaveCount(0);
});

test('A failed read is not a used-up limit', async ({ page }) => {
  await serve(page, 'failed');
  await page.goto('/');
  await expect(desk(page, 'demo:5')).toBeVisible();
  await expect(page.locator('.lights-out')).toHaveCount(0);
  await expect(page.locator('.quota-badge')).toHaveCount(0);
});

test('A failed read clears the lights and the back-off holds even when the window comes back', async ({
  page,
}) => {
  await page.clock.install();
  let fail = false;
  let calls = 0;
  await page.route('**/api/rpc', (route) => {
    const { method } = route.request().postDataJSON();
    const now = Date.now();
    if (method === 'quotas') {
      calls++;
      if (fail) return route.abort();
      const claude: ProviderQuota = {
        provider: 'claude',
        state: 'ok',
        windows: [{ key: 'five_hour', label: '5시간', usedPercent: 100, resetsAt: now + 7200_000 }],
        checkedAt: now,
        source: 'test',
        message: '',
      };
      return route.fulfill({ json: { result: [claude] } });
    }
    return route.fulfill({ json: { result: demoSnapshot() } });
  });
  const shown = (hidden: boolean) =>
    page.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  await page.goto('/');
  await expect(desk(page, 'demo:5')).toHaveClass(/lights-out/);
  expect(calls).toBe(1);
  // The next read (five minutes on) fails: nothing is claimed any more.
  fail = true;
  await page.clock.fastForward('05:01');
  await expect(desk(page, 'demo:5')).not.toHaveClass(/lights-out/);
  expect(calls).toBe(2);
  // Away and back six minutes later: still inside the 15-minute back-off, no read.
  await shown(true);
  await page.clock.fastForward('06:00');
  await shown(false);
  await page.clock.runFor(1000);
  expect(calls).toBe(2);
  // Once the back-off is over, it reads again.
  fail = false;
  await page.clock.fastForward('10:00');
  await expect(desk(page, 'demo:5')).toHaveClass(/lights-out/);
  expect(calls).toBe(3);
});

test('Privacy mode neither reads the limits nor claims anything', async ({ page }) => {
  const calls = await serve(page, 'used-up', undefined, { privacy: true });
  await page.goto('/');
  await expect(desk(page, 'demo:5')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator('.lights-out')).toHaveCount(0);
  await expect(page.locator('.quota-badge')).toHaveCount(0);
  expect(calls.quotas).toBe(0);
});

test('The row, floor and pet show the same, and take the pointer there', async ({ page }) => {
  await serve(page, 'used-up');
  for (const hash of ['#mini=row', '#mini=floor']) {
    await page.goto(`/${hash}`);
    await page.reload();
    const row = page.locator(`.desk-row .desk-station[data-station-id="demo:5"]`);
    await expect(row).toHaveClass(/lights-out/);
    await expect(row.locator('.quota-badge')).toHaveAttribute('data-solid');
  }
  // The pet stands for the calling Claude colleague: badge, but its light stays on.
  await page.goto('/#mini');
  await page.reload();
  await expect(page.locator('.dock-pet-quota')).toHaveAttribute('data-solid');
  await expect(page.locator('.desk-pet')).not.toHaveClass(/lights-out/);
});
