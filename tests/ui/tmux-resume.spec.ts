import { test, expect } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
async function setup(page: import('@playwright/test').Page, remote = false) {
  const s = demoSnapshot();
  if (remote)
    s.sessions[0].remote = {
      officeId: 'remote',
      sessionId: 'original',
      label: 'Remote',
      tags: [],
      receivedAt: Date.now(),
      stale: false,
      conversation: true,
      send: false,
    };
  await page.setViewportSize({ width: 380, height: 480 });
  await page.addInitScript((s) => {
    const w = window as any;
    w.fixture = s;
    w.actions = [];
    w.running = false;
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          w.copied = text;
        },
      },
    });
    localStorage.setItem('office:onboarding:v1:live', 'seen');
    w.office = {
      snapshot: async () => structuredClone(w.fixture),
      detail: async (id: string) =>
        structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
      visit: async () => structuredClone(w.fixture),
      artifacts: async () => [],
      terminals: async () => ({}),
      subscribe: (cb: any) => {
        w.publish = cb;
        return () => {};
      },
      card: async () => ({ id: s.sessions[0].id, news: false }),
      onCard: () => () => {},
      cardState: async () => ({
        pinned: false,
        positionRemembered: false,
        target: { id: s.sessions[0].id, news: false },
      }),
      tmuxResume: async (id: string, action: string) => {
        w.actions.push(action);
        if (w.error) throw new Error(w.error);
        if (action === 'start' && !w.cancel) w.running = true;
        return {
          name: 'office-claude-0123456789abcdef',
          cwd: '/projects/example/long-folder-name',
          command: "tmux -L agent-office attach-session -t '=office-claude-0123456789abcdef'",
          running: w.running,
          canOpen: true,
        };
      },
      copyText: async (text: string) => {
        w.copied = text;
      },
    };
  }, s);
  await page.goto('/#card');
}
test('tmux resume explains first, preserves cancelled state, reconnects on reopen and fits a small popup', async ({
  page,
}) => {
  await setup(page);
  await page.getByRole('button', { name: 'tmux로 재개', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'tmux로 재개' });
  await expect(modal.getByText('프로젝트 폴더', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).actions)).toEqual(['status']);
  await page.evaluate(() => {
    (window as any).cancel = true;
  });
  await modal.getByRole('button', { name: 'tmux로 따로 띄우기' }).click();
  await expect(modal.getByText('재개할 준비가 됐어요')).toBeVisible();
  await page.evaluate(() => {
    (window as any).cancel = false;
  });
  await modal.getByRole('button', { name: 'tmux로 따로 띄우기' }).click();
  await expect(modal.getByText('다시 들어갈 tmux가 있어요')).toBeVisible();
  await modal.getByRole('button', { name: '재접속 명령 복사' }).click();
  expect(await page.evaluate(() => (window as any).copied)).toContain('attach-session');
  await modal.getByRole('button', { name: '터미널에서 열기' }).click();
  const box = await modal.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(380);
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await page.getByRole('button', { name: 'tmux로 재개', exact: true }).click();
  await expect(modal.getByText('다시 들어갈 tmux가 있어요')).toBeVisible();
  await expect(modal.getByRole('button', { name: 'tmux로 따로 띄우기' })).toHaveCount(0);
  const footer = await modal.locator('.tmux-resume-actions').boundingBox();
  expect(footer!.y + footer!.height).toBeLessThanOrEqual(480);
  await page.screenshot({ path: '.local/tmux-resume-popup.png', animations: 'disabled' });
});
test('installation errors can be retried and privacy closes the information', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    (window as any).error = 'tmux를 설치해주세요';
  });
  await page.getByRole('button', { name: 'tmux로 재개', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('tmux를 설치해주세요');
  await page.evaluate(() => {
    (window as any).error = '';
  });
  await page.getByRole('button', { name: '다시 확인', exact: true }).click();
  await expect(page.getByText('재개할 준비가 됐어요')).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.preferences.privacy = true;
    w.publish(structuredClone(w.fixture));
  });
  await expect(page.getByRole('dialog', { name: 'tmux로 재개' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'tmux로 재개', exact: true })).toBeDisabled();
});
test('remote colleagues never offer local process creation', async ({ page }) => {
  await setup(page, true);
  await expect(page.locator('.card-actions')).toBeVisible();
  await expect(page.getByRole('button', { name: 'tmux로 재개', exact: true })).toHaveCount(0);
});
