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
      w.canOpen = true;
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => {
            w.copied = text;
          },
        },
      });
      localStorage.setItem('office:onboarding:v1:live', 'seen');
      const info = (running: boolean) => ({
        name: 'office-claude-0123456789abcdef',
        cwd: '/projects/example',
        command: 'tmux attach -t office-claude',
        running,
        canOpen: w.canOpen,
        connections: w.connections ?? [],
      });
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string) =>
          structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(w.fixture),
        returnToOffice: async (id: string) => {
          w.returned.push(id);
          if (w.returnFails) {
            w.returnFails--;
            throw new Error('저장하지 못했어요');
          }
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
          if (w.tmuxError) throw new Error(w.tmuxError);
          if (action === 'start' && !w.cancel) w['running_' + id] = true;
          return {
            ...info(!!w['running_' + id]),
            ...(action === 'status' && w.tmuxDuplicate ? { duplicate: w.tmuxDuplicate } : {}),
          };
        },
        orcaLaunch: async (id: string, action: string) => {
          w.actions.push('orca:' + action + ':' + id);
          if (action === 'focus') return { available: true, message: 'Orca 탭으로 이동했어요' };
          if (!orca) return { available: false, duplicate: w.orcaDuplicate };
          return action === 'start'
            ? { available: true, launched: true, message: 'Orca 새 탭에서 열었어요' }
            : { available: true, command: 'claude --resume x', duplicate: w.orcaDuplicate };
        },
        jump: async () =>
          w.jumpAction === 'copy'
            ? { action: 'copy', text: 'claude --resume x' }
            : { action: 'focused', text: 'Orca' },
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

test('a failed tmux check still offers Orca', async ({ page }) => {
  await setup(page, '/');
  await page.evaluate(() => ((window as any).tmuxError = 'tmux를 설치해주세요'));
  const modal = await openSummon(page);
  await modal.getByRole('button', { name: /라운지 리뷰어/ }).click();
  await expect(modal.getByRole('alert')).toHaveText('tmux를 설치해주세요');
  await expect(modal.getByRole('button', { name: 'tmux로 불러오기' })).toHaveCount(0);
  await modal.getByRole('button', { name: 'Orca 새 탭으로 불러오기' }).click();
  await expect(modal).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).returned)).toEqual(['demo:6']);
});

test('without a Terminal to open (Linux) the attach command can be copied', async ({ page }) => {
  await setup(page, '/', false);
  await page.evaluate(() => ((window as any).canOpen = false));
  const modal = await openSummon(page);
  await modal.getByRole('button', { name: /라운지 리뷰어/ }).click();
  await modal.getByRole('button', { name: 'tmux로 불러오기' }).click();
  await expect(modal.getByRole('button', { name: '터미널에서 열기' })).toHaveCount(0);
  await modal.getByRole('button', { name: '재접속 명령 복사' }).click();
  expect(await page.evaluate(() => (window as any).copied)).toBe('tmux attach -t office-claude');
  expect(await page.evaluate(() => (window as any).returned)).toEqual(['demo:6']);
});

test('moving to a live terminal brings back only when one was really focused', async ({ page }) => {
  await setup(page, '/', false);
  await page.evaluate(() => {
    const w = window as any;
    w.connections = [{ id: 'demo:6', name: '라운지 리뷰어', label: 'Orca' }];
    w.jumpAction = 'copy';
  });
  const modal = await openSummon(page);
  await modal.getByRole('button', { name: /라운지 리뷰어/ }).click();
  const move = modal.getByRole('button', { name: '기존 세션으로 이동 · Orca' });
  await move.click();
  await expect(move).toBeEnabled();
  expect(await page.evaluate(() => (window as any).copied)).toBe('claude --resume x');
  expect(await page.evaluate(() => (window as any).returned)).toEqual([]);
  await page.evaluate(() => ((window as any).jumpAction = 'focused'));
  await move.click();
  await expect.poll(() => page.evaluate(() => (window as any).returned)).toEqual(['demo:6']);
});

test('without tmux, a conversation already running in Orca offers a jump, not a new tab', async ({
  page,
}) => {
  await setup(page, '/');
  await page.evaluate(() => {
    const w = window as any;
    w.tmuxError = 'tmux를 설치해주세요';
    w.orcaDuplicate = { state: 'running', where: 'orca' };
  });
  const modal = await openSummon(page);
  await modal.getByRole('button', { name: /라운지 리뷰어/ }).click();
  await expect(
    modal.getByText('이 대화는 이미 Orca에서 실행 중이에요', { exact: false }),
  ).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Orca 새 탭으로 불러오기' })).toHaveCount(0);
  await page.evaluate(() => ((window as any).jumpAction = 'copy'));
  await modal.getByRole('button', { name: '터미널로 이동' }).click();
  await expect(modal.getByRole('button', { name: '터미널로 이동' })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).returned)).toEqual([]);
  await page.evaluate(() => ((window as any).jumpAction = 'focused'));
  await modal.getByRole('button', { name: '터미널로 이동' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).returned)).toEqual(['demo:6']);
});

test('an open Orca tab is focused through Orca, and the own tmux pane does not hide Orca', async ({
  page,
}) => {
  await setup(page, '/');
  await page.evaluate(() => {
    const w = window as any;
    w['running_demo:6'] = true;
    w.tmuxDuplicate = { state: 'open', where: 'orca' };
  });
  const modal = await openSummon(page);
  await modal.getByRole('button', { name: /라운지 리뷰어/ }).click();
  await expect(modal.getByText('/new·/clear', { exact: false })).toBeVisible();
  await expect(modal.getByRole('button', { name: '그래도 Orca에서 새로 띄우기' })).toBeVisible();
  await modal.getByRole('button', { name: '그 탭으로 이동' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).returned)).toEqual(['demo:6']);
  expect(await page.evaluate(() => (window as any).actions)).toContain('orca:focus:demo:6');
});

test('a failed bring-back is tried again on the next open terminal', async ({ page }) => {
  await setup(page, '/', false);
  await page.evaluate(() => ((window as any).returnFails = 1));
  const modal = await openSummon(page);
  await modal.getByRole('button', { name: /라운지 리뷰어/ }).click();
  await modal.getByRole('button', { name: 'tmux로 불러오기' }).click();
  const open = modal.getByRole('button', { name: '터미널에서 열기' });
  await expect(open).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).returned)).toEqual(['demo:6']);
  await open.click();
  await expect
    .poll(() => page.evaluate(() => (window as any).returned))
    .toEqual(['demo:6', 'demo:6']);
});
