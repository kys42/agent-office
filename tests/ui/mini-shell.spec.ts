import { test, expect } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

const PTY = '0b0e2a7c-3a5e-4c58-9d38-5d4e9a1f2b3c';
/**
 * A page of the app with a stubbed desktop shell API (no tmux, no PTY, no windows): the colleague
 * card window (`#card`), the big office (`/`), the desk dock, or the terminal window (`#shell`).
 */
async function setup(
  page: import('@playwright/test').Page,
  options: { shell?: boolean; route?: string; target?: unknown } = {},
) {
  const s = demoSnapshot();
  for (const x of s.sessions) x.cwd = `/projects/${x.project}`;
  s.sessions[0].cwd = '/projects/example/app';
  s.sessions[0].remote = undefined;
  await page.setViewportSize({ width: 420, height: 640 });
  await page.addInitScript(
    ({ s, PTY, shell, target }) => {
      const w = window as any;
      w.fixture = s;
      w.commands = [];
      w.inputs = [];
      w.windowCalls = [];
      localStorage.setItem('office:onboarding:v1:live', 'seen');
      const data = new Set<(id: string, d: string) => void>();
      const exits = new Set<(id: string) => void>();
      w.emit = (d: string) => data.forEach((cb) => cb(PTY, d));
      w.exit = () => exits.forEach((cb) => cb(PTY));
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
        onCard: (cb: any) => {
          w.cardTarget = cb;
          return () => {};
        },
        cardState: async () => ({
          pinned: false,
          positionRemembered: false,
          target: { id: s.sessions[0].id, news: false },
        }),
        ...(shell
          ? {
              shell: {
                command: async (c: any) => {
                  w.commands.push(c.type === 'resize' ? 'resize' : c);
                  if (c.type === 'list')
                    return [
                      { name: 'shell-0123456789abcdef', cwd: '/projects/example/app', attached: 2 },
                      { name: 'shell-fedcba9876543210', cwd: '/projects/other', attached: 0 },
                    ];
                  if (c.type === 'open' || c.type === 'attach') {
                    setTimeout(() => w.emit('mini-shell-ready$ '), 0);
                    return {
                      ptyId: PTY,
                      name: c.name ?? 'shell-0123456789abcdef',
                      cwd: c.name ? '/projects/other' : '/projects/example/app',
                      created: c.type === 'open',
                    };
                  }
                  if (c.type === 'kill') return w.confirmKill ?? false;
                },
                input: (id: string, d: string) => w.inputs.push([id, d]),
                onData: (cb: any) => {
                  data.add(cb);
                  return () => data.delete(cb);
                },
                onExit: (cb: any) => {
                  exits.add(cb);
                  return () => exits.delete(cb);
                },
                window: async (action: string, t?: unknown) => {
                  w.windowCalls.push(t === undefined ? [action] : [action, t]);
                  if (action === 'target')
                    return target ?? { id: s.sessions[0].id, cwd: '/projects/example/app' };
                },
              },
            }
          : {}),
      };
    },
    { s, PTY, shell: options.shell ?? true, target: options.target ?? null },
  );
  await page.goto(options.route ?? '/#card');
}
const commands = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).commands.filter((c: any) => c !== 'resize'));
const windowCalls = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).windowCalls);

test('a card asks for the colleague folder terminal window and draws no terminal itself', async ({
  page,
}) => {
  await setup(page);
  await page.getByRole('button', { name: '미니 터미널', exact: true }).click();
  const id = await page.evaluate(() => (window as any).fixture.sessions[0].id);
  // The window names the session; main reads its folder and opens the window beside the card.
  expect(await windowCalls(page)).toEqual([['open', { id, cwd: '/projects/example/app' }]]);
  await expect(page.locator('.mini-shell')).toHaveCount(0);
  expect(await commands(page)).toEqual([]);
  // Asked again: the same request (main brings the open window forward, never a second one).
  await page.getByRole('button', { name: '미니 터미널', exact: true }).click();
  expect((await windowCalls(page)).length).toBe(2);
});

