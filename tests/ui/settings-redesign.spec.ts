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
    w.desk = { send: true, answers: { questions: 'unset', permissions: 'unset' } };
    w.listeners = new Set();
    w.changed = (next: any) => {
      Object.assign(w.desk, next);
      for (const cb of w.listeners) cb();
    };
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
      // Desktop-only settings, as the main process keeps them; `w.changed()` is its broadcast.
      terminalSend: async (enable?: boolean) =>
        enable === undefined ? w.desk.send : (w.desk.send = enable),
      answerSettings: async (patch?: Record<string, boolean>) => {
        for (const [k, on] of Object.entries(patch ?? {})) w.desk.answers[k] = on ? 'on' : 'off';
        return { ...w.desk.answers };
      },
      onDesktopSettings: (cb: () => void) => {
        w.listeners.add(cb);
        return () => w.listeners.delete(cb);
      },
      terminals: async (ids: string[]) =>
        Object.fromEntries(ids.map((id) => [id, { kind: 'tmux', status: 'idle', canSend: true }])),
      send: async () => ({ status: 'sent', message: 'Sent' }),
      inspectDraft: async () => null,
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

test('desktop-only settings changed in another window reach the office and the settings', async ({
  page,
}) => {
  await desktop(page);
  await page.addInitScript(() => ((window as any).desk.send = false));
  await page.goto('/?lang=ko');
  // Off at first: the colleague's card offers no reply box.
  await page.locator('.roster .session-row').first().click();
  await expect(page.locator('.terminal-send-hint').first()).toBeVisible();
  await expect(page.locator('.terminal-send-chat')).toHaveCount(0);
  // The settings window turns it on: the reply box appears without reopening anything.
  await page.evaluate(() => (window as any).changed({ send: true }));
  await expect(page.locator('.terminal-send-chat textarea')).toBeVisible();
  // The settings page shows what was saved elsewhere, live.
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  const send = page.getByRole('switch', { name: '터미널로 보내기' });
  const questions = page.getByRole('switch', { name: '질문·플랜에 답하기' });
  await expect(send).toHaveAttribute('aria-checked', 'true');
  await expect(questions).toHaveAttribute('aria-checked', 'false');
  await page.evaluate(() =>
    (window as any).changed({ send: false, answers: { questions: 'on', permissions: 'unset' } }),
  );
  await expect(send).toHaveAttribute('aria-checked', 'false');
  await expect(questions).toHaveAttribute('aria-checked', 'true');
  // A change missed meanwhile still shows when the window comes back into focus.
  await page.evaluate(() => {
    (window as any).desk.send = true;
    window.dispatchEvent(new Event('focus'));
  });
  await expect(send).toHaveAttribute('aria-checked', 'true');
});

test('the settings window follows desktop-only changes and reduced motion live', async ({
  page,
}) => {
  await desktop(page);
  await page.goto('/?lang=ko#settings');
  const send = page.getByRole('switch', { name: '터미널로 보내기' });
  await expect(send).toHaveAttribute('aria-checked', 'true');
  await page.evaluate(() => (window as any).changed({ send: false }));
  await expect(send).toHaveAttribute('aria-checked', 'false');
  const root = page.locator('.settings-window');
  await expect(root).not.toHaveClass(/reduce-motion/);
  await page.getByRole('tab', { name: '모습', exact: true }).click();
  await page.getByRole('switch', { name: '움직임 줄이기' }).click();
  await expect(root).toHaveClass(/reduce-motion/);
  await page.getByRole('switch', { name: '움직임 줄이기' }).click();
  await expect(root).not.toHaveClass(/reduce-motion/);
});

test('categories keep their state, the page remembers the last one, and keys follow the layout', async ({
  page,
}) => {
  await desktop(page);
  await page.goto('/?lang=ko');
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  const tabs = page.getByRole('tablist', { name: '설정 분류' });
  // Every category stays drawn; only the open one is visible.
  await expect(page.locator('.settings-category')).toHaveCount(6);
  await expect(page.locator('.settings-category:not([hidden])')).toHaveCount(1);
  // An unsaved edit in one category survives a trip to another.
  await tabs.getByRole('tab', { name: '공간', exact: true }).click();
  const name = page.getByLabel('리서치 구역 이름');
  await name.evaluate((el: HTMLInputElement) => (el.value = '편집 중'));
  await tabs.getByRole('tab', { name: '기록', exact: true }).click();
  await tabs.getByRole('tab', { name: '공간', exact: true }).click();
  await expect(name).toHaveValue('편집 중');
  // The vertical list moves with Up/Down only.
  await tabs.getByRole('tab', { name: '공간', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: '공간', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ArrowUp');
  await expect(tabs.getByRole('tab', { name: '사무실', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // Leaving the page and coming back opens the category last open.
  await page.getByRole('button', { name: '우리 사무실', exact: true }).click();
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  await expect(tabs.getByRole('tab', { name: '사무실', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // The window's tabs are horizontal: Left/Right move, Up/Down do nothing.
  // (A new load: a hash change alone would keep the big office.)
  await page.goto('/?lang=ko&window#settings');
  const top = page.getByRole('tablist', { name: '설정 분류' });
  await top.getByRole('tab', { name: '일반', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(top.getByRole('tab', { name: '일반', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ArrowRight');
  await expect(top.getByRole('tab', { name: '모습', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(top.getByRole('tab', { name: '모습', exact: true })).toBeFocused();
});

test('a deep link to a section the browser preview does not draw lands on its category', async ({
  page,
}) => {
  // No phone pairing or federation bridge (as in the browser preview): they render nothing.
  await desktop(page);
  await page.goto('/?lang=ko#settings=mobile');
  const tabs = page.getByRole('tablist', { name: '설정 분류' });
  await expect(tabs.getByRole('tab', { name: '연결', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tabpanel')).toBeFocused();
});
