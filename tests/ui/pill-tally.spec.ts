import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import { TINY_HEIGHT } from '../../src/shared/dock-geometry';
import type { ViewSettings } from '../../src/shared/types';

// The row's, floor's and tiny's pill count the office like the pet (#324): the same coloured
// numbers, and hovering one lists who it counts, above the pill (the window grows for it).

const WIDTH = 1440;
const HEIGHT = 720;

/**
 * The demo office (one calls, one result to read, four at work), with the desktop bridge mocked:
 * dock calls are recorded, `room-on` can be held until the test grants it (`w.holdRoom`), cards
 * opened are recorded.
 */
async function setup(
  page: Page,
  hash: string,
  opts: { privacy?: boolean; views?: ViewSettings; width?: number; height?: number } = {},
) {
  const s = demoSnapshot();
  s.preferences = {
    ...s.preferences,
    privacy: !!opts.privacy,
    ...(opts.views ? { views: opts.views } : {}),
  };
  await page.setViewportSize({ width: opts.width ?? WIDTH, height: opts.height ?? HEIGHT });
  await page.addInitScript((s) => {
    const w = window as any;
    w.cards = [];
    w.docks = [];
    w.office = {
      snapshot: async () => structuredClone(s),
      subscribe: () => () => {},
      detail: async (id: string) => structuredClone(s.sessions.find((x: any) => x.id === id)),
      artifacts: async () => [],
      visit: async () => structuredClone(s),
      terminals: async () => ({}),
      card: async (action: string, target: any) => {
        w.cards.push({ action, id: target?.id });
      },
      dock: async (action: string) => {
        w.docks.push(action);
        if (action === 'room-on' && w.holdRoom) await new Promise((r) => (w.grant = r));
      },
      onDock: () => () => {},
      window: async () => {},
    };
  }, s);
  // A fresh load even when only the hash would change (a second setup in one test).
  await page.goto('about:blank');
  await page.goto(`/?lang=ko${hash}`);
}
/** Another look of the same page: only the hash changes, so load it again. */
async function go(page: Page, hash: string) {
  await page.goto(`/?lang=ko${hash}`);
  await page.reload();
}
/** The list rises in with a short animation: measure it once it has landed. */
const landed = (page: Page) =>
  expect
    .poll(() =>
      page
        .locator('.tally-list')
        .evaluate((el) =>
          el.getAnimations().map((a) => `${(a as CSSAnimation).animationName}:${a.playState}`),
        ),
    )
    .toEqual([]);
const pill = (page: Page) => page.locator('.dock-pill');
const list = (page: Page) => page.locator('.tally-list');
const docks = (page: Page) => page.evaluate(() => (window as any).docks as string[]);
const numbers = (scope: ReturnType<Page['locator']>) =>
  scope
    .locator('.tally-pill > button')
    .evaluateAll((els) => els.map((el) => [el.className.split(' ')[0], Number(el.textContent)]));
const dot = (scope: ReturnType<Page['locator']>, group: string) =>
  scope
    .locator(`.tally-${group} i`)
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);

test('the row, floor and tiny pills count the same groups, in the same colours, as the pet', async ({
  page,
}) => {
  await setup(page, '#mini');
  const pet = page.locator('.dock-pet-pillbar');
  const groups = await numbers(pet);
  expect(groups).toEqual([
    ['tally-attention', 1],
    ['tally-results', 1],
    ['tally-working', 4],
  ]);
  const colours = Object.fromEntries(
    await Promise.all(groups.map(async ([g]) => [g, await dot(pet, String(g).slice(6))])),
  );
  for (const hash of ['#mini=row', '#mini=floor', '#mini=row&tiny']) {
    await go(page, hash);
    await expect(pill(page).locator('.tally-pill > button')).toHaveCount(3);
    expect(await numbers(pill(page))).toEqual(groups);
    for (const [g] of groups) expect(await dot(pill(page), String(g).slice(6))).toBe(colours[g]);
    // The old summary is gone; the numbers name their group.
    await expect(pill(page).locator('.desk-row-summary')).toHaveCount(0);
    await expect(pill(page).locator('.tally-working')).toHaveAttribute('title', '일하는 중 4');
    await expect(
      pill(page).getByRole('group', { name: /나를 기다려요 1 · 확인할 결과 1/ }),
    ).toHaveCount(1);
  }
  // Tiny draws them smaller.
  const size = (await pill(page).locator('.tally-working i').boundingBox())!;
  expect(size.width).toBeLessThan(7);
  expect((await pill(page).boundingBox())!.height).toBeLessThan(30);
});