test('the terminal window fills itself with the shell; closing it only detaches', async ({
  page,
}) => {
  await setup(page, { route: '/#shell' });
  await page.setViewportSize({ width: 640, height: 400 });
  const panel = page.getByRole('region', { name: '미니 터미널' });
  await expect(panel).toHaveAttribute('data-status', 'live');
  await expect(panel.locator('.xterm-rows')).toContainText('mini-shell-ready$');
  await expect(page.getByText('새 셸을 띄웠어요. 창을 닫아도', { exact: false })).toBeVisible();
  await expect(page).toHaveTitle('미니 터미널 · app');
  const [open] = await commands(page);
  const id = await page.evaluate(() => (window as any).fixture.sessions[0].id);
  // The window names the session, never a folder or a command.
  expect(open).toMatchObject({ type: 'open', id });
  expect(Object.keys(open).sort()).toEqual(['cols', 'id', 'rows', 'type']);
  // The terminal takes the whole window under its header.
  const box = (await panel.boundingBox())!;
  expect(box.width).toBe(640);
  expect(box.height).toBe(400);
  const body = (await panel.locator('.mini-shell-body').boundingBox())!;
  expect(body.height).toBeGreaterThan(330);
  // The header moves the window; its buttons stay clickable.
  const regions = await page.evaluate(() => ({
    bar: getComputedStyle(document.querySelector('.mini-shell-bar')!).getPropertyValue(
      '-webkit-app-region',
    ),
    button: getComputedStyle(document.querySelector('.mini-shell-bar button')!).getPropertyValue(
      '-webkit-app-region',
    ),
  }));
  expect(regions).toEqual({ bar: 'drag', button: 'no-drag' });
  await panel.locator('.xterm').click();
  // A press in the terminal asks main for the keyboard.
  expect(await windowCalls(page)).toContainEqual(['focus']);
  await page.keyboard.type('open .');
  await page.keyboard.press('Enter');
  const typed = await page.evaluate(() => (window as any).inputs);
  expect(typed.every(([id]: [string]) => id === '0b0e2a7c-3a5e-4c58-9d38-5d4e9a1f2b3c')).toBe(true);
  expect(typed.map(([, d]: [string, string]) => d).join('')).toBe('open .\r');
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: '크게 보기' })).toHaveCount(0);
  await page.screenshot({ path: '.local/mini-shell-window.png', animations: 'disabled' });
  await panel.getByRole('button', { name: '닫기 (계속 실행)' }).click();
  expect((await windowCalls(page)).at(-1)).toEqual(['close']);
});

test('another open shell opens in its own window; ending asks the desktop first', async ({
  page,
}) => {
  await setup(page, { route: '/#shell' });
  const panel = page.getByRole('region', { name: '미니 터미널' });
  await expect(panel).toHaveAttribute('data-status', 'live');
  await panel.getByRole('button', { name: '열려 있는 터미널' }).click();
  // This window's own shell is marked; choosing it does nothing.
  await panel.getByRole('menuitem', { name: /app/ }).click();
  expect((await windowCalls(page)).filter(([a]: [string]) => a === 'open')).toEqual([]);
  await panel.getByRole('button', { name: '열려 있는 터미널' }).click();
  await panel.getByRole('menuitem', { name: /other/ }).click();
  expect((await windowCalls(page)).at(-1)).toEqual([
    'open',
    { name: 'shell-fedcba9876543210', cwd: '/projects/other' },
  ]);
  // This window keeps its own shell.
  await expect(panel.locator('.mini-shell-path')).toHaveText('/projects/example/app');
  // Cancelled in the desktop's confirmation: nothing changes.
  await panel.getByRole('button', { name: '종료' }).click();
  await expect(panel).toBeVisible();
  expect((await windowCalls(page)).at(-1)?.[0]).toBe('open');
  // Confirmed: the shell ends and its window closes.
  await page.evaluate(() => ((window as any).confirmKill = true));
  await panel.getByRole('button', { name: '종료' }).click();
  await expect.poll(async () => (await windowCalls(page)).at(-1)).toEqual(['close']);
});

