import { test, expect } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';
import { runtimeObservation } from '../../src/shared/runtime';

test('main region switches to a recent list, opens the same card and remembers project grouping', async ({
  page,
}) => {
  await page.goto('/?demo&lang=ko');
  await expect(page.locator('.office-pet')).toHaveCount(6);
  const originalPortrait = await page
    .getByRole('button', { name: '코코, 일하는 중', exact: true })
    .locator('.sprite-window')
    .getAttribute('data-asset-id');
  const originalProjectColor = await page
    .locator('.sidebar button[title="agent-office"] .source-dot')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.getByRole('button', { name: '리스트', exact: true }).click();
  await expect(page.getByRole('region', { name: '사무실 리스트', exact: true })).toBeVisible();
  await expect(page.locator('.office-pet')).toHaveCount(0);
  await expect(page.locator('.roster')).toHaveCount(0);
  const rows = page.locator('.office-list-row');
  await expect(rows).toHaveCount(6);
  await expect(rows.first().locator('.sprite-window')).toHaveAttribute(
    'data-asset-id',
    originalPortrait!,
  );
  expect(
    await rows
      .first()
      .locator('.office-list-project-name > svg')
      .evaluate((el) => getComputedStyle(el).color),
  ).toBe(originalProjectColor);
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
  expect(
    await page
      .locator('.office-list-group h3 > svg')
      .first()
      .evaluate((el) => getComputedStyle(el).color),
  ).toBe(originalProjectColor);
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
  await expect(page.locator('.office-list-offline')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.office-list-offline')).toBeVisible();
  await expect(page.locator('.office-list-offline')).toHaveText('연결 끊김');
  await page.setViewportSize({ width: 1050, height: 800 });
  await page.locator('.office-list-row').click();
  await expect(page.locator('.card-head h2')).toHaveAttribute('title', '원격 동료');
  await expect(page.locator('.office-list-offline')).toBeVisible();
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

test('helpers keep their role, parent, own news and calls; forks and persona runs stay distinct', async ({
  page,
}) => {
  const fixture = demoSnapshot();
  fixture.preferences.locale = 'ko';
  const main = fixture.sessions[0];
  main.alias = '메인 작업';
  const helper = structuredClone(main);
  Object.assign(helper, {
    id: 'helper:one',
    nativeId: 'helper-one',
    alias: '품질 검토',
    status: 'call',
    observedStatus: 'call',
    relation: {
      kind: 'subagent',
      parentNativeId: main.nativeId,
      role: 'reviewer',
      source: 'fixture',
    },
    runtime: runtimeObservation('call', Date.now(), 'fixture needs input'),
  });
  const orphan = structuredClone(main);
  Object.assign(orphan, {
    id: 'helper:unknown',
    nativeId: 'helper-unknown',
    alias: '경로 조사',
    relation: {
      kind: 'child',
      parentNativeId: 'not-collected',
      role: 'explorer',
      source: 'fixture',
    },
  });
  const fork = structuredClone(main);
  Object.assign(fork, {
    id: 'fork:one',
    nativeId: 'fork-one',
    alias: '분기 대화',
    relation: { kind: 'fork', parentNativeId: main.nativeId, source: 'fixture' },
  });
  fixture.sessions[5].alias = 'guardian 검토'; // A title is never evidence of being a helper.
  const persona = fixture.sessions[2];
  persona.actor = { id: 'openclaw:persona', name: '집사', source: 'fixture' };
  const run = structuredClone(persona);
  Object.assign(run, { id: 'persona:two', nativeId: 'persona-two' });
  fixture.sessions.push(helper, orphan, fork, run);
  fixture.notices = [
    {
      id: 'helper-call',
      sessionId: helper.id,
      eventId: 'call',
      kind: 'attention',
      text: '검토 결과 확인이 필요해요',
      at: Date.now(),
      receivedAt: Date.now(),
      version: '1',
      seenAt: null,
      dismissedAt: null,
      resolvedAt: null,
      bootstrap: false,
    },
  ];
  await page.addInitScript((s) => {
    (window as any).office = {
      snapshot: async () => structuredClone(s),
      subscribe: () => () => {},
      preferences: async (patch: object) => {
        Object.assign(s.preferences, patch);
        return structuredClone(s);
      },
      detail: async (id: string) => structuredClone(s.sessions.find((x) => x.id === id)),
      visit: async () => structuredClone(s),
      artifacts: async () => [],
    };
  }, fixture);
  await page.goto('/?lang=ko');
  await page.getByRole('button', { name: '리스트', exact: true }).click();
  const child = page.locator('.office-list-row[data-session-id="helper:one"]');
  const parent = page.locator(`.office-list-row[data-session-id="${main.id}"]`);
  await expect(child).toHaveClass(/is-helper/);
  await expect(child).toContainText('reviewer · 품질 검토');
  await expect(child.locator('.office-list-lineage')).toHaveText('메인 작업의 보조');
  await expect(child.locator('.office-list-copy em')).toHaveText('1');
  await expect(parent.locator('.helpers-calling')).toHaveText('메인 · 보조 1명 · 불러요 1명');
  await expect(parent.locator('.office-list-helper-news')).toHaveText('보조 소식 1건');
  await expect(parent.locator('.office-list-copy em')).toHaveCount(0);
  await expect(page.locator('.office-list-row[data-session-id="helper:unknown"]')).toHaveClass(
    /is-helper/,
  );
  await expect(
    page.locator('.office-list-row[data-session-id="helper:unknown"] .office-list-lineage'),
  ).toHaveCount(0);
  await expect(page.locator('.office-list-row[data-session-id="fork:one"]')).not.toHaveClass(
    /is-helper/,
  );
  await expect(
    page.locator('.office-list-row[data-session-id="fork:one"] .office-list-lineage'),
  ).toHaveText('메인 작업에서 분기');
  await expect(
    page.locator('.office-list-row').filter({ hasText: 'guardian 검토' }),
  ).not.toHaveClass(/is-helper/);
  await expect(page.locator('.office-list-row').filter({ hasText: '집사' })).toContainText(
    '실행 2개',
  );
  await page.getByLabel('사무실 리스트 정렬').selectOption('project');
  await page.screenshot({ path: '.local/office-list-relations.png', fullPage: true });
  await page.setViewportSize({ width: 1050, height: 800 });
  await child.click();
  await expect(page.locator('.card-head h2')).toHaveAttribute('title', '품질 검토');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1050);
  await page.getByRole('button', { name: '업무 카드 닫기' }).click();
  await page.getByRole('button', { name: '화면 내용 숨기기' }).click();
  await expect(page.locator('.office-list')).not.toContainText('reviewer');
  await expect(page.locator('.office-list')).not.toContainText('explorer');
  await expect(page.locator('.office-list')).not.toContainText('메인 작업');
  await expect(child.locator('.office-list-lineage')).toHaveText('부모 동료의 보조');
  await page.setViewportSize({ width: 390, height: 844 });
  await child.scrollIntoViewIfNeeded();
  await expect(child.locator('.helper-kind')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
