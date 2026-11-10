import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import { PET_ROOM_HEIGHT, PET_SIZE } from '../../src/shared/dock-geometry';
import { chooseView, viewButton, viewItem, viewMenu } from './dock-view';

/**
 * The dock's one 보기 (view) menu and its app-drawn tooltips. `bridge` mocks the desktop main
 * process: it keeps the look (mode, tiny), records every dock call (room too) and has a
 * settings window.
 */
async function setup(
  page: Page,
  hash: string,
  { width = 1440, height = 720 }: { width?: number; height?: number } = {},
) {
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
  await page.setViewportSize({ width, height });
  const mode = new URLSearchParams(hash.replace(/^#/, '')).get('mini') ?? 'pet';
  await page.addInitScript(
    ({ s, mode }) => {
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
        window: async (action: string) => w.calls.push(`window:${action}`),
        settings: {
          open: async (section?: string) => w.settingsOpened.push(section ?? null),
          onOpen: () => () => {},
        },
      };
      const state = { mode, tiny: false };
      w.office.dock = async (action: string) => {
        if (action !== 'solid' && action !== 'through') w.calls.push(action);
        if (['row', 'floor', 'pet'].includes(action)) state.mode = action;
        else if (action === 'tiny-on' || action === 'tiny-off') {
          state.tiny = action === 'tiny-on';
          if (state.mode === 'pet') return;
        } else return;
        w.mode?.(state.mode, state.tiny);
      };
      w.office.onDock = (cb: any) => {
        w.mode = cb;
        return () => {};
      };
    },
    { s: snapshot, mode },
  );
  await page.goto(`/?lang=ko${hash}`);
}
const calls = (page: Page) => page.evaluate(() => (window as any).calls as string[]);
const pill = (page: Page) => page.locator('.dock-pill');
const box = async (l: import('@playwright/test').Locator) => (await l.boundingBox())!;

test('보기 opens above the pill with each look explained and the current one checked', async ({
  page,
}) => {
  await setup(page, '#mini=row');
  await expect(page.locator('.row-zone')).toHaveCount(2);
  const button = viewButton(pill(page));
  await expect(button).toHaveText('보기');
  await expect(button).toHaveAttribute('aria-haspopup', 'menu');
  await button.click();
  const menu = viewMenu(page);
  await expect(menu).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(menu).toHaveAttribute('data-side', 'above');
  await expect(menu).toHaveAttribute('data-solid');
  // Above the button, whole inside the window.
  const b = await box(button);
  const m = await box(menu);
  expect(m.y + m.height).toBeLessThanOrEqual(b.y);
  expect(m.y).toBeGreaterThanOrEqual(0);
  expect(m.x).toBeGreaterThanOrEqual(0);
  expect(m.x + m.width).toBeLessThanOrEqual(1440);
  // The looks, then tiny, the big office and settings; each look says what it is.
  const looks = menu.getByRole('menuitemradio');
  await expect(looks).toHaveText([
    /데스크 펫\s*바탕화면에 펫 하나만/,
    /책상 줄\s*동료 책상을 한 줄로/,
    /바닥\s*프로젝트별 바닥에 책상/,
  ]);
  await expect(viewItem(page, '책상 줄')).toHaveAttribute('aria-checked', 'true');
  await expect(viewItem(page, '데스크 펫')).toHaveAttribute('aria-checked', 'false');
  await expect(viewItem(page, '쪼꼬미')).toHaveAttribute('aria-checked', 'false');
  await expect(viewItem(page, '쪼꼬미')).toHaveAccessibleDescription('줄·바닥을 작게');
  await expect(viewItem(page, '큰 사무실 열기')).toBeVisible();
  await expect(viewItem(page, '설정')).toBeVisible();
  // The colleague list waits for its window (a later change): nothing offers it yet.
  await expect(menu.getByRole('menuitem', { name: '동료 목록' })).toHaveCount(0);
  // The current look has the focus, and the keys walk the entries.
  await expect(viewItem(page, '책상 줄')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(viewItem(page, '바닥')).toBeFocused();
  await page.keyboard.press('End');
  await expect(viewItem(page, '설정')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(viewItem(page, '데스크 펫')).toBeFocused();
  await page.mouse.move(m.x + 10, m.y + 10);
  await page.screenshot({
    path: '.local/view-menu-row.png',
    clip: { x: 1440 - 420, y: m.y - 12, width: 420, height: 720 - (m.y - 12) },
  });
  // The window asked for room while it was open.
  expect(await calls(page)).toContain('room-on');
});

test('Choosing a look goes there, after giving the room back', async ({ page }) => {
  await setup(page, '#mini=row');
  await expect(page.locator('.row-zone')).toHaveCount(2);
  await chooseView(page, '바닥', pill(page));
  await expect(page.locator('.desk-row.desk-floor')).toBeVisible();
  // Room first, then the look: the floor never opens at the menu's height.
  const c = await calls(page);
  expect(c.slice(c.lastIndexOf('room-on'))).toEqual(['room-on', 'room-off', 'floor']);
  // Tiny is a toggle that keeps the look.
  await chooseView(page, '쪼꼬미', pill(page));
  await expect(page.locator('.desk-row.desk-floor.is-tiny')).toBeVisible();
  expect((await calls(page)).at(-1)).toBe('tiny-on');
  await viewButton(pill(page)).click();
  await expect(viewItem(page, '바닥')).toHaveAttribute('aria-checked', 'true');
  await expect(viewItem(page, '쪼꼬미')).toHaveAttribute('aria-checked', 'true');
  const m = await box(viewMenu(page));
  // Past the menu's short fade-in, for the picture.
  await page.waitForTimeout(300);
  await page.screenshot({
    path: '.local/view-menu-tiny.png',
    clip: { x: 1440 - 420, y: m.y - 12, width: 420, height: 720 - (m.y - 12) },
  });
  await viewItem(page, '큰 사무실 열기').click();
  await expect.poll(() => calls(page)).toContain('window:main');
});

test('Esc closes the menu (not the dock) and gives the focus back; a click outside closes it', async ({
  page,
}) => {
  await setup(page, '#mini=row');
  await expect(page.locator('.row-zone')).toHaveCount(2);
  const button = viewButton(pill(page));
  await button.click();
  await expect(viewMenu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewMenu(page)).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.desk-row')).toBeVisible();
  expect(await calls(page)).not.toContain('pet');
  expect((await calls(page)).at(-1)).toBe('room-off');
  // The arrow keys belong to the menu while it is open, never paging the row behind it.
  await button.click();
  await page.keyboard.press('ArrowLeft');
  await expect(viewMenu(page)).toBeVisible();
  // A press elsewhere in the window closes it.
  await page.mouse.click(200, 200);
  await expect(viewMenu(page)).toHaveCount(0);
  expect((await calls(page)).at(-1)).toBe('room-off');
  // Pressing 보기 again closes it as well.
  await button.click();
  await expect(viewMenu(page)).toBeVisible();
  await button.click();
  await expect(viewMenu(page)).toHaveCount(0);
});

test('The desk pet has the same 보기 menu, above its tools, with room asked for', async ({
  page,
}) => {
  // The pet's window while the menu holds its room (main process: PET_ROOM_HEIGHT, same width).
  await setup(page, '#mini', { width: PET_SIZE.width, height: PET_ROOM_HEIGHT });
  await expect(page.locator('.desk-pet')).toBeVisible();
  const tools = page.locator('.dock-pet-tools');
  await page.locator('.dock-pet-anchor').hover();
  await expect(tools.getByRole('button')).toHaveCount(2);
  for (const name of ['새로고침', '책상 펼치기', '사무실 펼치기'])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await viewButton(tools).click();
  const menu = viewMenu(page);
  await expect(menu).toHaveAttribute('data-side', 'above');
  expect(await calls(page)).toContain('room-on');
  await expect(viewItem(page, '데스크 펫')).toHaveAttribute('aria-checked', 'true');
  await expect(viewItem(page, '쪼꼬미')).toHaveAttribute('aria-checked', 'false');
  const m = await box(menu);
  const b = await box(viewButton(tools));
  expect(m.y + m.height).toBeLessThanOrEqual(b.y);
  expect(m.x).toBeGreaterThanOrEqual(0);
  expect(m.x + m.width).toBeLessThanOrEqual(PET_SIZE.width);
  // The tools stay up while the pointer is on the menu.
  await page.mouse.move(m.x + m.width / 2, m.y + 10);
  await expect(tools).toHaveCSS('opacity', '1');
  await page.screenshot({ path: '.local/view-menu-pet.png' });
  // Tiny from the pet unfolds the row small.
  await viewItem(page, '쪼꼬미').click();
  await expect(page.locator('.desk-row.is-tiny')).toBeVisible();
  const c = await calls(page);
  expect(c.slice(c.lastIndexOf('room-on'))).toEqual(['room-on', 'room-off', 'tiny-on', 'row']);
});

test('The dock draws its own tooltips: above the button, inside the window', async ({ page }) => {
  await setup(page, '#mini=row');
  await expect(page.locator('.row-zone')).toHaveCount(2);
  const button = viewButton(pill(page));
  // No native title doubling the drawn tip.
  await expect(button).not.toHaveAttribute('title', /.*/);
  await expect(pill(page).getByRole('button', { name: '데스크 펫 숨기기' })).not.toHaveAttribute(
    'title',
    /.*/,
  );
  await button.hover();
  const tip = page.locator('.dock-tip');
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText('보기 바꾸기 · 펫, 줄, 바닥, 쪼꼬미');
  const t = await box(tip);
  const b = await box(button);
  expect(t.y + t.height).toBeLessThanOrEqual(b.y);
  expect(t.x + t.width).toBeLessThanOrEqual(1440);
  await page.screenshot({
    path: '.local/dock-tooltip.png',
    clip: { x: 1440 - 420, y: t.y - 12, width: 420, height: 720 - (t.y - 12) },
  });
  // Moving to hide shows its own; pressing hides the tip.
  await pill(page).getByRole('button', { name: '데스크 펫 숨기기' }).hover();
  await expect(tip).toHaveText('숨기기 · 트레이에서 다시 열어요');
  await page.mouse.move(200, 200);
  await expect(tip).toHaveCount(0);
  // Keyboard focus shows it at once; an open menu has none.
  await page.getByRole('button', { name: '도구 막대 옮기기' }).focus();
  await page.keyboard.press('Tab');
  await expect(button).toBeFocused();
  await expect(tip).toHaveText(/보기 바꾸기/);
  await page.keyboard.press('Enter');
  await expect(viewMenu(page)).toBeVisible();
  await expect(tip).toHaveCount(0);
});

test('The pet tools explain themselves with drawn tips too', async ({ page }) => {
  await setup(page, '#mini', { width: PET_SIZE.width, height: PET_SIZE.height });
  await expect(page.locator('.desk-pet')).toBeVisible();
  await page.locator('.dock-pet-anchor').hover();
  const hide = page.locator('.dock-pet-tools').getByRole('button', { name: '데스크 펫 숨기기' });
  await hide.hover();
  const tip = page.locator('.dock-tip');
  await expect(tip).toHaveText('숨기기 · 트레이에서 다시 열어요');
  const t = await box(tip);
  expect(t.x).toBeGreaterThanOrEqual(0);
  expect(t.x + t.width).toBeLessThanOrEqual(PET_SIZE.width);
  expect(t.y).toBeGreaterThanOrEqual(0);
});
