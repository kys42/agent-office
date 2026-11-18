import { test, expect } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import { exportSession } from '../../server/federation/protocol';
import { importSession } from '../../server/federation/peers';

for (const route of ['/', '/#mini=floor'])
  test(`remote summon selects the owning office and terminal: ${route}`, async ({ page }) => {
    const snapshot = demoSnapshot();
    const peer = {
      officeId: '04e785ca-5d9a-4d61-8703-07234e00479e',
      endpoint: 'https://localhost:4320/',
      fingerprint: 'a'.repeat(64),
      token: 'b'.repeat(64),
      sendToken: 'c'.repeat(64),
      label: 'Mac mini',
      tags: [],
      projects: {},
    };
    const original = {
      ...snapshot.sessions[0],
      project: 'remote-project',
      zone: 'office' as const,
      area: undefined,
      attachedTo: undefined,
      status: 'ready' as const,
      updatedAt: Date.now(),
    };
    const remote = importSession(exportSession(original, [original]), peer, Date.now(), false);
    snapshot.sessions = [remote];
    const { token: _token, sendToken: _send, ...publicPeer } = peer;
    snapshot.federation = {
      enabled: true,
      peers: [
        {
          ...publicPeer,
          canSend: true,
          state: 'connected',
          count: 1,
          receivedAt: Date.now(),
          error: null,
        },
      ],
    };
    await page.addInitScript((s) => {
      const w = window as any;
      w.launches = [];
      localStorage.setItem('office:onboarding:v1:live', 'seen');
      w.office = {
        snapshot: async () => s,
        subscribe: () => () => {},
        quotas: async () => [],
        terminals: async () => ({}),
        terminalSend: async () => true,
        federation: async () => s.federation,
        remoteLaunch: async (id: string, action: string, spec: any) => {
          w.launches.push({ id, action, spec });
          return {
            officeId: s.federation!.peers[0].officeId,
            office: 'Mac mini',
            epoch: 'fixture',
            plan: 'fixture',
            project: 'remote-project',
            cwd: '/remote/project',
            hosts: { tmux: true, orca: true },
            status: action === 'start' ? 'started' : 'ready',
          };
        },
      };
    }, snapshot);
    await page.goto(route);
    if (route === '/') await page.getByRole('tab', { name: 'Mac mini', exact: true }).click();
    if (await page.locator('.zone-flag-cloth').count())
      await page.locator('.zone-flag-cloth').first().hover();
    await page
      .getByRole('button', { name: '원격 사무실에 새 에이전트 소환', exact: true })
      .first()
      .click();
    const modal = page.getByRole('dialog', { name: '원격 사무실에 새 에이전트 소환' });
    await modal.getByLabel('에이전트', { exact: true }).selectOption('codex');
    await modal.getByLabel('원격 컴퓨터의 터미널').selectOption('orca');
    await modal.getByLabel('에이전트 이름', { exact: true }).fill('원격 동료');
    await modal.getByLabel('첫 메시지 (선택)', { exact: true }).fill('첫 작업\n두 번째 줄');
    await expect(modal.getByRole('button', { name: '원격에서 소환하기' })).toBeDisabled();
    await modal.getByRole('button', { name: '연결과 이름 확인' }).click();
    await expect(modal.getByText('Mac mini · /remote/project')).toBeVisible();
    await modal.getByRole('button', { name: '원격에서 소환하기' }).click();
    await expect(
      modal.getByText('원격 세션이 시작됐어요. 첫 대화가 감지되면 동료가 나타나요.'),
    ).toBeVisible();
    await expect(modal.getByRole('button', { name: '원격에서 소환하기' })).toHaveCount(0);
    const calls = await page.evaluate(() => (window as any).launches);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      id: remote.id,
      action: 'start',
      spec: {
        provider: 'codex',
        host: 'orca',
        name: '원격 동료',
        initialMessage: '첫 작업\n두 번째 줄',
      },
    });
    await page.screenshot({
      path: '.local/remote-summon-' + (route === '/' ? 'office' : 'floor') + '.png',
    });
  });
