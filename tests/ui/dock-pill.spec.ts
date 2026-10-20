import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import { FLOOR_HEIGHT, PILL_MARGIN, ROW_HEIGHT, TINY_HEIGHT } from '../../src/shared/dock-geometry';

const WIDTH = 1440;
const HEIGHT = 720;

/**
 * Three colleagues in two zones; run-1 calls the person. `bridge` mocks the desktop main
 * process (mode, tiny, click-through and the settings window); without it the dock is a
 * browser preview.
 */
async function setup(page: Page, hash: string, opts: { bridge?: boolean } = { bridge: true }) {
  const snapshot = demoSnapshot();
  const template = snapshot.sessions[0];
  const now = Date.now();
  snapshot.sessions = [0, 1, 2].map((i) => ({
    ...template,
    id: `run-${i}`,
    nativeId: `run-${i}`,
    alias: `동료 ${i}`,
    title: `업무 ${i}`,
    project: i < 2 ? 'team-a' : 'team-b',
    cwd: i < 2 ? '/tmp/team-a' : '/tmp/team-b',
    workspace: undefined,
    area: undefined,
    branch: 'main',
    officeSeat: i,
    status: i === 1 ? 'call' : 'idle',
    updatedAt: now,
    events: [],
    activity: undefined,
    actor: undefined,
    origin: undefined,
  }));
  snapshot.notices = [];
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await page.addInitScript(
    ({ s, bridge }) => {
      const w = window as any;
      w.fixture = s;
      w.calls = [];
      w.settingsOpened = [];
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string) =>
          structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(w.fixture),
        artifacts: async () => [],
        terminals: async () => ({}),
        subscribe: () => () => {},
        card: async () => {},
      };
      if (bridge) {
        const state = { mode: 'row', tiny: false };
        w.office.dock = async (action: string) => {
          w.calls.push(action);
          if (['row', 'floor', 'pet'].includes(action)) state.mode = action;
          else if (action === 'tiny-on' || action === 'tiny-off') state.tiny = action === 'tiny-on';
          else return;
          w.mode?.(state.mode, state.tiny);
        };
        w.office.onDock = (cb: any) => {
          w.mode = cb;
          return () => {};
        };
        w.office.settings = {
          open: async (section?: string) => w.settingsOpened.push(section ?? null),
          onOpen: () => () => {},
        };
      }
    },
    { s: snapshot, bridge: !!opts.bridge },
  );
  await page.goto(`/?lang=ko${hash}`);
  await expect(page.locator('.row-zone')).toHaveCount(2);
}
const pill = (page: Page) => page.locator('.dock-pill');
const grip = (page: Page) => page.getByRole('button', { name: '도구 막대 옮기기' });
const box = async (page: Page) => (await pill(page).boundingBox())!;
const centre = async (page: Page) => {
  const b = await box(page);
  return b.x + b.width / 2;
};
/** How far the scene's bottom is from the window's bottom edge (0: standing on it). */
const sceneGap = (page: Page) =>
  page.evaluate(() => {
    const win = document.querySelector('.desk-row')!.getBoundingClientRect();
    const scene = document.querySelector('.desk-row-scene')!.getBoundingClientRect();
    return Math.round(win.bottom - scene.bottom);
  });
const opacity = (page: Page) => pill(page).evaluate((el) => Number(getComputedStyle(el).opacity));
/** Gap between the pill and the window's right side (PILL_MARGIN: at home). */
const fromRight = async (page: Page) => {
  const b = await box(page);
  return Math.round(WIDTH - (b.x + b.width));
};
const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('office:dock-pill:v1') ?? 'null'));

