import { test, expect, type Page } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';

// Settings in categories (#87): the big office's page lists them on the left, the settings
// window (`#settings`) shows them as top tabs. Same component, same controls, same deep links.
const CATEGORIES = ['일반', '모습', '사무실', '공간', '연결', '기록'];

/** A desktop-like office: preferences save, the desktop-only switches and the window API. */
async function desktop(page: Page) {
  const s = demoSnapshot();
  s.preferences.locale = 'ko';
  s.preferences.zoneRules = [{ id: 'r1', name: '리서치', match: 'branch', value: 'research/*' }];
  await page.addInitScript((s) => {
    const w = window as any;
    w.opened = [];
    w.office = {
      snapshot: async () => structuredClone(s),
      subscribe: () => () => {},
      artifacts: async () => [],
      visit: async () => structuredClone(s),
      detail: async (id: string) => structuredClone(s.sessions.find((x: any) => x.id === id)),
      preferences: async (p: any) => {
        s.preferences = { ...s.preferences, ...p };
        return structuredClone(s);
      },
      terminalSend: async (enable?: boolean) => enable ?? true,
      answerSettings: async () => ({ questions: 'unset', permissions: 'unset' }),
      settings: {
        open: async (section?: string) => void w.opened.push(section ?? null),
        onOpen: () => () => {},
      },
    };
  }, s);
}

