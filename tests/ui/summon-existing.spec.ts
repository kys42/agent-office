import { test, expect } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

// The project "+" offers this project's lounge/archive colleagues next to summoning a new one.
// Desktop APIs are stubbed: no tmux, no Orca, no real records.
async function setup(page: import('@playwright/test').Page, route: string, orca = true) {
  const s = demoSnapshot();
  const project = { cwd: '/projects/example', project: 'example', workspace: undefined };
  Object.assign(s.sessions[0], project);
  Object.assign(s.sessions[6], project, { alias: '라운지 리뷰어', provider: 'claude' });
  Object.assign(s.sessions[7], project, {
    alias: '보관된 기획자',
    provider: 'codex',
    archived: true,
    updatedAt: Date.now() - 2 * 86400_000,
  });
  s.sessions.push({
    ...structuredClone(s.sessions[7]),
    id: 'demo:claw',
    nativeId: 'demo-claw',
    alias: '오픈클로 동료',
    provider: 'openclaw',
    updatedAt: Date.now() - 3 * 86400_000,
  });
  await page.addInitScript(
    ({ s, orca }) => {
      const w = window as any;
      w.fixture = s;
      w.actions = [];
      w.returned = [];
      localStorage.setItem('office:onboarding:v1:live', 'seen');
      const info = (running: boolean) => ({
        name: 'office-claude-0123456789abcdef',
        cwd: '/projects/example',
        command: 'tmux attach',
        running,
        canOpen: true,
      });
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string) =>
          structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(w.fixture),
        returnToOffice: async (id: string) => {
          w.returned.push(id);
          const x = w.fixture.sessions.find((y: any) => y.id === id);
          Object.assign(x, { archived: false, returnedAt: Date.now(), zone: 'office' });
          return structuredClone(w.fixture);
        },
        artifacts: async () => [],
        terminals: async () => ({}),
        subscribe: (cb: any) => {
          w.publish = cb;
          return () => {};
        },
        tmuxSummon: async () => ({ ...info(false), name: 'office-claude-fresh' }),
        tmuxResume: async (id: string, action: string) => {
          w.actions.push('tmux:' + action + ':' + id);
          if (action === 'start' && !w.cancel) w['running_' + id] = true;
          return info(!!w['running_' + id]);
        },
        orcaLaunch: async (id: string, action: string) => {
          w.actions.push('orca:' + action + ':' + id);
          if (!orca) return { available: false };
          return action === 'start'
            ? { available: true, launched: true, message: 'Orca 새 탭에서 열었어요' }
            : { available: true, command: 'claude --resume x' };
        },
        jump: async () => ({ action: 'focused', text: 'Orca' }),
      };
    },
    { s, orca },
  );
  await page.goto(route);
}

async function openSummon(page: import('@playwright/test').Page) {
  if (await page.locator('.zone-flag-cloth').count())
    await page.locator('.zone-flag-cloth').first().hover();
  await page.getByRole('button', { name: '새 에이전트 소환', exact: true }).first().click();
  const modal = page.getByRole('dialog', { name: '새 에이전트 소환' });
  await modal.getByText('기존 동료 불러오기', { exact: true }).click();
  return modal;
}

test('lists lounge and archive colleagues, resumes in tmux only after confirmation, then brings back', async ({
  page,
}) => {
  await setup(page, '/');
  const modal = await openSummon(page);
  const list = modal.getByRole('list', { name: '기존 동료 불러오기' });
  const rows = list.getByRole('button');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('라운지 리뷰어');
  await expect(rows.nth(0)).toContainText('Claude');
  await expect(rows.nth(0)).toContainText('대기');
  await expect(rows.nth(1)).toContainText('보관된 기획자');
  await expect(rows.nth(1)).toContainText('보관');
  await expect(rows.nth(2)).toBeDisabled();
  await expect(rows.nth(2)).toContainText('Claude·Codex 대화만 이어갈 수 있어요');

  await rows.nth(1).click();
  const chosen = modal.getByRole('region', { name: '불러올 동료' });
  await expect(chosen.getByRole('button', { name: 'Orca 새 탭으로 불러오기' })).toBeVisible();
  // A cancelled native confirmation leaves the colleague where it was.
  await page.evaluate(() => ((window as any).cancel = true));
  await chosen.getByRole('button', { name: 'tmux로 불러오기' }).click();
  await expect(chosen.getByRole('button', { name: 'tmux로 불러오기' })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).returned)).toEqual([]);
  await page.evaluate(() => ((window as any).cancel = false));
  await chosen.getByRole('button', { name: 'tmux로 불러오기' }).click();
  await expect(chosen.getByRole('button', { name: '터미널에서 열기' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).returned)).toEqual(['demo:7']);
  // Back in the office: no longer offered, the picked panel stays.
  await expect(rows).toHaveCount(2);
  await expect(chosen).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).actions.filter((x: string) => x.startsWith('tmux:start')),
    ),
  ).toEqual(['tmux:start:demo:7', 'tmux:start:demo:7']);
  await page.screenshot({ path: '.local/summon-existing-office.png', animations: 'disabled' });
});

test('Orca launch brings the lounge colleague back and closes the sheet', async ({ page }) => {
  await setup(page, '/#mini=floor');
  const modal = await openSummon(page);
  await modal.getByRole('button', { name: /라운지 리뷰어/ }).click();
  await modal.getByRole('button', { name: 'Orca 새 탭으로 불러오기' }).click();
  await expect(modal).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).returned)).toEqual(['demo:6']);
});

test('without Orca only tmux is offered', async ({ page }) => {
  await setup(page, '/', false);
  const modal = await openSummon(page);
  await modal.getByRole('button', { name: /라운지 리뷰어/ }).click();
  await expect(modal.getByRole('button', { name: 'tmux로 불러오기' })).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Orca 새 탭으로 불러오기' })).toHaveCount(0);
});