test("The tool pill floats over the desks' feet, which still stand on the bottom edge", async ({
  page,
}) => {
  await setup(page, '#mini=row');
  await expect(pill(page)).toHaveCount(1);
  await expect(page.locator('.desk-row-tools, .tiny-tools, .desk-row-lounge')).toHaveCount(0);
  await expect(pill(page)).toHaveAttribute('data-solid');
  // A labelled group of buttons; the grip says how to move it.
  await expect(page.getByRole('group', { name: '책상 줄 도구' })).toHaveCount(1);
  await expect(grip(page)).toHaveAccessibleDescription(/Home\/End/);
  await expect(grip(page)).toHaveAttribute('aria-keyshortcuts', /ArrowLeft/);
  const b = await box(page);
  // The window is as tall as before the pill, and the scene stands on its bottom edge.
  expect(Math.round((await page.locator('.desk-row').boundingBox())!.height)).toBe(ROW_HEIGHT);
  expect(await sceneGap(page)).toBe(0);
  // ~8px above the bottom edge, over the scene, at the right end (home) the first time.
  expect(Math.abs(HEIGHT - (b.y + b.height) - 8)).toBeLessThanOrEqual(1.5);
  expect(await fromRight(page)).toBe(PILL_MARGIN);
  // Every row control lives in the pill (no lounge), with the waiting summary.
  for (const name of [
    '새로고침',
    '바닥 책상으로 보기',
    '작게 보기',
    '사무실 펼치기',
    '책상 줄 접기',
    '설정',
    '데스크 펫 숨기기',
  ])
    await expect(pill(page).getByRole('button', { name, exact: true })).toBeVisible();
  await expect(pill(page).locator('.desk-row-summary')).toContainText('3명');
  await expect(pill(page).locator('.desk-row-summary em')).toContainText('기다려요 1');
  // Only the pill takes the mouse: the empty strip beside it lets clicks through.
  const through = await page.evaluate(
    ([x, y]) => !document.elementFromPoint(x, y)?.closest('[data-solid]'),
    [40, HEIGHT - 8],
  );
  expect(through).toBe(true);
  await page.locator('.desk-row').screenshot({ path: '.local/dock-pill-row.png' });

  await pill(page).getByRole('button', { name: '바닥 책상으로 보기' }).click();
  await expect(page.locator('.desk-row.desk-floor')).toBeVisible();
  await expect
    .poll(async () => {
      const f = await box(page);
      return Math.abs(HEIGHT - (f.y + f.height) - 8);
    })
    .toBeLessThanOrEqual(1.5);
  const floor = await box(page);
  expect(Math.round((await page.locator('.desk-row').boundingBox())!.height)).toBe(FLOOR_HEIGHT);
  // Desk legs reach the window's bottom edge, as before the pill.
  const legs = await page
    .locator('.desk-row .team-bench')
    .evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().bottom)));
  expect(HEIGHT - legs).toBeLessThanOrEqual(8);
  expect(legs).toBeGreaterThan(floor.y);
  await expect(pill(page).getByRole('button', { name: '사무실 줄로 보기' })).toBeVisible();
  await page.locator('.desk-row').screenshot({ path: '.local/dock-pill-floor.png' });
});

test('Settings opens the settings window; a browser preview has none to open', async ({
  page,
  context,
}) => {
  await setup(page, '#mini=row');
  await pill(page).getByRole('button', { name: '설정', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).settingsOpened)).toEqual([null]);

  // A fresh page: init scripts stay with the page they were added to.
  const preview = await context.newPage();
  await setup(preview, '#mini=row', { bridge: false });
  await expect(pill(preview).getByRole('button', { name: '새로고침' })).toBeVisible();
  await expect(pill(preview).getByRole('button', { name: '설정', exact: true })).toHaveCount(0);
});

