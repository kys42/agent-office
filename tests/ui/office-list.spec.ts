import { test, expect } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';

test('main region switches to a recent list, opens the same card and remembers project grouping', async ({
  page,
}) => {
  await page.goto('/?demo&lang=ko');
  await expect(page.locator('.office-pet')).toHaveCount(6);
  await page.getByRole('button', { name: '리스트', exact: true }).click();
  await expect(page.getByRole('region', { name: '사무실 리스트', exact: true })).toBeVisible();
  await expect(page.locator('.office-pet')).toHaveCount(0);
  await expect(page.locator('.roster')).toHaveCount(0);
  const rows = page.locator('.office-list-row');
  await expect(rows).toHaveCount(6);
  expect(await rows.evaluateAll((xs) => xs.map((x) => x.getAttribute('data-session-id')))).toEqual([
    'demo:0',
    'demo:1',
    'demo:2',
    'demo:3',
    'demo:4',
    'demo:5',
  ]);
  await rows.first().click();
  await expect(page.locator('.card-head h2')).toHaveAttribute('title', '코코');
  await expect(rows.first()).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '업무 카드 닫기' }).click();
  await page.getByLabel('사무실 리스트 정렬').selectOption('project');
  await expect(page.locator('.office-list-group h3')).toHaveCount(5);
  await expect(page.locator('.office-list-group').first().locator('.office-list-row')).toHaveCount(
    2,
  );
  await page.reload();
  await expect(page.getByRole('button', { name: '리스트', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByLabel('사무실 리스트 정렬')).toHaveValue('project');
  await page.getByRole('button', { name: '그래픽', exact: true }).click();
  await expect(page.locator('.office-pet')).toHaveCount(6);
});

test('list filters, exact sidebar project, privacy, empty state and room navigation', async ({
  page,
}) => {
  await page.goto('/?demo&lang=ko');
  await page.getByRole('button', { name: '리스트', exact: true }).click();
  const rows = page.locator('.office-list-row');
  await page.getByLabel('도구 필터', { exact: true }).selectOption('codex');
  await expect(rows).toHaveCount(2);
  await page.getByLabel('도구 필터', { exact: true }).selectOption('all');
  await page.getByLabel('동료 이름 검색').fill('없는동료');
  await expect(rows).toHaveCount(0);
  await expect(page.locator('.office-list-empty')).toBeVisible();
  await page.getByRole('button', { name: '검색어 지우기' }).click();
  const sidebar = page.getByRole('complementary', { name: '주 메뉴' });
  await sidebar.getByRole('button', { name: /api-server/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.locator('.office-list-scope')).toContainText('api-server');
  await page.getByRole('button', { name: '모든 프로젝트 보기' }).click();
  await expect(rows).toHaveCount(6);
  await page.getByLabel('사무실 리스트 정렬').selectOption('project');
  await page.getByLabel('동료 이름 검색').fill('코코');
  await page.getByRole('button', { name: '화면 내용 숨기기' }).click();
  await expect(page.getByLabel('동료 이름 검색')).toHaveValue('');
  await expect(page.locator('.office-list')).not.toContainText('코코');
  await expect(page.locator('.office-list')).not.toContainText('web-app');
  await expect(page.locator('.office-list')).not.toContainText('feat/tiny-office');
  await sidebar.getByRole('button', { name: /대기 라운지/ }).click();
  await expect(page.locator('.office-list')).toHaveCount(0);
  await page.getByRole('tab', { name: /^사무실/ }).click();
  await expect(page.locator('.office-list-row')).toHaveCount(6);
});

test('list follows the selected remote office and retains offline information', async ({
  page,
}) => {
  const fixture = demoSnapshot();
  fixture.preferences.locale = 'ko';
  fixture.federation = {
    enabled: true,
    peers: [
      {
        officeId: 'remote-a',
        label: 'Test Mac',
        state: 'connected',
        tags: [],
        endpoint: 'https://127.0.0.1:4320',
        fingerprint: '0'.repeat(64),
        projects: {},
        canSend: false,
        count: 1,
        receivedAt: Date.now(),
        error: null,
      },
    ],
  };
  const remote = structuredClone(fixture.sessions[0]);
  remote.id = 'peer:remote-a:session';
  remote.alias = '원격 동료';
  remote.remote = {
    officeId: 'remote-a',
    label: 'Test Mac',
    stale: true,
    tags: [],
    sessionId: 'synthetic',
    receivedAt: Date.now(),
    conversation: true,
    send: false,
  };
  fixture.sessions.push(remote);
  await page.addInitScript((s) => {
    (window as any).office = {
      snapshot: async () => structuredClone(s),
      subscribe: () => () => {},
      detail: async (id: string) => s.sessions.find((x) => x.id === id),
      visit: async () => structuredClone(s),
      artifacts: async () => [],
    };
  }, fixture);
  await page.goto('/?lang=ko');
  await page.getByRole('button', { name: '리스트', exact: true }).click();
  await expect(page.locator('.office-list-row')).toHaveCount(6);
  await page.getByRole('tab', { name: 'Test Mac', exact: true }).click();
  await expect(page.locator('.office-list-row')).toHaveCount(1);
  await expect(page.locator('.office-list-row')).toContainText('원격 동료');
  await expect(page.locator('.office-list-row')).toContainText('Test Mac');
  await page.locator('.office-list-row').click();
  await expect(page.locator('.card-head h2')).toHaveAttribute('title', '원격 동료');
});

test('list remains usable in light, dark, narrow windows and English', async ({ page }) => {
  await page.goto('/?demo&lang=ko');
  await page.getByRole('button', { name: '리스트', exact: true }).click();
  await page.getByLabel('사무실 리스트 정렬').selectOption('project');
  await page.screenshot({ path: '.local/office-list-light.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: '.local/office-list-dark.png', fullPage: true });
  await page.setViewportSize({ width: 1050, height: 800 });
  await page.locator('.office-list-row').first().click();
  await expect(page.locator('.office-list-row').last()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1050);
  await page.getByRole('button', { name: '업무 카드 닫기' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.office-list-row').last()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.goto('/?demo&lang=en');
  await expect(page.getByRole('button', { name: 'List', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByLabel('Office list order')).toHaveValue('project');
});
