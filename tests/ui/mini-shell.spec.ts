import { test, expect } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

const PTY = '0b0e2a7c-3a5e-4c58-9d38-5d4e9a1f2b3c';
/** A colleague card window with a stubbed desktop shell API (no tmux, no PTY). */
async function setup(
  page: import('@playwright/test').Page,
  options: { shell?: boolean; route?: string } = {},
) {
  const s = demoSnapshot();
  for (const x of s.sessions) x.cwd = `/projects/${x.project}`;
  s.sessions[0].cwd = '/projects/example/app';
  s.sessions[0].remote = undefined;
  await page.setViewportSize({ width: 420, height: 640 });
  await page.addInitScript(
    ({ s, PTY, shell }) => {
      const w = window as any;
      w.fixture = s;
      w.commands = [];
      w.inputs = [];
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
        onCard: () => () => {},
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
                      { name: 'shell-0123456789abcdef', cwd: '/projects/example/app', attached: 1 },
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
              },
            }
          : {}),
      };
    },
    { s, PTY, shell: options.shell ?? true },
  );
  await page.goto(options.route ?? '/#card');
}
const commands = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).commands.filter((c: any) => c !== 'resize'));

test('a card opens a mini terminal in the colleague folder; closing only detaches', async ({
  page,
}) => {
  await setup(page);
  await page.getByRole('button', { name: '미니 터미널', exact: true }).click();
  const panel = page.getByRole('region', { name: '미니 터미널' });
  await expect(panel).toHaveAttribute('data-status', 'live');
  await expect(panel.locator('.xterm-rows')).toContainText('mini-shell-ready$');
  await expect(panel.getByText('새 셸을 띄웠어요', { exact: false })).toBeVisible();
  const [open] = await commands(page);
  // The window names the session, never a folder or a command.
  expect(open).toMatchObject({
    type: 'open',
    id: await page.evaluate(() => (window as any).fixture.sessions[0].id),
  });
  expect(Object.keys(open).sort()).toEqual(['cols', 'id', 'rows', 'type']);
  await panel.locator('.xterm').click();
  await page.keyboard.type('open .');
  await page.keyboard.press('Enter');
  const typed = await page.evaluate(() => (window as any).inputs);
  expect(typed.every(([id]: [string]) => id === '0b0e2a7c-3a5e-4c58-9d38-5d4e9a1f2b3c')).toBe(true);
  expect(typed.map(([, d]: [string, string]) => d).join('')).toBe('open .\r');
  // Esc goes to the shell, not to the card.
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await page.screenshot({ path: '.local/mini-shell-card.png', animations: 'disabled' });
  // Dialogs and the command palette stay above the drawer.
  const layers = await page.evaluate(() => {
    const probe = (cls: string) => {
      const el = document.createElement('div');
      el.className = cls;
      document.body.append(el);
      const z = Number(getComputedStyle(el).zIndex);
      el.remove();
      return z;
    };
    return {
      drawer: Number(getComputedStyle(document.querySelector('.mini-shell')!).zIndex),
      modal: probe('modal-backdrop'),
      palette: probe('palette-backdrop'),
    };
  });
  expect(layers.drawer).toBeLessThan(layers.modal);
  expect(layers.drawer).toBeLessThan(layers.palette);
  const compact = (await panel.boundingBox())!.height;
  await panel.getByRole('button', { name: '크게 보기' }).click();
  await expect(panel).toHaveClass(/is-expanded/);
  // In the small card window too, 크게 보기 really makes it taller.
  await expect.poll(async () => (await panel.boundingBox())!.height).toBeGreaterThan(compact + 50);
  await panel.getByRole('button', { name: '닫기 (계속 실행)' }).click();
  await expect(panel).toHaveCount(0);
  expect((await commands(page)).at(-1)).toEqual({ type: 'detach', ptyId: PTY });
});

test('other shells can be reattached, ending asks the desktop first, and an ended shell says so', async ({
  page,
}) => {
  await setup(page);
  await page.getByRole('button', { name: '미니 터미널', exact: true }).click();
  const panel = page.getByRole('region', { name: '미니 터미널' });
  await expect(panel).toHaveAttribute('data-status', 'live');
  await panel.getByRole('button', { name: '열려 있는 터미널' }).click();
  await panel.getByRole('menuitem', { name: /other/ }).click();
  await expect(panel.locator('.mini-shell-path')).toHaveText('/projects/other');
  expect((await commands(page)).filter((c: any) => c.type === 'attach')).toEqual([
    {
      type: 'attach',
      name: 'shell-fedcba9876543210',
      cols: expect.any(Number),
      rows: expect.any(Number),
    },
  ]);
  // Cancelled in the desktop's confirmation: nothing changes.
  await panel.getByRole('button', { name: '종료' }).click();
  await expect(panel).toBeVisible();
  await page.evaluate(() => (window as any).exit());
  await expect(panel.getByText('셸이 끝났어요.')).toBeVisible();
});

test('privacy closes the panel and disables the button; no desktop shell, no button', async ({
  page,
}) => {
  await setup(page);
  await page.getByRole('button', { name: '미니 터미널', exact: true }).click();
  await expect(page.getByRole('region', { name: '미니 터미널' })).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.preferences.privacy = true;
    w.publish(structuredClone(w.fixture));
  });
  await expect(page.getByRole('region', { name: '미니 터미널' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '미니 터미널', exact: true })).toBeDisabled();

  const web = await page.context().newPage();
  await setup(web, { shell: false });
  await expect(web.locator('.card-actions')).toBeVisible();
  await expect(web.getByRole('button', { name: '미니 터미널', exact: true })).toHaveCount(0);
});

test('a project zone opens its folder; the desk dock has no panel, so no button', async ({
  page,
}) => {
  await setup(page, { route: '/' });
  await page.setViewportSize({ width: 1440, height: 970 });
  const project = await page.evaluate(() => (window as any).fixture.sessions[1].project);
  const button = page.getByRole('button', { name: `${project}에서 미니 터미널 열기` }).first();
  await button.click();
  const panel = page.getByRole('region', { name: '미니 터미널' });
  await expect(panel).toHaveAttribute('data-status', 'live');
  const [open] = await commands(page);
  const ids = await page.evaluate(
    (project) =>
      (window as any).fixture.sessions
        .filter((x: any) => x.project === project)
        .map((x: any) => x.id),
    project,
  );
  expect(ids).toContain(open.id);
  await page.screenshot({ path: '.local/mini-shell-office.png', animations: 'disabled' });

  const dock = await page.context().newPage();
  await setup(dock, { route: '/#mini=floor' });
  await expect(dock.locator('.zone-flag').first()).toBeAttached();
  await expect(dock.getByRole('button', { name: /미니 터미널/ })).toHaveCount(0);
});