test('hovering a number lists who it counts above the pill, once the window has grown', async ({
  page,
}) => {
  await setup(page, '#mini=row');
  await page.evaluate(() => ((window as any).holdRoom = true));
  const working = pill(page).getByRole('button', { name: /^일하는 중 4명/ });
  await working.hover();
  // A pointer passing by opens nothing: the list waits for a short stay.
  await page.waitForTimeout(120);
  await expect(list(page)).toHaveCount(0);
  expect(await docks(page)).not.toContain('room-on');
  // Then the window is asked for room; the list stays unseen until the room is there.
  await expect.poll(() => docks(page)).toContain('room-on');
  await expect(list(page)).toHaveCSS('visibility', 'hidden');
  await page.evaluate(() => (window as any).grant());
  await expect(list(page)).toBeVisible();
  await expect(working).toHaveAttribute('aria-expanded', 'true');
  await expect(list(page).getByRole('button')).toHaveCount(4);
  await expect(list(page)).toHaveAttribute('data-solid', '');
  // Above the pill, touching it, and whole inside the window.
  await landed(page);
  const l = (await list(page).boundingBox())!;
  const p = (await pill(page).boundingBox())!;
  expect(l.y + l.height).toBeLessThanOrEqual(p.y + 3);
  expect(l.y + l.height).toBeGreaterThanOrEqual(p.y - 1);
  expect(l.y).toBeGreaterThanOrEqual(0);
  expect(l.x).toBeGreaterThanOrEqual(0);
  expect(l.x + l.width).toBeLessThanOrEqual(WIDTH);
  // The pill stays solid while its list is open.
  await expect
    .poll(() => pill(page).evaluate((el) => Number(getComputedStyle(el).opacity)))
    .toBeGreaterThan(0.9);
  await page.locator('.desk-row').screenshot({ path: '.local/tally-row-list.png' });
  // Up into the list without it closing; leaving both closes it and gives the room back.
  await list(page).getByRole('button').first().hover();
  await page.waitForTimeout(300);
  await expect(list(page)).toBeVisible();
  await page.mouse.move(20, 20);
  await expect(list(page)).toHaveCount(0);
  await expect.poll(async () => (await docks(page)).at(-1)).toBe('room-off');
});

