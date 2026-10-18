import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import { exportSession } from '../../server/federation/protocol';
import { importSession } from '../../server/federation/peers';

async function fixture(page: Page, writable = true) {
  const snapshot = demoSnapshot();
  const local = snapshot.sessions.slice(0, 1).map((s) => ({
    ...s,
    id: 'local-test',
    alias: '로컬 동료',
    project: 'local-project',
    area: undefined,
    zone: 'office' as const,
    attachedTo: undefined,
    events: [],
    status: 'ready' as const,
    updatedAt: Date.now(),
  }));
  const peer = {
    officeId: '04e785ca-5d9a-4d61-8703-07234e00479e',
    endpoint: 'https://localhost:4320/',
    fingerprint: 'a'.repeat(64),
    token: 'b'.repeat(64),
    ...(writable ? { sendToken: 'c'.repeat(64) } : {}),
    label: 'MacBook Pro',
    tags: ['LAN'],
    projects: {},
  };
  const remote = ['remote-api', 'remote-web'].map((project, i) =>
    importSession(
      exportSession(
        {
          ...local[0],
          id: `remote-${i}`,
          nativeId: `remote-${i}`,
          alias: '',
          title: `원격 동료 ${i}`,
          project,
          workspace: undefined,
          officeSeat: i,
        },
        [],
      ),
      peer,
      Date.now(),
      false,
    ),
  );
  snapshot.sessions = [...local, ...remote];
  snapshot.notices = [];
  snapshot.noticeStats = { total: 0, unread: 0 } as any;
  const { token: _token, sendToken: _send, ...publicPeer } = peer;
  snapshot.federation = {
    enabled: true,
    peers: [
      {
        ...publicPeer,
        canSend: writable,
        state: 'connected',
        count: 2,
        receivedAt: Date.now(),
        error: null,
      },
    ],
  };
  await page.addInitScript((s) => {
    const w = window as any;
    w.sends = [];
    w.mockSnapshot = s;
    w.office = {
      snapshot: async () => structuredClone(s),
      detail: async (id: string) => ({
        ...structuredClone(s.sessions.find((x: any) => x.id === id)),
        olderEvents: false,
        notices: [],
      }),
      visit: async () => structuredClone(s),
      artifacts: async () => [],
      quotas: async () => [],
      bookmarks: async () => ({ bookmarks: [], total: 0, more: false }),
      subscribe: (fn: any) => {
        w.emitSnapshot = fn;
        return () => {};
      },
      terminalSend: async () => true,
      federation: async () => s.federation,
      terminals: async (ids: string[]) =>
        Object.fromEntries(
          ids.map((id) => [
            id,
            {
              kind: 'codex',
              label: '',
              status: 'queue',
              canSend: true,
              queues: true,
              canFocus: false,
              ...(id.startsWith('remote-office:') ? { remoteOffice: 'MacBook Pro' } : {}),
            },
          ]),
        ),
      send: async (id: string, text: string) => {
        w.sends.push({ id, text });
        return { status: 'sent', message: '테스트 전송 완료' };
      },
      inspectDraft: async () => null,
    };
  }, snapshot);
  await page.goto('/');
  return { snapshot, remote };
}

