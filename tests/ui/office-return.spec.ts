import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

// The big office's floating way back to the desktop dock: a large translucent pill at the
// bottom of the office, named after the look the dock was left in. Settings › 모습 › 큰 사무실
// can switch it off.

/** The desktop bridge: the dock was left as the tiny row; preferences merge views like the service. */
async function bridge(page: Page, { desktop = true, lounge = 0 } = {}) {
  const snapshot = demoSnapshot();
  snapshot.preferences = { ...snapshot.preferences, privacy: false, locale: 'ko' };
  // `lounge` extra colleagues resting in the lounge (quiet for half a day).
  const template = snapshot.sessions[0];
  const quiet = Date.now() - 12 * 3600_000;
  for (let i = 0; i < lounge; i++)
    snapshot.sessions.push({
      ...template,
      id: `rest-${i}`,
      nativeId: `rest-${i}`,
      alias: `쉬는 동료 ${i}`,
      title: `쉬는 업무 ${i}`,
      status: 'ready',
      zone: 'waiting',
      officeSeat: undefined,
      pinned: false,
      archived: false,
      updatedAt: quiet - i * 60_000,
      returnedAt: undefined,
      events: [],
    });
  await page.addInitScript(
    ({ s, desktop }) => {
      const w = window as any;
      w.fixture = s;
      w.windowCalls = [];
      w.listeners = [];
      if (!desktop) return;
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string) =>
          structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(w.fixture),
        artifacts: async () => [],
        terminals: async () => ({}),
        subscribe: (cb: any) => {
          w.listeners.push(cb);
          return () => {};
        },
        preferences: async (p: any) => {
          const prior = w.fixture.preferences.views ?? {};
          const views = p.views ? { ...prior } : undefined;
          for (const mode of Object.keys(p.views ?? {}))
            views[mode] = { ...prior[mode], ...p.views[mode] };
          w.fixture = {
            ...w.fixture,
            version: (w.fixture.version ?? 0) + 1,
            preferences: { ...w.fixture.preferences, ...p, ...(views ? { views } : {}) },
          };
          for (const cb of w.listeners) cb(structuredClone(w.fixture));
          return structuredClone(w.fixture);
        },
        notices: async () => structuredClone(w.fixture),
        window: async (action: string) => {
          w.windowCalls.push(action);
        },
        settings: { open: async () => {}, onOpen: () => () => {} },
        dockLook: async () => ({ mode: 'row', tiny: true }),
        onDockLook: (cb: (look: unknown) => void) => {
          w.tellLook = cb;
          return () => {};
        },
      };
    },
    { s: snapshot, desktop },
  );
}