test('a name opens that colleague’s card at its desk; Esc closes the list before the dock folds', async ({
  page,
}) => {
  await setup(page, '#mini=row');
  const results = pill(page).getByRole('button', { name: /^확인할 결과 1명/ });
  await results.click();
  await expect(list(page)).toBeVisible();
  const name = list(page).getByRole('button').first();
  const label = (await name.getAttribute('aria-label'))!;
  expect(label).toMatch(/업무 카드 열기$/);
  await name.click();
  await expect.poll(() => page.evaluate(() => (window as any).cards.at(-1)?.action)).toBe('open');
  const opened = await page.evaluate(() => (window as any).cards.at(-1).id);
  // The colleague it listed, by name.
  await expect(page.locator(`.desk-row [data-session-id="${opened}"]`).first()).toBeAttached();
  await expect(list(page)).toHaveCount(0);
  await expect.poll(async () => (await docks(page)).at(-1)).toBe('room-off');

  // Keys: focus a number, Enter opens, Tab reaches the names, Esc closes back to the number.
  await page.mouse.move(20, 20);
  const working = pill(page).getByRole('button', { name: /^일하는 중 4명/ });
  await working.focus();
  await page.keyboard.press('Enter');
  await expect(list(page)).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(list(page).getByRole('button').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(list(page)).toHaveCount(0);
  await expect(working).toBeFocused();
  // That Esc only closed the list: the dock did not fold to the pet.
  expect(await docks(page)).not.toContain('pet');
  await expect(page.locator('.desk-row')).toBeVisible();
  // Focus leaving the pill closes it too.
  await page.keyboard.press('Enter');
  await expect(list(page)).toBeVisible();
  await page.locator('.dock-pill-grip').focus();
  await expect(list(page)).toHaveCount(0);
});

test('screen sharing lists who without their names', async ({ page }) => {
  await setup(page, '#mini=row', { privacy: true });
  await pill(page)
    .getByRole('button', { name: /^일하는 중 4명/ })
    .click();
  await expect(list(page).getByRole('button')).toHaveCount(4);
  const names = await list(page).locator('.tally-list-name').allTextContents();
  for (const n of names) expect(['claude', 'codex', 'openclaw']).toContain(n);
  const s = demoSnapshot();
  for (const session of s.sessions) if (session.alias) expect(names).not.toContain(session.alias);
});

for (const theme of ['light', 'dark'] as const)
  test(`the tiny pill lists above itself in a short strip (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    // The tiny strip's own height, as the dock window is; the room grows it before the list shows.
    await setup(page, '#mini=row&tiny', { height: TINY_HEIGHT });
    await page.evaluate(() => ((window as any).holdRoom = true));
    // By keys: the test's window grows downward (a real one grows upward, under a still
    // pointer), so no pointer is left behind to leave the number.
    await pill(page)
      .getByRole('button', { name: /^일하는 중 4명/ })
      .focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => docks(page)).toContain('room-on');
    await page.setViewportSize({ width: WIDTH, height: TINY_HEIGHT + 560 });
    await page.evaluate(() => (window as any).grant());
    await expect(list(page)).toBeVisible();
    await landed(page);
    const l = (await list(page).boundingBox())!;
    const p = (await pill(page).boundingBox())!;
    expect(l.y + l.height).toBeLessThanOrEqual(p.y + 3);
    expect(l.y).toBeGreaterThanOrEqual(0);
    // Nothing of it clipped: the whole list shows without scrolling.
    expect(await list(page).evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    await page.screenshot({
      path: `.local/tally-tiny-list-${theme}.png`,
      clip: {
        x: Math.max(0, l.x - 40),
        y: l.y - 10,
        width: l.width + 300,
        height: p.y + p.height - l.y + 20,
      },
    });
  });

test('switched off for a look, its pill says the old summary', async ({ page }) => {
  await setup(page, '#mini=row', { views: { dock: { tally: false } } });
  await expect(pill(page).locator('.desk-row-summary')).toContainText('명');
  await expect(pill(page).locator('.desk-row-summary em')).toContainText('기다려요 1');
  await expect(pill(page).locator('.tally-pill')).toHaveCount(0);
  // Tiny keeps its own switch: still counting.
  await go(page, '#mini=row&tiny');
  await expect(pill(page).locator('.tally-pill > button')).toHaveCount(3);
  await setup(page, '#mini=row&tiny', { views: { tiny: { tally: false } } });
  await expect(pill(page).locator('.desk-row-summary em')).toContainText('기다리는 동료 1명');
  await expect(pill(page).locator('.tally-pill')).toHaveCount(0);
  // The pet keeps its numbers either way.
  await go(page, '#mini');
  await expect(page.locator('.dock-pet-tally')).toHaveCount(1);
});

test('the groups chosen for the pet are the ones every pill counts', async ({ page }) => {
  await setup(page, '#mini=row', { views: { pet: { tallyGroups: ['attention', 'working'] } } });
  expect(await numbers(pill(page))).toEqual([
    ['tally-attention', 1],
    ['tally-working', 4],
  ]);
});

test('at 390px the pill and its list stay inside the window', async ({ page }) => {
  await setup(page, '#mini=row', { width: 390 });
  const p = (await pill(page).boundingBox())!;
  expect(p.x).toBeGreaterThanOrEqual(0);
  expect(p.x + p.width).toBeLessThanOrEqual(390);
  await pill(page)
    .getByRole('button', { name: /^일하는 중 4명/ })
    .click();
  await expect(list(page)).toBeVisible();
  await landed(page);
  const l = (await list(page).boundingBox())!;
  expect(l.x).toBeGreaterThanOrEqual(0);
  expect(l.x + l.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('the pet pill and its list, for the record', async ({ page }) => {
  await setup(page, '#mini');
  await page.getByRole('button', { name: /^일하는 중 4명/ }).click();
  await expect(page.locator('.dock-pet-list')).toBeVisible();
  await page.locator('.desk-pet-stage').screenshot({ path: '.local/tally-pet-list.png' });
});

test('the pet pill walks the same keys: Tab into the names, Shift+Tab back to the number', async ({
  page,
}) => {
  await setup(page, '#mini');
  const working = page.getByRole('button', { name: /^일하는 중 4명/ });
  await working.focus();
  await page.keyboard.press('Enter');
  const names = page.locator('.dock-pet-list').getByRole('button');
  await expect(names.first()).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(names.first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(working).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dock-pet-list')).toHaveCount(0);
});
