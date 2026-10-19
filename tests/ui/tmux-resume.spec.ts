import { test, expect } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
async function setup(page: import('@playwright/test').Page, remote = false, route = '/#card') {
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
      tmuxSummon: async (
        id: string,
        action: string,
        provider: string,
        name: string,
        initialMessage?: string,
      ) => {
        w.lastName = name;
        w.lastId = id;
        w.actions.push(provider + ':' + action);
        if (action === 'start') {
          w['running_' + provider] = true;
          w.sentInitialMessage = initialMessage;
        }
        return {
          connections: [{ id: s.sessions[0].id, name: '기존 개발자', label: 'Orca' }],
          name: 'office-' + provider + '-fresh',
          cwd: '/projects/example',
          command: 'tmux attach ' + provider,
          running: !!w['running_' + provider],
          canOpen: true,
        };
      },
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
      jump: async () => {
        w.jumped = true;
        return { action: 'focused', text: 'Orca' };
      },
      copyText: async (text: string) => {
        w.copied = text;
      },
    };
  }, s);
  await page.goto(route);
}
test('tmux resume explains first, preserves cancelled state, reconnects on reopen and fits a small popup', async ({
  page,
}) => {
  await setup(page);
  await expect(page.getByRole('button', { name: '새 에이전트 소환', exact: true })).toHaveCount(0);
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
  await page.evaluate(() => {
    (window as any).error = '터미널을 열지 못했어요';
  });
  await modal.getByRole('button', { name: '터미널에서 열기' }).click();
  await expect(modal.getByRole('alert')).toHaveText('터미널을 열지 못했어요');
  await expect(modal.getByRole('button', { name: '재접속 명령 복사' })).toBeVisible();
  await page.evaluate(() => {
    (window as any).error = '';
  });
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

for (const route of ['/', '/#mini=floor'])
  test(
    'summon ' +
      route +
      ' chooses provider, starts a new conversation and reconnects after reopening',
    async ({ page }) => {
      await setup(page, false, route);
      if (await page.locator('.zone-flag-cloth').count())
        await page.locator('.zone-flag-cloth').first().hover();
      await page.getByRole('button', { name: '새 에이전트 소환', exact: true }).first().click();
      await expect(page.getByText('office-claude-fresh', { exact: true })).toBeVisible();
      const modal = page.getByRole('dialog', { name: '새 에이전트 소환' });
      await modal.getByLabel('에이전트 이름', { exact: true }).fill('리뷰 봇');
      await modal
        .getByRole('textbox', { name: '첫 메시지 (선택)', exact: true })
        .fill('프로젝트를 살펴봐줘\n개선점도 알려줘');
      await modal.getByRole('button', { name: 'Codex', exact: true }).click();
      await expect(modal.getByText('기존 개발자 · Orca')).toBeVisible();
      await modal.getByRole('button', { name: '기존 세션으로 이동' }).click();
      expect(await page.evaluate(() => (window as any).jumped)).toBe(true);
      expect(await page.evaluate(() => (window as any).lastName)).toBe('리뷰 봇');
      await expect(page.getByText('office-codex-fresh', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'tmux에 소환하기', exact: true }).click();
      expect(await page.evaluate(() => (window as any).sentInitialMessage)).toBe(
        '프로젝트를 살펴봐줘\n개선점도 알려줘',
      );
      await expect(
        modal.getByRole('textbox', { name: '첫 메시지 (선택)', exact: true }),
      ).toBeDisabled();
      await expect(modal.getByText(/오피스에는 첫 대화 기록/)).toBeVisible();
      await expect(
        page.getByRole('button', { name: '터미널에서 열기', exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: '.local/project-summon-' + (route === '/' ? 'office' : 'floor') + '.png',
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await expect(modal).toHaveCount(0);
      if (await page.locator('.zone-flag-cloth').count())
        await page.locator('.zone-flag-cloth').first().hover();
      await page.getByRole('button', { name: '새 에이전트 소환', exact: true }).first().click();
      await expect(
        page.getByRole('button', { name: '터미널에서 열기', exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() =>
          (window as any).actions.filter((x: string) => x.endsWith(':start')),
        ),
      ).toEqual(['codex:start']);
    },
  );

test('project membership changes cannot launch a stale session folder', async ({ page }) => {
  await setup(page, false, '/#mini=floor');
  if (await page.locator('.zone-flag-cloth').count())
    await page.locator('.zone-flag-cloth').first().hover();
  await page.getByRole('button', { name: '새 에이전트 소환', exact: true }).first().click();
  const modal = page.getByRole('dialog', { name: '새 에이전트 소환' });
  const folder = modal.getByRole('combobox');
  const previous = await folder.inputValue();
  await page.evaluate(() => {
    const w = window as any;
    for (const s of w.fixture.sessions) s.id += '-replacement';
    w.publish(structuredClone(w.fixture));
  });
  await expect(folder).not.toHaveValue(previous);
  await expect(modal.getByRole('button', { name: 'tmux에 소환하기' })).toHaveCount(0);
  await modal.getByRole('button', { name: '연결과 이름 확인' }).click();
  expect(await page.evaluate(() => (window as any).lastId)).toBe(await folder.inputValue());
});

for (const colorScheme of ['light', 'dark'] as const)
  test(`floor flag controls reveal on hover in ${colorScheme} and the pole is draggable`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await setup(page, false, '/#mini=floor');
    await page.setViewportSize({ width: 2400, height: 720 });
    await expect
      .poll(() => page.locator('.desk-row-lane').evaluate((el) => el.getBoundingClientRect().width))
      .toBeGreaterThan(2000);
    const zone = page.locator('.row-zone').first();
    const plus = zone.getByRole('button', { name: '새 에이전트 소환', exact: true });
    await expect(plus).toHaveCSS('opacity', '0');
    await expect(plus).toHaveCSS('pointer-events', 'none');
    await zone.locator('.zone-flag-cloth').hover();
    await expect(plus).toHaveCSS('opacity', '1');
    await expect(plus).toHaveCSS('background-color', 'rgb(34, 34, 34)');
    await expect(plus).toHaveCSS('color', 'rgb(255, 255, 255)');
    const hide = zone.locator('.zone-veil');
    await expect(hide).toBeVisible();
    await expect(hide).toHaveCSS('opacity', '1');
    await plus.hover();
    await hide.hover();
    await expect(plus).toHaveCSS('opacity', '1');
    await page.mouse.move(0, 0);
    await expect(plus).toHaveCSS('opacity', '0');
    await expect(hide).toHaveCSS('opacity', '0');
    await plus.focus();
    await expect(plus).toHaveCSS('opacity', '1');
    await plus.evaluate((el) => (el as HTMLElement).blur());
    const a = (await plus.boundingBox())!,
      b = (await hide.boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
    const pole = zone.locator('.zone-flag-pole');
    const box = (await pole.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(15);
    const before = await zone.evaluate((el) => parseFloat((el as HTMLElement).style.left));
    await page.mouse.move(box.x + 2, box.y + box.height - 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 82, box.y + box.height - 30, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(() => zone.evaluate((el) => parseFloat((el as HTMLElement).style.left)))
      .toBeGreaterThan(before);
    await page.screenshot({
      path: `.local/flag-controls-${colorScheme}.png`,
      animations: 'disabled',
    });
  });
