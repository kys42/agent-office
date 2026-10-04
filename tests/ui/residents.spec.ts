import { test, expect, type Page } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';
import type { Snapshot } from '../../src/shared/types';
async function fixture(page: Page, snapshot: Snapshot) {
  await page.addInitScript((s) => {
    const w = window as any;
    w.fixture = s;
    w.office = {
      snapshot: async () => structuredClone(w.fixture),
      detail: async (id: string) =>
        structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
      visit: async () => structuredClone(w.fixture),
      artifacts: async () => [],
      notices: async (receipts: any[], action: string) => {
        w.fixture.notices = w.fixture.notices.map((n: any) => {
          if (!receipts.some((r) => r.id === n.id && r.version === n.version)) return n;
          return {
            ...n,
            ...(action === 'view'
              ? { viewedAt: n.viewedAt ?? Date.now() }
              : action === 'dismiss'
                ? { dismissedAt: Date.now() }
                : action === 'read'
                  ? { seenAt: Date.now() }
                  : { seenAt: null }),
          };
        });
        return structuredClone(w.fixture);
      },
      subscribe: (cb: any) => {
        w.publish = cb;
        return () => {};
      },
    };
  }, snapshot);
}
test('Progress bubbles distinguish opening, keep unread separate, and never fall back after closing', async ({
  page,
}) => {
  const s = demoSnapshot(),
    run = s.sessions[0];
  const now = Date.now();
  s.notices = [
    {
      id: 'old',
      eventId: 'old',
      sessionId: run.id,
      kind: 'reply',
      phase: 'final',
      text: '지난번 최종 결과',
      at: now - 1000,
      receivedAt: now - 1000,
      version: 'old',
      seenAt: null,
      dismissedAt: null,
      resolvedAt: null,
      bootstrap: false,
    },
    {
      id: 'progress',
      eventId: 'progress',
      sessionId: run.id,
      kind: 'progress',
      text: '새 진행 상황을 바로 보여줘요',
      at: now,
      receivedAt: now,
      version: 'v1',
      seenAt: null,
      dismissedAt: null,
      resolvedAt: null,
      bootstrap: false,
    },
  ];
  await fixture(page, s);
  await page.goto('/');
  const station = page.locator(`[data-station-id="${run.id}"]`);
  await expect(station).toHaveAttribute('data-working', 'true');
  await expect(station.locator('.working-beacon')).toContainText('작업 중');
  await expect(page.locator(`[data-station-id="${s.sessions[5].id}"]`)).toHaveAttribute(
    'data-working',
    'false',
  );
  await expect(station.locator('.speech-bubble')).toContainText('새 진행 상황');
  await expect(station.locator('.bubble-exposure')).toHaveText('처음 도착');
  await station.locator('.speech-open').click();
  await expect(station.locator('.bubble-exposure')).toHaveText('열어봄');
  expect(
    await page.evaluate(
      () => (window as any).fixture.notices.find((n: any) => n.id === 'progress').seenAt,
    ),
  ).toBeNull();
  await station.locator('.bubble-dismiss').click();
  await expect(station.locator('.speech-bubble')).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.notices.push({
      ...w.fixture.notices[1],
      id: 'next',
      eventId: 'next',
      version: 'v2',
      text: '다음 진행 소식',
      at: Date.now() + 1,
      receivedAt: Date.now(),
      viewedAt: null,
      dismissedAt: null,
    });
    w.publish(structuredClone(w.fixture));
  });
  await expect(station.locator('.speech-bubble')).toContainText('다음 진행 소식');
  await expect(station.locator('.bubble-exposure')).toHaveText('처음 도착');
});
test('Persona uses one seat, selects individual runs and retains internal history without desk clutter', async ({
  page,
}) => {
  const s = demoSnapshot(),
    base = s.sessions[2];
  const actor = { id: 'openclaw:butler', name: '집사', source: 'fixture' };
  const manual = {
    ...base,
    id: 'manual',
    alias: '',
    title: '오늘의 요청',
    actor,
    status: 'idle' as const,
    officeSeat: 0,
  };
  const cron = {
    ...manual,
    id: 'cron',
    title: '정기 브리핑',
    status: 'work' as const,
    origin: { kind: 'scheduled' as const, source: 'fixture' },
  };
  const helper = {
    ...s.sessions[0],
    id: 'guardian',
    alias: '',
    title: '내부 보조 기록',
    origin: { kind: 'internal' as const, source: 'fixture' },
  };
  s.sessions = [manual, cron, helper];
  s.notices = [];
  await fixture(page, s);
  await page.goto('/');
  await expect(page.locator('.office-pet')).toHaveCount(1);
  await expect(page.locator('.desk-name strong')).toHaveText('집사');
  await expect(page.locator('.background-records summary')).toContainText('1');
  const seat = await page.locator('.office-pet').getAttribute('data-seat');
  await page.locator('.office-pet').click();
  const picker = page.getByLabel('페르소나의 실행 기록');
  await expect(picker).toHaveValue('cron');
  await picker.selectOption('manual');
  await expect(page.locator('.inspector-heading h2')).toHaveText('오늘의 요청');
  await expect(page.locator('.selected-station')).toHaveCount(1);
  expect(await page.locator('.office-pet').getAttribute('data-seat')).toEqual(seat);
  await page.locator('.background-records summary').click();
  await page
    .locator('.background-records')
    .getByRole('button', { name: /내부 보조 기록/ })
    .click();
  await expect(page.locator('.inspector-heading h2')).toHaveText('내부 보조 기록');
  await page.screenshot({ path: '.local/persona-and-history.png', fullPage: true });
});
test('Lounge has independent furniture and pet assets with readable names on narrow screens', async ({
  page,
}) => {
  await page.goto('/?demo');
  await page.getByRole('tab', { name: /대기 라운지/ }).click();
  await expect(page.locator('.rest-lounge')).toBeVisible();
  await expect(page.locator('.rest-lounge [data-asset-id="furniture.bed.v1"]')).toHaveCount(1);
  await expect(page.locator('.rest-lounge [data-asset-id="pet.codex.v1"]')).toHaveCount(1);
  await expect(page.locator('.lounge-project')).toContainText('web-app');
  await expect(page.locator('.lounge-pod h3')).toHaveText('큐브');
  await page.screenshot({
    path: '.local/lounge-residents.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.locator('.rest-pod-open').click();
  await expect(page.locator('.inspector-heading h2')).toHaveText('큐브');
});
