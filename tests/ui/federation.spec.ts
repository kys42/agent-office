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

test('remote Codex route names this computer and offers a read-only target refresh', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const w = window as any;
    w.targetChecks = 0;
    w.office.terminals = async (ids: string[]) => {
      w.targetChecks++;
      return Object.fromEntries(
        ids.map((id) => [
          id,
          {
            kind: 'codex',
            desktop: true,
            codexRemote: true,
            label: '',
            status: 'desktop',
            canSend: false,
            canFocus: false,
            remoteOffice: 'MacBook Pro',
          },
        ]),
      );
    };
  });
  await page
    .getByRole('tablist', { name: '사무실', exact: true })
    .getByRole('tab', { name: /MacBook Pro/ })
    .click();
  await page.locator('.roster .session-row').first().click();
  const composer = page.locator('.terminal-send-chat');
  await expect(composer).toContainText('이 컴퓨터의 Codex 원격 연결');
  await expect(composer).toContainText('Codex에서 해당 원격 대화를 열고 다시 확인하세요');
  await composer.locator('textarea').fill('keep my draft');
  const before = await page.evaluate(() => (window as any).targetChecks);
  await composer.getByRole('button', { name: '전송 대상 다시 확인' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).targetChecks))
    .toBeGreaterThan(before);
  await expect(composer.locator('textarea')).toHaveValue('keep my draft');
  expect(await page.evaluate(() => (window as any).sends.length)).toBe(0);
  await page.evaluate(() => {
    (window as any).office.terminals = async (ids: string[]) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          {
            kind: 'tmux',
            label: '',
            status: 'unavailable',
            canSend: false,
            canFocus: false,
            remoteOffice: 'MacBook Pro',
          },
        ]),
      );
  });
  await composer.getByRole('button', { name: '전송 대상 다시 확인' }).click();
  await expect(composer).not.toContainText('Codex에서 해당 원격 대화');
});