test('Dragging moves the pill, keeps the window solid, and stays after reload', async ({
  page,
}) => {
  await setup(page, '#mini=row');
  const g = (await grip(page).boundingBox())!;
  const start = await centre(page);
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 - 400, g.y + g.height / 2, { steps: 8 });
  await expect(pill(page)).toHaveClass(/is-dragging/);
  // Like a zone handle: the window keeps the mouse for the whole drag.
  expect(await page.evaluate(() => (window as any).calls)).toContain('solid');
  await page.mouse.up();
  await expect(pill(page)).not.toHaveClass(/is-dragging/);
  const moved = await centre(page);
  expect(Math.abs(moved - (start - 400))).toBeLessThanOrEqual(2);
  const spot = await saved(page);
  expect(spot.v).toBe(1);
  expect(Math.abs(spot.x - moved / WIDTH)).toBeLessThan(0.002);
  await page.locator('.desk-row').screenshot({ path: '.local/dock-pill-dragged.png' });

  await page.reload();
  await expect(page.locator('.row-zone')).toHaveCount(2);
  expect(Math.abs((await centre(page)) - moved)).toBeLessThanOrEqual(2);
  // A narrower screen keeps the same idea of where it was (a fraction of the width).
  await page.setViewportSize({ width: 1000, height: HEIGHT });
  await expect.poll(async () => Math.abs((await centre(page)) - spot.x * 1000)).toBeLessThan(2);

  // Pushed past the edge, it stops whole inside the window.
  const g2 = (await grip(page).boundingBox())!;
  await page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2);
  await page.mouse.down();
  await page.mouse.move(-200, g2.y + g2.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await box(page)).x).toBe(PILL_MARGIN);
});

test('A click on a pill button is a click, not a drag', async ({ page }) => {
  await setup(page, '#mini=row');
  const before = await centre(page);
  expect(before).toBeGreaterThan(0);
  await pill(page).getByRole('button', { name: '새로고침' }).click();
  expect(Math.abs((await centre(page)) - before)).toBeLessThanOrEqual(1);
  await pill(page).getByRole('button', { name: '책상 줄 접기' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).calls)).toContain('pet');
  expect(await saved(page)).toBeNull();
});

test('A double-click on a pill button does not bring the pill back to the middle', async ({
  page,
}) => {
  await setup(page, '#mini=row');
  await grip(page).click();
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  const spot = (await saved(page)).x;
  const at = await centre(page);
  await pill(page).getByRole('button', { name: '새로고침' }).dblclick();
  expect((await saved(page)).x).toBe(spot);
  expect(Math.abs((await centre(page)) - at)).toBeLessThanOrEqual(1);
});

for (const how of ['Escape', 'blur']) {
  test(`${how} during a drag puts the pill back where it began`, async ({ page }) => {
    await setup(page, '#mini=row');
    const g = (await grip(page).boundingBox())!;
    const start = await centre(page);
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 - 300, g.y + g.height / 2, { steps: 6 });
    await expect(pill(page)).toHaveClass(/is-dragging/);
    expect(Math.abs((await centre(page)) - (start - 300))).toBeLessThanOrEqual(2);
    if (how === 'Escape') await page.keyboard.press('Escape');
    else await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(pill(page)).not.toHaveClass(/is-dragging/);
    expect(Math.abs((await centre(page)) - start)).toBeLessThanOrEqual(1);
    await page.mouse.up();
    expect(Math.abs((await centre(page)) - start)).toBeLessThanOrEqual(1);
    expect(await saved(page)).toBeNull();
  });
}

test('Let go over the see-through corner, the window lets clicks through again', async ({
  page,
}) => {
  await setup(page, '#mini=row');
  const g = (await grip(page).boundingBox())!;
  const y = g.y + g.height / 2;
  await page.mouse.move(g.x + g.width / 2, y);
  await page.mouse.down();
  // Down to the empty bottom-left corner (the pill stops at its margin).
  await page.mouse.move(g.x + g.width / 2 - 200, y, { steps: 4 });
  await page.mouse.move(4, HEIGHT - 2, { steps: 4 });
  expect(await page.evaluate(() => (window as any).calls)).toContain('solid');
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).calls.at(-1))).toBe('through');
});