test('a terminal window for an existing shell attaches to it; an ended shell says so', async ({
  page,
}) => {
  await setup(page, {
    route: '/#shell',
    target: { name: 'shell-fedcba9876543210', cwd: '/projects/other' },
  });
  const panel = page.getByRole('region', { name: '미니 터미널' });
  await expect(panel).toHaveAttribute('data-status', 'live');
  await expect(panel.locator('.mini-shell-path')).toHaveText('/projects/other');
  expect((await commands(page)).filter((c: any) => c.type === 'attach')).toEqual([
    {
      type: 'attach',
      name: 'shell-fedcba9876543210',
      cols: expect.any(Number),
      rows: expect.any(Number),
    },
  ]);
  await page.evaluate(() => (window as any).exit());
  await expect(panel.getByText('셸이 끝났어요.')).toBeVisible();
});

test('privacy disables the card button; no desktop shell, no button', async ({ page }) => {
  await setup(page);
  await expect(page.getByRole('button', { name: '미니 터미널', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.preferences.privacy = true;
    w.publish(structuredClone(w.fixture));
  });
  await expect(page.getByRole('button', { name: '미니 터미널', exact: true })).toBeDisabled();

  const web = await page.context().newPage();
  await setup(web, { shell: false });
  await expect(web.locator('.card-actions')).toBeVisible();
  await expect(web.getByRole('button', { name: '미니 터미널', exact: true })).toHaveCount(0);
});

test('a project zone opens its folder terminal window, from the office and the desk dock', async ({
  page,
}) => {
  await setup(page, { route: '/' });
  await page.setViewportSize({ width: 1440, height: 970 });
  const project = await page.evaluate(() => (window as any).fixture.sessions[1].project);
  const button = page.getByRole('button', { name: `${project}에서 미니 터미널 열기` }).first();
  await button.click();
  const [[action, target]] = await windowCalls(page);
  expect(action).toBe('open');
  const ids = await page.evaluate(
    (project) =>
      (window as any).fixture.sessions
        .filter((x: any) => x.project === project)
        .map((x: any) => x.id),
    project,
  );
  expect(ids).toContain(target.id);
  // The office itself draws no terminal.
  await expect(page.locator('.mini-shell')).toHaveCount(0);
  await page.screenshot({ path: '.local/mini-shell-office.png', animations: 'disabled' });

  // The desk dock can open one too now: the window opens beside the dock.
  const dock = await page.context().newPage();
  await setup(dock, { route: '/#mini=floor' });
  await expect(dock.locator('.zone-flag').first()).toBeAttached();
  await expect(dock.getByRole('button', { name: /미니 터미널 열기/ }).first()).toBeAttached();
});

test('the sample office lets go of every terminal window and offers none', async ({ page }) => {
  await setup(page, { route: '/' });
  await page.setViewportSize({ width: 1440, height: 970 });
  const project = await page.evaluate(() => (window as any).fixture.sessions[1].project);
  await expect(
    page.getByRole('button', { name: `${project}에서 미니 터미널 열기` }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: '데모 둘러보기' }).click();
  await expect.poll(async () => (await windowCalls(page)).at(-1)).toEqual(['close-all']);
  await expect(page.getByRole('button', { name: /미니 터미널/ })).toHaveCount(0);
});

test('a very wide terminal window never asks for more columns than the terminal may have', async ({
  page,
}) => {
  await setup(page, { route: '/#shell' });
  await page.setViewportSize({ width: 3800, height: 900 });
  const panel = page.getByRole('region', { name: '미니 터미널' });
  await expect(panel).toHaveAttribute('data-status', 'live');
  const [open] = await commands(page);
  expect(open.cols).toBe(400);
  // xterm itself is that size too, so the screen and tmux agree.
  const width = await panel
    .locator('.xterm-rows > div')
    .first()
    .evaluate((row) => row.textContent!.length);
  expect(width).toBeLessThanOrEqual(400);
});

test('a flood of output pauses the shell until the view catches up', async ({ page }) => {
  await setup(page, { route: '/#shell' });
  const panel = page.getByRole('region', { name: '미니 터미널' });
  await expect(panel).toHaveAttribute('data-status', 'live');
  await page.evaluate(() => {
    const w = window as any;
    const line = 'y'.repeat(79) + '\r\n';
    for (let i = 0; i < 64; i++) w.emit(line.repeat(128)); // ~650 KB at once
  });
  const flows = () =>
    page.evaluate(() =>
      (window as any).commands.filter((c: any) => c.type === 'flow').map((c: any) => c.paused),
    );
  await expect.poll(flows).toEqual([true, false]);
});