const pill = (page: Page) => page.locator('.office-return-button');
/** Whether the pill's box crosses any visible element matching `selector`. */
const overlapsAny = (button: ReturnType<typeof pill>, selector: string) =>
  button.evaluate((el, sel) => {
    const a = el.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .filter((o) => !o.contains(el))
      .map((o) => o.getBoundingClientRect())
      .filter((b) => b.width > 0 && b.height > 0)
      .some((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom);
  }, selector);

test('the office floats a big way back to the dock look it was left in', async ({ page }) => {
  await bridge(page);
  await page.goto('/?lang=ko');
  const button = pill(page);
  await expect(button).toBeVisible();
  await expect(button).toHaveAccessibleName('쪼꼬미 줄로 돌아가기');
  await expect(button).toContainText('쪼꼬미 줄로 돌아가기');
  // The look's own icon (the desk row) with the tiny mark, as on the dock's 보기 button.
  await expect(button.locator('.dock-view-tiny-mark')).toHaveCount(1);

  // Big enough to spot, centred at the bottom of the office column (not over the roster).
  const box = (await button.boundingBox())!;
  const column = (await page.locator('.office-column').boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(38);
  expect(Math.abs(box.x + box.width / 2 - (column.x + column.width / 2))).toBeLessThan(2);
  expect(column.y + column.height - (box.y + box.height)).toBeLessThan(90);
  // Above the stage's bottom HUD (status pills and zoom controls), never on it.
  expect(await overlapsAny(button, '.stage-hud')).toBe(false);
  // See-through at rest.
  const bg = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toMatch(/rgba?\(|color\(/);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');

  // Keyboard reachable; pressing it goes back to the dock (the header button's action).
  await button.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).windowCalls)).toEqual(['mini']);

  // The dock changed while the office was away: the label follows.
  await page.evaluate(() => (window as any).tellLook({ mode: 'floor', tiny: false }));
  await expect(button).toHaveAccessibleName('바닥으로 돌아가기');
  await page.evaluate(() => (window as any).tellLook({ mode: 'pet', tiny: false }));
  await expect(button).toHaveAccessibleName('데스크 펫으로 돌아가기');
  await expect(button.locator('.dock-view-tiny-mark')).toHaveCount(0);

  // The list view: it keeps clear of the list's footer, and the list scrolls past it.
  await page.getByRole('button', { name: '리스트', exact: true }).click();
  await expect(page.locator('.office-list')).toBeVisible();
  await expect(button).toBeVisible();
  expect(await overlapsAny(button, '.office-list-footer > *')).toBe(false);
  await page.getByRole('button', { name: '그래픽', exact: true }).click();

  // A popup from the office (a desk's quick reply, a menu, the past-colleagues list) lives in
  // the office card's own layer and could not rise over the pill: the pill steps aside while
  // one is open (composer-draft and residents specs drive the real ones).
  await page.evaluate(() => {
    const pop = document.createElement('div');
    pop.className = 'quick-reply';
    pop.id = 'stub-pop';
    document.querySelector('.office-card')!.appendChild(pop);
  });
  await expect(button).toBeHidden();
  await page.evaluate(() => document.getElementById('stub-pop')!.remove());
  await expect(button).toBeVisible();

  // Only on the office view: other tabs keep their content clear.
  await page.getByRole('button', { name: '기억 서랍', exact: true }).click();
  await expect(button).toHaveCount(0);
});

test('a card opened beside the office keeps the pill in the office column', async ({ page }) => {
  await bridge(page);
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto('/?lang=ko');
  await page.locator('.session-row, .office-card').first().click();
  const button = pill(page);
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  const main = (await page.locator('main.main-content').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(main.x);
  expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width + 0.5);
});

test('a narrow window keeps the whole pill on screen', async ({ page }, testInfo) => {
  await bridge(page);
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto('/?lang=ko');
  const button = pill(page);
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // It never sits on the stage's controls or the narrow layout's tab bar.
  expect(await overlapsAny(button, '.stage-hud, .sidebar')).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('return-button-narrow.png') });
});

test('a long lounge list scrolls its last row clear of the pill', async ({ page }) => {
  await bridge(page, { lounge: 30 });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?lang=ko');
  await page.getByRole('button', { name: '리스트', exact: true }).click();
  await page
    .getByRole('tab', { name: /대기 라운지/ })
    .first()
    .click();
  const rows = page.locator('.office-list-row');
  await expect(rows.nth(20)).toBeVisible();
  const button = pill(page);
  await expect(button).toBeVisible();
  // The list has no footer here: the pill sits low, and the list keeps room under its last row.
  await page.locator('.office-list-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
  const last = rows.last();
  await expect(last).toBeInViewport();
  const a = (await button.boundingBox())!;
  const b = (await last.boundingBox())!;
  expect(b.y + b.height).toBeLessThanOrEqual(a.y);
});

test('Settings › 모습 › 큰 사무실 switches the pill off', async ({ page }) => {
  await bridge(page);
  await page.goto('/?lang=ko');
  await expect(pill(page)).toBeVisible();
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  await page
    .getByRole('tablist', { name: '설정 분류' })
    .getByRole('tab', { name: '모습', exact: true })
    .click();
  const big = page.getByRole('article', { name: '큰 사무실', exact: true });
  const toggle = big.getByRole('switch', { name: '돌아가기 버튼' });
  // A main choice, not under 자세히; on by default.
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  // The settings preview of the office never draws it.
  await expect(big.locator('.office-return-button')).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(
    await page.evaluate(() => (window as any).fixture.preferences.views.office.returnButton),
  ).toBe(false);
  await page.getByRole('button', { name: '우리 사무실', exact: true }).click();
  await expect(page.locator('main.view-office')).toBeVisible();
  await expect(pill(page)).toHaveCount(0);
});

test('the browser preview has no dock to go back to', async ({ page }) => {
  await bridge(page, { desktop: false });
  await page.goto('/?demo');
  await expect(page.locator('.demo-banner')).toBeVisible();
  await expect(pill(page)).toHaveCount(0);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the pill reads over the office (${colorScheme})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme });
    await bridge(page);
    await page.goto('/?lang=ko');
    const button = pill(page);
    await expect(button).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`return-button-${colorScheme}.png`) });
    await button.hover();
    await expect.poll(() => button.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await page.screenshot({ path: testInfo.outputPath(`return-button-${colorScheme}-hover.png`) });
  });
}