test('the page lists categories on the left and each category shows its controls', async ({
  page,
}) => {
  await desktop(page);
  await page.goto('/?lang=ko');
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  const tabs = page.getByRole('tablist', { name: '설정 분류' });
  await expect(tabs).toHaveAttribute('aria-orientation', 'vertical');
  await expect(tabs.getByRole('tab')).toHaveText(CATEGORIES);
  // The list sits left of the content on a wide window.
  const list = (await tabs.boundingBox())!;
  const panel = (await page.getByRole('tabpanel').boundingBox())!;
  expect(list.x + list.width).toBeLessThanOrEqual(panel.x);
  expect(Math.abs(list.y - panel.y)).toBeLessThan(40);

  const controls: Record<string, (string | RegExp)[]> = {
    일반: ['언어', '수집 일시정지', '화면 내용 숨기기', '터미널로 보내기', '질문·플랜에 답하기'],
    모습: ['Claude 캐릭터 꾸미기', '움직임 줄이기'],
    사무실: ['보관 공간 자동 이동', '말풍선 유지 시간', '퇴근까지 시간', '보관까지 기간'],
    공간: ['리서치 구역 이름'],
    연결: ['연결 새로고침', 'Claude Code 수집'],
    기록: ['도구별 수집할 세션 수'],
  };
  for (const name of CATEGORIES) {
    await tabs.getByRole('tab', { name, exact: true }).click();
    await expect(tabs.getByRole('tab', { name, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.locator('.settings-panel-head h2')).toHaveText(name);
    for (const label of controls[name])
      await expect(page.getByRole('tabpanel').getByLabel(label).first()).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: '기록에서 제외할 프로젝트' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'MCP로 기억을 꺼내요' })).toBeVisible();

  // Arrow keys walk the list (it is a tablist), wrapping at the ends.
  await tabs.getByRole('tab', { name: '기록' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(tabs.getByRole('tab', { name: '일반' })).toBeFocused();
  await expect(tabs.getByRole('tab', { name: '일반' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(tabs.getByRole('tab', { name: '기록' })).toHaveAttribute('aria-selected', 'true');

  // A setting changed in one category is kept when coming back.
  await tabs.getByRole('tab', { name: '모습' }).click();
  await page.getByRole('switch', { name: '움직임 줄이기' }).click();
  await tabs.getByRole('tab', { name: '공간' }).click();
  await tabs.getByRole('tab', { name: '모습' }).click();
  await expect(page.getByRole('switch', { name: '움직임 줄이기' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.screenshot({ path: '.local/settings-page-light.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await tabs.getByRole('tab', { name: '사무실' }).click();
  await page.screenshot({ path: '.local/settings-page-dark.png' });
});

test('guide shortcuts and the office gear open the matching category and control', async ({
  page,
}) => {
  await desktop(page);
  await page.goto('/?lang=ko');
  const menu = page.getByRole('button', { name: '사무실 사용 가이드', exact: true });
  const tabs = page.getByRole('tablist', { name: '설정 분류' });
  for (const [action, category, section] of [
    ['캐릭터 고르기', '모습', 'appearance'],
    ['사무실 설정하기', '사무실', 'office'],
    ['설정 열기', '일반', 'privacy'],
    ['답장 설정 보기', '일반', 'terminal'],
  ]) {
    await menu.click();
    await page.getByRole('dialog').getByRole('button', { name: action, exact: true }).click();
    await expect(tabs.getByRole('tab', { name: category, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const target = page.locator(`[data-guide-section="${section}"]`);
    await expect(target).toBeInViewport();
    await expect(target).toBeFocused();
  }
  await page.getByRole('button', { name: '우리 사무실', exact: true }).click();
  await page.getByRole('button', { name: '사무실 설정 열기' }).click();
  await expect(tabs.getByRole('tab', { name: '사무실', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('[data-guide-section="office"]')).toBeFocused();
});

test('the settings window shows top tabs, opens at a section and fits a popup width', async ({
  page,
}) => {
  await desktop(page);
  await page.setViewportSize({ width: 640, height: 720 });
  await page.goto('/?lang=ko#settings');
  await expect(page.locator('.settings-window-bar')).toHaveText('설정');
  await expect(page).toHaveTitle('설정');
  // No office around it: only the settings.
  await expect(page.locator('.app')).toHaveCount(0);
  const tabs = page.getByRole('tablist', { name: '설정 분류' });
  await expect(tabs).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(tabs.getByRole('tab')).toHaveText(CATEGORIES);
  const boxes = await tabs
    .getByRole('tab')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  expect(new Set(boxes.map(Math.round)).size).toBe(1);
  await expect(page.getByLabel('언어')).toBeVisible();
  for (const name of CATEGORIES) {
    await tabs.getByRole('tab', { name, exact: true }).click();
    await expect(page.locator('.settings-panel-head h2')).toHaveText(name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      640,
    );
  }
  // A change here saves through the same preferences as every other window.
  await tabs.getByRole('tab', { name: '기록' }).click();
  await page.getByLabel('도구별 수집할 세션 수').selectOption('300');
  await expect(page.getByLabel('도구별 수집할 세션 수')).toHaveValue('300');
  await tabs.getByRole('tab', { name: '일반' }).click();
  await page.screenshot({ path: '.local/settings-popup.png' });

  // A section in the hash (what the desktop loads, or a later hash change) opens it.
  await page.evaluate(() => (location.hash = '#settings=office'));
  await expect(page.getByRole('tab', { name: '사무실', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('[data-guide-section="office"]')).toBeFocused();
  // A narrow window still keeps every tab reachable.
  await page.setViewportSize({ width: 520, height: 640 });
  await page.getByRole('tab', { name: '기록', exact: true }).click();
  await expect(page.getByLabel('도구별 수집할 세션 수')).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: '.local/settings-popup-dark-narrow.png' });
});

test('the palette opens the settings window on the desktop', async ({ page }) => {
  await desktop(page);
  await page.goto('/?lang=ko');
  await expect(page.locator('.office-pet').first()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: '명령 팔레트' });
  await page.keyboard.type('설정 창');
  await palette.getByRole('option', { name: /설정 창 열기/ }).click();
  expect(await page.evaluate(() => (window as any).opened)).toEqual([null]);
});

test('the page switches to top tabs at phone width without overflowing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?demo&lang=ko');
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  const tabs = page.getByRole('tablist', { name: '설정 분류' });
  const tops = await tabs
    .getByRole('tab')
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  await tabs.getByRole('tab', { name: '연결', exact: true }).click();
  await expect(page.locator('.connector-card')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