test('The grip moves the pill from the keyboard; double-click brings it back home', async ({
  page,
}) => {
  await setup(page, '#mini=row');
  const start = await centre(page);
  const desks = await page.locator('.desk-row-track').evaluate((el) => el.scrollLeft);
  // A mouse press on the grip focuses it, so the arrows move the pill, not the desks.
  await grip(page).click();
  await expect(grip(page)).toBeFocused();
  expect(Math.abs((await centre(page)) - start)).toBeLessThanOrEqual(1);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => start - (await centre(page))).toBeGreaterThan(20);
  const one = await centre(page);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => one - (await centre(page))).toBeGreaterThan(100);
  // The arrows moved the pill, not the desks.
  expect(await page.locator('.desk-row-track').evaluate((el) => el.scrollLeft)).toBe(desks);
  await page.keyboard.press('Home');
  await expect.poll(async () => (await box(page)).x).toBe(PILL_MARGIN);
  await page.keyboard.press('End');
  await expect.poll(() => fromRight(page)).toBe(PILL_MARGIN);
  expect((await saved(page)).x).toBeGreaterThan(0.5);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => fromRight(page)).toBeGreaterThan(100);

  // Double-click the pill's body (its summary): home again, and nothing remembered.
  await pill(page).locator('.desk-row-summary').dblclick();
  await expect.poll(() => fromRight(page)).toBe(PILL_MARGIN);
  expect(await saved(page)).toBeNull();
});

test('Tiny keeps a compact pill at the same spot', async ({ page }) => {
  await setup(page, '#mini=row');
  await grip(page).click();
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  const spot = (await saved(page)).x;
  await pill(page).getByRole('button', { name: '작게 보기' }).click();
  await expect(page.locator('.desk-row')).toHaveClass(/is-tiny/);
  const b = await box(page);
  expect(b.height).toBeLessThan(30);
  expect(b.y + b.height).toBeLessThanOrEqual(HEIGHT);
  expect(HEIGHT - (b.y + b.height)).toBeLessThanOrEqual(8);
  expect(Math.abs(b.x + b.width / 2 - spot * WIDTH)).toBeLessThanOrEqual(2);
  // Show big, the summary and hide (plus its grip); the rest waits for the full size.
  await expect(pill(page).getByRole('button', { name: '크게 보기' })).toBeVisible();
  await expect(pill(page).getByRole('button', { name: '데스크 펫 숨기기' })).toBeVisible();
  await expect(pill(page).locator('.desk-row-summary')).toContainText('3');
  await expect(pill(page).locator('.desk-row-summary em')).toContainText('기다리는 동료 1명');
  for (const name of ['설정', '새로고침', '사무실 펼치기', '책상 줄 접기'])
    await expect(pill(page).getByRole('button', { name, exact: true })).toHaveCount(0);
  expect(await sceneGap(page)).toBe(0);
  await page.locator('.desk-row').screenshot({ path: '.local/dock-pill-tiny.png' });
  // The tiny pill drags the same way.
  const g = (await grip(page).boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 - 300, g.y + g.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await saved(page)).x).toBeLessThan(spot - 0.15);
});

test('At rest the pill is subdued; hover, focus or a drag makes it solid', async ({ page }) => {
  await setup(page, '#mini=row');
  await page.mouse.move(20, 20);
  await expect.poll(() => opacity(page)).toBeCloseTo(0.45, 2);
  await pill(page).hover();
  await expect.poll(() => opacity(page)).toBeCloseTo(0.95, 2);
  await page.mouse.move(20, 20);
  await expect.poll(() => opacity(page)).toBeCloseTo(0.45, 2);
  // Keyboard focus inside it counts too.
  await grip(page).focus();
  await expect.poll(() => opacity(page)).toBeCloseTo(0.95, 2);
  await grip(page).blur();
  await expect.poll(() => opacity(page)).toBeCloseTo(0.45, 2);
  // Reduced motion: no fade, just the change.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await pill(page).evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(
    /^0s(, 0s)*$/,
  );
});

