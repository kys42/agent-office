import { test, expect } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';

test('Usage dock preserves office, shows demo limits, closes and masks account data', async ({
  page,
}) => {
  await page.goto('/?demo');
  await page.getByRole('button', { name: '사용량 열기' }).click();
  const dock = page.getByRole('complementary', { name: '사용량과 잔여 한도' });
  await expect(dock).toBeVisible();
  await expect(dock).toContainText('73% 남음');
  await expect(page.getByRole('region', { name: '픽셀 사무실' })).toBeVisible();
  await page.getByRole('button', { name: '화면 내용 숨기기' }).click();
  await expect(dock).toContainText('화면 내용 숨기기가 켜져');
  await expect(dock).not.toContainText('% 남음');
  await page.getByRole('button', { name: '사용량 닫기' }).click();
  await expect(dock).not.toBeVisible();
});

test('Focus and incoming paperwork follow normalized observations; details show accumulated cost and actual worktree', async ({
  page,
}) => {
  const snapshot = demoSnapshot();
  snapshot.sessions = snapshot.sessions.slice(0, 1);
  snapshot.notices = [];
  const s = snapshot.sessions[0];
  s.status = 'work';
  s.observedStatus = 'work';
  s.runtime = { phase: 'working', at: Date.now(), evidence: 'observed', reason: 'fixture' };
  s.updatedAt = Date.now();
  s.taskStartedAt = Date.now() - 16 * 60_000;
  s.events = [];
  s.cost = {
    usd: 12.34,
    priced: 8,
    unpriced: 1,
    tokens: 123456,
    since: Date.now() - 86400_000,
    rateVersion: 'fixture',
  };
  s.workingLocation = { path: '/demo/feature-office', at: Date.now(), source: 'tool-workdir' };
  s.workspace = {
    key: 'git:demo',
    name: 'agent-office',
    root: '/demo/main',
    worktree: '/demo/feature-office',
    evidence: 'git-common-dir',
    locationSource: s.workingLocation,
    git: { branch: 'feat/office', commit: 'abcd', state: 'branch', observedAt: Date.now() },
  };
  await page.addInitScript((value) => {
    const w = window as any;
    w.fixture = value;
    w.office = {
      snapshot: async () => structuredClone(w.fixture),
      detail: async () => structuredClone(w.fixture.sessions[0]),
      visit: async () => structuredClone(w.fixture),
      artifacts: async () => [],
      subscribe: (cb: any) => {
        w.publish = cb;
        return () => {};
      },
      notices: async () => structuredClone(w.fixture),
    };
  }, snapshot);
  await page.goto('/');
  await expect(page.locator('.focus-level-2')).toBeVisible();
  await expect(page.locator('.working-beacon')).toContainText('몰입 중');
  await page.evaluate(() => {
    const w = window as any;
    const at = Date.now();
    w.fixture.notices = [
      {
        id: 'older-request',
        sessionId: w.fixture.sessions[0].id,
        eventId: 'req0',
        kind: 'request',
        text: '이전 요청은 앞에 나오면 안 돼요.',
        at: at - 20000,
        receivedAt: at - 20000,
        version: 'v0',
        seenAt: null,
        dismissedAt: null,
        resolvedAt: null,
        bootstrap: false,
      },
      {
        id: 'new-request',
        sessionId: w.fixture.sessions[0].id,
        eventId: 'req1',
        kind: 'request',
        text: '서류에 담긴 새로운 요청입니다.',
        at,
        receivedAt: at,
        version: 'v1',
        seenAt: null,
        dismissedAt: null,
        resolvedAt: null,
        bootstrap: false,
      },
    ];
    w.fixture.sessions[0].taskStartedAt = at;
    w.publish(structuredClone(w.fixture));
  });
  await expect(page.locator('.arrival-burst')).toBeVisible();
  await expect(page.locator('.speech-bubble')).toContainText('서류에 담긴 새로운 요청');
  await expect(page.locator('.focus-level-2')).toHaveCount(0);
  await page.locator('.office-pet').click();
  await page.getByRole('tab', { name: '작업 정보' }).click();
  await expect(page.locator('.cost-card')).toContainText('$12.34');
  await expect(page.locator('.cost-card')).toContainText('실제 청구액이 아니에요');
  await expect(page.locator('.working-location')).toContainText('/demo/feature-office');
  await expect(page.locator('.desk-branch')).toContainText('feat/office');
});

test('Small screen usage controls and panel remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?demo');
  await page.getByRole('button', { name: '사용량 열기' }).click();
  await expect(page.getByRole('complementary', { name: '사용량과 잔여 한도' })).toBeVisible();
  await expect(page.getByRole('button', { name: '사용량 닫기' })).toBeInViewport();
});