test('office switcher scopes project zones and roster; remote chat names its destination', async ({
  page,
}) => {
  const { remote } = await fixture(page);
  const rooms = page.getByRole('tablist', { name: '사무실', exact: true });
  await expect(rooms.getByRole('tab', { name: /내 컴퓨터/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.source-list')).toContainText('local-project');
  await expect(page.locator('.source-list')).not.toContainText('remote-api');
  await rooms.getByRole('tab', { name: /MacBook Pro/ }).click();
  await expect(page.locator('.source-list')).toContainText('remote-api');
  await expect(page.locator('.source-list')).toContainText('remote-web');
  await expect(page.locator('.source-list')).not.toContainText('local-project');
  await expect(page.locator('.toolbar-title h1')).toHaveText('MacBook Pro');
  await expect(page.locator('.office-pet').first()).toHaveAttribute('draggable', 'false');
  await expect(page.locator('.office-pet[draggable=true]')).toHaveCount(0);
  // The same selection flow used by native IPC/global search.
  await page.locator('.roster .session-row').first().click();
  const composer = page.locator('.terminal-send-chat');
  await expect(composer).toContainText('MacBook Pro');
  await composer.locator('textarea').fill('합성 전송 테스트');
  await composer.locator('textarea').press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).sends.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).sends[0].id)).toMatch(/^remote-office:/);
  await page.screenshot({ path: '.local/federation-beta/rooms-chat.png', fullPage: true });
  await rooms.getByRole('tab', { name: /내 컴퓨터/ }).click();
  await expect(page.locator('.terminal-send-chat')).toHaveCount(0);
  await expect(page.locator('.source-list')).toContainText('local-project');
  await expect(page.locator('.office-pet').first()).toHaveAttribute('draggable', 'true');
});

test('read-only remote office retains projects without exposing a composer', async ({ page }) => {
  await fixture(page, false);
  await page
    .getByRole('tablist', { name: '사무실', exact: true })
    .getByRole('tab', { name: /MacBook Pro/ })
    .click();
  await page.locator('.roster .session-row').first().click();
  await expect(page.locator('.remote-source')).toContainText('읽기 전용');
  await expect(page.locator('.terminal-send-chat')).toHaveCount(0);
});

test('desktop remote conversation requests tools only on demand and ignores a late old view', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const w = window as any;
    w.detailViews = [];
    w.office.detail = async (id: string, options: any) => {
      w.detailViews.push({ id, view: options?.view });
      const s = structuredClone(w.mockSnapshot.sessions.find((s: any) => s.id === id));
      const result = {
        ...s,
        olderEvents: false,
        notices: [],
        events: [
          { id: 'request', at: 1, kind: 'user', text: '원격 사용자 요청', sourceRef: '' },
          {
            id: 'progress',
            at: 2,
            kind: 'assistant',
            phase: 'commentary',
            text: '원격 진행 메시지',
            sourceRef: '',
          },
          ...(options?.view === 'all'
            ? [{ id: 'tool', at: 3, kind: 'tool', text: '도구 전문', sourceRef: '' }]
            : []),
          {
            id: 'reply',
            at: 4,
            kind: 'assistant',
            phase: 'final',
            text: '원격 최종 답변',
            sourceRef: '',
          },
        ],
      };
      if (options?.view === 'all')
        return new Promise((resolve) => {
          w.releaseTools = () => resolve(result);
        });
      return result;
    };
  });
  await page
    .getByRole('tablist', { name: '사무실', exact: true })
    .getByRole('tab', { name: /MacBook Pro/ })
    .click();
  await page.locator('.roster .session-row').first().click();
  await expect(page.getByText('원격 최종 답변', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).detailViews.at(-1).view)).toBe('conversation');
  await page.getByRole('button', { name: '필터', exact: true }).click();
  const toggle = page.locator('.conversation-tools-toggle input');
  await toggle.check();
  await expect.poll(() => page.evaluate(() => !!(window as any).releaseTools)).toBe(true);
  await toggle.uncheck();
  await expect(page.getByText('원격 최종 답변', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).releaseTools());
  await page.waitForTimeout(100);
  await expect(page.locator('.work-group')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).detailViews.map((x: any) => x.view))).toEqual([
    'conversation',
    'all',
    'conversation',
  ]);
  // A subsequent explicit tool request loads its own data, rather than un-hiding a prefetch.
  await page.evaluate(() => {
    (window as any).releaseTools = null;
  });
  await toggle.check();
  await expect.poll(() => page.evaluate(() => !!(window as any).releaseTools)).toBe(true);
  await page.evaluate(() => (window as any).releaseTools());
  await expect(page.locator('.work-group')).toHaveCount(1);
  await page.locator('.work-group summary').click();
  await expect(page.getByText('도구 전문', { exact: true })).toBeVisible();
});
