import { test, expect, type Locator, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import { PET_ROOM_HEIGHT, PET_ROOM_WIDTH, TINY_HEIGHT } from '../../src/shared/dock-geometry';
import { viewButton, viewMenu } from './dock-view';

/**
 * The dock pill's ＋ (새로 부르기 · 데려오기), 보기 opening on hover, 👁 잠깐 숨기기 and ⚙ 설정. `bridge`
 * mocks the desktop main process: it keeps the look, records every dock call (room too), has a
 * settings window, a card window, the launch sheet's calls and the office's bring-back.
 */
async function setup(
  page: Page,
  hash: string,
  {
    width = 1440,
    height = 760,
    privacy = false,
    launch = true,
  }: { width?: number; height?: number; privacy?: boolean; launch?: boolean } = {},
) {
  const s = demoSnapshot();
  s.preferences.privacy = privacy;
  // Two more away colleagues: one more in the lounge, one archived by the person.
  s.sessions.push(
    {
      ...structuredClone(s.sessions[6]),
      id: 'demo:lounge2',
      nativeId: 'demo-lounge2',
      alias: '라운지 리뷰어',
      updatedAt: Date.now() - 6 * 3600_000,
    },
    {
      ...structuredClone(s.sessions[7]),
      id: 'demo:archived2',
      nativeId: 'demo-archived2',
      alias: '보관된 기획자',
      archived: true,
      updatedAt: Date.now() - 2 * 86400_000,
    },
  );
  await page.setViewportSize({ width, height });
  const mode = new URLSearchParams(hash.replace(/^#/, '')).get('mini') ?? 'pet';
  await page.addInitScript(
    ({ s, mode, launch }) => {
      const w = window as any;
      w.fixture = s;
      w.calls = [];
      w.settingsOpened = [];
      w.returned = [];
      w.cards = [];
      w.optionCalls = [];
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string) =>
          structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(w.fixture),
        artifacts: async () => [],
        terminals: async () => ({}),
        subscribe: () => () => {},
        card: async (action: string, target: any) => w.cards.push([action, target.id]),
        window: async (action: string) => w.calls.push(`window:${action}`),
        settings: {
          open: async (section?: string) => w.settingsOpened.push(section ?? null),
          onOpen: () => () => {},
        },
        returnToOffice: async (id: string) => {
          w.returned.push(id);
          if (w.holdReturn) await new Promise((r) => (w.releaseReturn = r));
          const x = w.fixture.sessions.find((y: any) => y.id === id);
          Object.assign(x, { archived: false, returnedAt: Date.now(), zone: 'office' });
          return structuredClone(w.fixture);
        },
      };
      if (launch)
        Object.assign(w.office, {
          launchSupport: async () => ({ supported: true, opens: ['orca', 'tmux'] }),
          launchOptions: async (intent: any) => {
            w.optionCalls.push(intent);
            return {
              destinations: ['orca', 'tmux', 'terminalApp', 'copy'].map((id) => ({
                id,
                probe: { available: true, command: 'claude' },
              })),
              default: 'orca',
              duplicate: { state: 'none' },
            };
          },
          launch: async (request: any) => ({ destination: request.destination, state: 'launched' }),
        });
      const state = { mode, tiny: false };
      w.office.dock = async (action: string) => {
        if (action !== 'solid' && action !== 'through') w.calls.push(action);
        else w.solid = action === 'solid';
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
    { s, mode, launch },
  );
  await page.goto(`/?lang=ko${hash}`);
}
const calls = (page: Page) => page.evaluate(() => (window as any).calls as string[]);
const read = (page: Page, key: string) => page.evaluate((k) => (window as any)[k], key);
/** The window's room is held when more room-ons than room-offs were asked for (in order). */
const roomHeld = async (page: Page) => {
  let held = false;
  for (const c of await calls(page))
    if (c === 'room-on') held = true;
    else if (c === 'room-off') held = false;
  return held;
};
const pill = (page: Page) => page.locator('.dock-pill');
const box = async (l: Locator) => (await l.boundingBox())!;
const plusButton = (scope: Page | Locator) =>
  scope.getByRole('button', { name: '동료 부르기', exact: true });
const plusPopover = (page: Page) => page.getByRole('dialog', { name: '동료 부르기' });

test('＋ opens above the pill with 새로 부르기 and 데려오기; picking a project opens the launch sheet', async ({
  page,
}) => {
  await setup(page, '#mini=row');
  await expect(page.locator('.row-zone').first()).toBeVisible();
  // The final pill: grip, numbers, then 보기 ＋ 👁 ⚙ ✕.
  await expect(pill(page).locator(':scope > button, :scope > .tally-anchor')).toHaveCount(7);
  const names = await pill(page)
    .locator(':scope > button')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(names).toEqual([
    '도구 막대 옮기기',
    '보기 바꾸기',
    '동료 부르기',
    '잠깐 숨기기',
    '설정',
    '데스크 펫 숨기기',
  ]);
  const plus = plusButton(pill(page));
  await expect(plus).toHaveAttribute('aria-haspopup', 'dialog');
  await plus.click();
  const pop = plusPopover(page);
  await expect(pop).toBeVisible();
  await expect(plus).toHaveAttribute('aria-expanded', 'true');
  expect(await calls(page)).toContain('room-on');
  // Above the pill, touching it, inside the window.
  const p = await box(pill(page));
  const m = await box(pop);
  expect(m.y + m.height).toBeLessThanOrEqual(p.y + 3);
  expect(m.y + m.height).toBeGreaterThanOrEqual(p.y - 1);
  expect(m.x).toBeGreaterThanOrEqual(0);
  expect(m.x + m.width).toBeLessThanOrEqual(1440);
  const tabs = pop.getByRole('tab');
  await expect(tabs).toHaveText(['새로 부르기', /데려오기\s*4/]);
  await expect(pop.getByRole('tab', { name: '새로 부르기' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(pop.getByRole('tab', { name: '새로 부르기' })).toBeFocused();
  // 새로 부르기: the office's projects, each opening its launch sheet.
  const projects = pop.getByRole('button', { name: /에서 새로 부르기$/ });
  await expect(projects.first()).toBeVisible();
  expect(await projects.count()).toBeGreaterThan(1);
  await page.waitForTimeout(200);
  await page.screenshot({
    path: '.local/pill-plus-summon.png',
    clip: { x: 1440 - 480, y: m.y - 16, width: 480, height: 760 - (m.y - 16) },
  });
  await projects.first().click();
  await expect(pop).toHaveCount(0);
  const sheet = page.getByRole('dialog', { name: '세션 시작' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: '새 세션', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // The sheet's own room took over before the popover's went: the window never shrank.
  await expect.poll(() => roomHeld(page)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(plus).toBeFocused();
  await expect.poll(() => roomHeld(page)).toBe(false);
  expect(await calls(page)).not.toContain('pet');
});

test('데려오기 lists the lounge and the archive; a row opens the card, bringing back moves it', async ({
  page,
}) => {
  await setup(page, '#mini=row');
  await expect(page.locator('.row-zone').first()).toBeVisible();
  await plusButton(pill(page)).click();
  const pop = plusPopover(page);
  await pop.getByRole('tab', { name: /데려오기/ }).click();
  const rooms = pop.getByRole('group', { name: '데려올 곳' });
  await expect(rooms.getByRole('button')).toHaveText([/라운지\s*2/, /보관\s*2/]);
  await expect(rooms.getByRole('button', { name: /라운지/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const list = pop.getByRole('list', { name: '대기 라운지 리스트' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  // Newest first, each with its project and when it was last active.
  await expect(list.getByRole('listitem').nth(1)).toContainText('라운지 리뷰어');
  await expect(list.getByRole('listitem').first()).toContainText('시간 전');
  const m = await box(pop);
  await page.waitForTimeout(200);
  await page.screenshot({
    path: '.local/pill-plus-bring.png',
    clip: { x: 1440 - 480, y: m.y - 16, width: 480, height: 760 - (m.y - 16) },
  });
  // Search narrows the room.
  await pop.getByRole('textbox', { name: '동료 찾기' }).fill('리뷰어');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await pop.getByRole('textbox', { name: '동료 찾기' }).fill('없는 이름');
  await expect(pop.getByText('찾는 동료가 없어요.')).toBeVisible();
  await pop.getByRole('textbox', { name: '동료 찾기' }).fill('');
  // Bring back by keyboard: the row leaves, the focus lands on the next one.
  const bring = list.getByRole('button', { name: '사무실로 데려오기 · 라운지 리뷰어' });
  await bring.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => read(page, 'returned')).toEqual(['demo:lounge2']);
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list.getByRole('button', { name: /^사무실로 데려오기/ })).toBeFocused();
  await expect(rooms.getByRole('button', { name: /라운지/ })).toHaveText(/라운지\s*1/);
  // The archive: who archived it says so.
  await rooms.getByRole('button', { name: /보관/ }).click();
  const archive = pop.getByRole('list', { name: '보관 공간 리스트' });
  await expect(archive.getByRole('listitem')).toHaveCount(2);
  await expect(archive.getByRole('listitem').first()).toContainText('직접 보관함');
  // A row opens that colleague's card and closes the popover.
  await archive.getByRole('button', { name: '보관된 기획자 업무 카드 열기' }).click();
  await expect(pop).toHaveCount(0);
  await expect.poll(() => read(page, 'cards')).toEqual([['open', 'demo:archived2']]);
  await expect.poll(() => roomHeld(page)).toBe(false);
  // Emptying a room says so.
  await plusButton(pill(page)).click();
  await expect(pop.getByRole('tab', { name: /데려오기/ })).toHaveAttribute('aria-selected', 'true');
  await pop
    .getByRole('group', { name: '데려올 곳' })
    .getByRole('button', { name: /라운지/ })
    .click();
  await pop.getByRole('button', { name: /^사무실로 데려오기/ }).click();
  await expect(pop.getByText('대기 라운지가 비어 있어요.')).toBeVisible();
  await expect(pop.getByRole('tab', { name: /데려오기/ })).toHaveText(/데려오기\s*2/);
});

test('Privacy hides names and projects in 데려오기 and keeps 새로 부르기 closed', async ({
  page,
}) => {
  await setup(page, '#mini=row', { privacy: true });
  await expect(page.locator('.row-zone').first()).toBeVisible();
  await plusButton(pill(page)).click();
  const pop = plusPopover(page);
  await expect(pop.getByText('화면 내용 숨기기 중에는 새로 부를 수 없어요.')).toBeVisible();
  await pop.getByRole('tab', { name: /데려오기/ }).click();
  await expect(pop.getByRole('textbox')).toHaveCount(0);
  const list = pop.getByRole('list', { name: '대기 라운지 리스트' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(pop).not.toContainText('라운지 리뷰어');
  const snapshot = demoSnapshot();
  for (const s of snapshot.sessions) {
    await expect(pop).not.toContainText(s.alias!);
    await expect(pop).not.toContainText(s.project);
  }
  await expect(list.getByRole('listitem').first()).toContainText('프로젝트');
});

test('Esc, a click outside and a mode change close ＋ and give the room back', async ({ page }) => {
  await setup(page, '#mini=row');
  await expect(page.locator('.row-zone').first()).toBeVisible();
  const plus = plusButton(pill(page));
  await plus.click();
  await expect(plusPopover(page)).toBeVisible();
  // Tabs move with the arrows (never paging the row behind).
  await page.keyboard.press('ArrowRight');
  await expect(plusPopover(page).getByRole('tab', { name: /데려오기/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(plusPopover(page)).toHaveCount(0);
  await expect(plus).toBeFocused();
  await expect(page.locator('.desk-row')).toBeVisible();
  expect(await calls(page)).not.toContain('pet');
  expect(await roomHeld(page)).toBe(false);
  await plus.click();
  await expect(plusPopover(page)).toBeVisible();
  await page.mouse.click(300, 200);
  await expect(plusPopover(page)).toHaveCount(0);
  expect(await roomHeld(page)).toBe(false);
  // Open, then the look changes (the main process says so): nothing stays held.
  await plus.click();
  await expect(plusPopover(page)).toBeVisible();
  await page.evaluate(() => (window as any).mode('floor', false));
  await expect(page.locator('.desk-row.desk-floor')).toBeVisible();
  await expect(plusPopover(page)).toHaveCount(0);
  expect(await roomHeld(page)).toBe(false);
});

test('Only one popover at a time: ＋, 보기 and a number’s list close each other', async ({
  page,
}) => {
  await setup(page, '#mini=row');
  await expect(page.locator('.row-zone').first()).toBeVisible();
  await viewButton(pill(page)).click();
  await expect(viewMenu(page)).toBeVisible();
  await plusButton(pill(page)).click();
  await expect(plusPopover(page)).toBeVisible();
  await expect(viewMenu(page)).toHaveCount(0);
  // The room passed from one to the other without a shrink in between.
  expect((await calls(page)).filter((c) => c.startsWith('room'))).toEqual(['room-on']);
  const number = pill(page).locator('.tally-pill > button').first();
  await number.click();
  await expect(page.locator('.tally-list')).toBeVisible();
  await expect(plusPopover(page)).toHaveCount(0);
  // Hovering 보기 while a list is open does not open it.
  await viewButton(pill(page)).hover();
  await page.waitForTimeout(450);
  await expect(viewMenu(page)).toHaveCount(0);
  await viewButton(pill(page)).click();
  await expect(viewMenu(page)).toBeVisible();
  await expect(page.locator('.tally-list')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(viewMenu(page)).toHaveCount(0);
  expect(await roomHeld(page)).toBe(false);
});

test('보기 opens on hover after a moment, stays on the way into the menu, closes after leaving', async ({
  page,
}) => {
  await setup(page, '#mini=row');
  await expect(page.locator('.row-zone').first()).toBeVisible();
  const button = viewButton(pill(page));
  const b = await box(button);
  // Passing over it does not open it.
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(100);
  await page.mouse.move(200, 200);
  await page.waitForTimeout(300);
  await expect(viewMenu(page)).toHaveCount(0);
  // Staying opens it.
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await expect(viewMenu(page)).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  const m = await box(viewMenu(page));
  // It stands on the pill: the pointer goes up into it without closing it.
  expect(m.y + m.height).toBeGreaterThanOrEqual((await box(pill(page))).y - 1);
  await page.mouse.move(b.x + b.width / 2, m.y + m.height - 6, { steps: 6 });
  await page.mouse.move(m.x + m.width / 2, m.y + 20, { steps: 6 });
  await page.waitForTimeout(400);
  await expect(viewMenu(page)).toBeVisible();
  await page.screenshot({
    path: '.local/pill-view-hover.png',
    clip: { x: 1440 - 480, y: m.y - 16, width: 480, height: 760 - (m.y - 16) },
  });
  // Leaving both closes it after a short grace.
  await page.mouse.move(200, 200);
  await page.waitForTimeout(100);
  await expect(viewMenu(page)).toBeVisible();
  await expect(viewMenu(page)).toHaveCount(0);
  expect(await roomHeld(page)).toBe(false);
  // A click on a hover-opened menu keeps it open (it does not toggle it shut).
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await expect(viewMenu(page)).toBeVisible();
  await button.click();
  await page.mouse.move(200, 200);
  await page.waitForTimeout(500);
  await expect(viewMenu(page)).toBeVisible();
  await button.click();
  await expect(viewMenu(page)).toHaveCount(0);
});

test('👁 잠깐 숨기기 hides the desks (click-through), keeps the pill, and brings them back', async ({
  page,
}) => {
  await setup(page, '#mini=row');
  const desk = page.locator('.desk-row [data-station-id]').first();
  await expect(desk).toBeVisible();
  const peek = pill(page).getByRole('button', { name: '잠깐 숨기기', exact: true });
  await peek.hover();
  await expect(page.locator('.dock-tip')).toContainText('잠깐 숨기기');
  await expect(page.locator('.dock-tip')).toContainText('화면 내용 숨기기');
  await peek.click();
  const back = pill(page).getByRole('button', { name: '다시 보기', exact: true });
  await expect(back).toBeVisible();
  await expect(page.locator('.desk-row')).toHaveClass(/is-peeking/);
  await expect(desk).toBeHidden();
  await expect(page.locator('.row-zone-mark').first()).toBeHidden();
  await expect(pill(page)).toBeVisible();
  // Nothing hidden takes the mouse: the window lets clicks through where the desks were.
  const d = await page.locator('.desk-row-track').boundingBox();
  const hit = await page.evaluate(
    ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-solid]'),
    { x: d!.x + 200, y: d!.y + d!.height - 60 },
  );
  expect(hit).toBe(false);
  await page.waitForTimeout(250);
  await page.screenshot({
    path: '.local/pill-peek-row.png',
    clip: { x: 0, y: 360, width: 1440, height: 400 },
  });
  // The numbers still say who waits.
  await expect(pill(page).locator('.tally-pill > button').first()).toBeVisible();
  // It holds across a look change in this window.
  await page.evaluate(() => (window as any).mode('floor', false));
  await expect(page.locator('.desk-row.desk-floor')).toHaveClass(/is-peeking/);
  await back.click();
  await expect(page.locator('.desk-row')).not.toHaveClass(/is-peeking/);
  await expect(page.locator('.desk-row [data-station-id]').first()).toBeVisible();
  await expect(pill(page).getByRole('button', { name: '잠깐 숨기기', exact: true })).toBeVisible();
});

test('⚙ in the pill opens settings; 보기 there no longer lists it', async ({ page }) => {
  await setup(page, '#mini=row');
  await expect(page.locator('.row-zone').first()).toBeVisible();
  const gear = pill(page).getByRole('button', { name: '설정', exact: true });
  await gear.hover();
  await expect(page.locator('.dock-tip')).toHaveText('설정 · 표시, 알림, 연결');
  await gear.click();
  await expect.poll(() => read(page, 'settingsOpened')).toEqual([null]);
  await viewButton(pill(page)).click();
  await expect(viewMenu(page).getByRole('menuitem', { name: '설정' })).toHaveCount(0);
  await expect(viewMenu(page).getByRole('menuitem', { name: '큰 사무실 열기' })).toBeVisible();
});

test('The pet: [보기] [＋] [👁] [✕]; ＋ opens above its tools; 👁 hides the pet, leaving the pill', async ({
  page,
}) => {
  await setup(page, '#mini', { width: PET_ROOM_WIDTH, height: PET_ROOM_HEIGHT });
  await expect(page.locator('.desk-pet')).toBeVisible();
  await page.locator('.dock-pet-anchor').hover();
  const tools = page.locator('.dock-pet-tools');
  await expect(tools.getByRole('button')).toHaveText(['', '', '', '']);
  expect(
    await tools
      .getByRole('button')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))),
  ).toEqual(['보기 바꾸기', '동료 부르기', '잠깐 숨기기', '데스크 펫 숨기기']);
  await plusButton(tools).click();
  const pop = plusPopover(page);
  await expect(pop).toBeVisible();
  // Past its short rise.
  await page.waitForTimeout(200);
  const m = await box(pop);
  const t = await box(tools);
  expect(m.y + m.height).toBeLessThanOrEqual(t.y + 3);
  expect(m.x).toBeGreaterThanOrEqual(0);
  expect(m.x + m.width).toBeLessThanOrEqual(PET_ROOM_WIDTH);
  // Its bubble steps aside behind the popover.
  await expect(page.locator('.dock-pet-anchor')).toHaveClass(/is-listing/);
  await pop.getByRole('tab', { name: /데려오기/ }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: '.local/pet-plus-bring.png' });
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expect(plusButton(tools)).toBeFocused();
  expect(await roomHeld(page)).toBe(false);
  // 👁: the pet and its bubble go; the numbers and the tools stay.
  await tools.getByRole('button', { name: '잠깐 숨기기' }).click();
  await expect(page.locator('.desk-pet')).toBeHidden();
  await expect(page.locator('.dock-pet-speech')).toBeHidden();
  await expect(page.locator('.dock-pet-pillbar')).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(tools.getByRole('button', { name: '다시 보기' })).toBeVisible();
  await page.waitForTimeout(250);
  await page.screenshot({ path: '.local/pet-peek.png' });
  await tools.getByRole('button', { name: '다시 보기' }).click();
  await expect(page.locator('.desk-pet')).toBeVisible();
});

test('Tiny keeps the compact pill with every button, no overflow at 390px', async ({ page }) => {
  await setup(page, '#mini=row&tiny', { width: 390, height: 760 });
  await page.evaluate(() => (window as any).mode('row', true));
  await expect(page.locator('.desk-row.is-tiny')).toBeVisible();
  const p = await box(pill(page));
  expect(p.height).toBeLessThanOrEqual(26);
  expect(p.x).toBeGreaterThanOrEqual(0);
  expect(p.x + p.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await plusButton(pill(page)).click();
  const pop = plusPopover(page);
  await expect(pop).toBeVisible();
  const m = await box(pop);
  expect(m.x).toBeGreaterThanOrEqual(0);
  expect(m.x + m.width).toBeLessThanOrEqual(390);
  await page.waitForTimeout(200);
  await page.screenshot({
    path: '.local/pill-plus-tiny.png',
    clip: { x: 0, y: m.y - 16, width: 390, height: 760 - (m.y - 16) },
  });
});

for (const theme of ['light', 'dark'] as const)
  test(`the tiny strip's ＋ opens above it once the window has grown (${theme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    // The tiny strip's own height, as the dock window is; the room grows it upward (here the
    // test grows the page, and the popover keeps standing on the pill).
    await setup(page, '#mini=row&tiny', { height: TINY_HEIGHT });
    await page.evaluate(() => (window as any).mode('row', true));
    await expect(page.locator('.desk-row.is-tiny')).toBeVisible();
    await plusButton(pill(page)).click();
    await expect.poll(() => roomHeld(page)).toBe(true);
    await page.setViewportSize({ width: 1440, height: TINY_HEIGHT + 560 });
    const pop = plusPopover(page);
    for (const tab of ['새로 부르기', '데려오기'] as const) {
      await pop.getByRole('tab', { name: new RegExp(tab) }).click();
      await page.waitForTimeout(200);
      const m = await box(pop);
      const p = await box(pill(page));
      expect(m.y).toBeGreaterThanOrEqual(0);
      expect(m.y + m.height).toBeLessThanOrEqual(p.y + 3);
      expect(m.y + m.height).toBeGreaterThanOrEqual(p.y - 1);
      await page.screenshot({
        path: `.local/pill-plus-tiny-${tab === '새로 부르기' ? 'summon' : 'bring'}-${theme}.png`,
        clip: { x: 1440 - 480, y: m.y - 16, width: 480, height: p.y + p.height - m.y + 28 },
      });
    }
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect.poll(() => roomHeld(page)).toBe(false);
  });