test('A desk partly under the pill still takes clicks and hover beside it', async ({ page }) => {
  await setup(page, '#mini=row');
  // Park the pill under the first desk's middle, as someone might by accident.
  const first = (await page.locator('.desk-row .desk-station').first().boundingBox())!;
  await page.evaluate(
    (x) => localStorage.setItem('office:dock-pill:v1', JSON.stringify({ v: 1, x })),
    (first.x + first.width / 2) / WIDTH,
  );
  await page.reload();
  await expect(page.locator('.row-zone')).toHaveCount(2);
  await page.mouse.move(20, 20);
  const b = await box(page);
  // A desk whose box reaches under the pill.
  const under = await page.locator('.desk-row .desk-station').evaluateAll(
    (els, p) =>
      els
        .map((e) => {
          const r = e.getBoundingClientRect();
          return { id: e.getAttribute('data-station-id'), x: r.x, y: r.y, w: r.width, h: r.height };
        })
        .find((r) => r.x < p.x + p.width && r.x + r.w > p.x && r.y + r.h > p.y),
    b,
  );
  expect(under).toBeTruthy();
  const desk = page.locator(`.desk-row [data-station-id="${under!.id}"]`);
  // Inside the desk, just above the pill: the desk is what the pointer finds.
  const x = Math.min(Math.max(under!.x + under!.w / 2, b.x + 4), b.x + b.width - 4);
  const y = b.y - 6;
  const hit = await page.evaluate(
    ([px, py, id]) => !!document.elementFromPoint(px, py)?.closest(`[data-station-id="${id}"]`),
    [x, y, under!.id] as const,
  );
  expect(hit).toBe(true);
  await page.mouse.move(x, y);
  expect(await desk.evaluate((el) => el.matches(':hover'))).toBe(true);
  expect(await opacity(page)).toBeLessThan(0.5);
  // Inside the pill's own box the pill takes it.
  const onPill = await page.evaluate(
    ([px, py]) => !!document.elementFromPoint(px, py)?.closest('.dock-pill'),
    [x, b.y + b.height / 2],
  );
  expect(onPill).toBe(true);
  // A click beside the pill reaches the desk (it opens it, never moves the pill).
  const before = await saved(page);
  await page.mouse.click(x, y);
  await expect(pill(page)).not.toHaveClass(/is-dragging/);
  expect(await saved(page)).toEqual(before);
});

test('Tiny starts with the pill at the right end, off the desks and their dots', async ({
  page,
}) => {
  await setup(page, '#mini=row');
  await pill(page).getByRole('button', { name: '작게 보기' }).click();
  await expect(page.locator('.desk-row')).toHaveClass(/is-tiny/);
  expect(Math.round((await page.locator('.desk-row').boundingBox())!.height)).toBe(TINY_HEIGHT);
  await expect.poll(() => fromRight(page)).toBe(PILL_MARGIN);
  expect(await saved(page)).toBeNull();
  const b = await box(page);
  // Tiny desks are whole inside the window and on its bottom edge.
  expect(await sceneGap(page)).toBe(0);
  const desks = await page
    .locator('.desk-row .desk-station')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  const top = (await page.locator('.desk-row').boundingBox())!.y;
  for (const d of desks) {
    expect(d.top).toBeGreaterThanOrEqual(top - 1);
    // And none sits under the pill at its starting spot.
    expect(d.right <= b.x || d.left >= b.x + b.width).toBe(true);
  }
  await page.mouse.move(20, 20);
  await page.locator('.desk-row').screenshot({ path: '.local/dock-pill-tiny-rest.png' });
  // Double-click: back home, the right end.
  await grip(page).click();
  await page.keyboard.press('Home');
  await expect.poll(async () => (await box(page)).x).toBe(PILL_MARGIN);
  await pill(page).locator('.desk-row-summary').dblclick();
  await expect.poll(() => fromRight(page)).toBe(PILL_MARGIN);
});
