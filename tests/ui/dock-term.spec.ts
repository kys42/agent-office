import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

// 쪼꼬미 (tiny dock) pill: a terminal button that opens the terminal manager, only with the
// experimental built-in terminal on and the desktop API present. The desktop API is stubbed.

async function setup(
  page: Page,
  opts: {
    hash?: string;
    enabled?: boolean;
    api?: boolean;
    hidden?: boolean;
    privacy?: boolean;
  } = {},
) {
  const s = demoSnapshot();
  s.preferences.locale = 'ko';
  s.preferences.builtinTerminal = opts.enabled !== false;
  s.preferences.privacy = !!opts.privacy;
  if (opts.hidden) s.preferences.views = { dock: { terminalButton: false } };
  await page.setViewportSize({ width: 1440, height: 720 });
  await page.addInitScript(
    ({ s, withApi }) => {
      const w = window as any;
      w.fixture = s;
      w.managerCalls = 0;
      w.calls = [];
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string) =>
          structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(w.fixture),
        artifacts: async () => [],
        terminals: async () => ({}),
        subscribe: () => () => {},
        window: async (a: string) => w.calls.push(`window:${a}`),
        dock: async (a: string) => w.calls.push(a),
        onDock: () => () => {},
        ...(withApi
          ? {
              builtinTerminals: {
                list: async () => ({ supported: true, hidden: false, daemon: null, sessions: [] }),
                act: async () => true,
                manager: async () => {
                  w.managerCalls++;
                  return 'ok';
                },
              },
            }
          : {}),
      };
    },
    { s, withApi: opts.api !== false },
  );
  await page.goto(`/?lang=ko${opts.hash ?? '#mini=row&tiny'}`);
  await expect(page.locator('.dock-pill')).toBeVisible();
}
const button = (page: Page) => page.getByRole('button', { name: '터미널 관리 창', exact: true });

test('Tiny dock: the terminal button opens the manager, and fits the pill', async ({ page }) => {
  await setup(page);
  await expect(button(page)).toBeVisible();
  const pill = (await page.locator('.dock-pill').boundingBox())!;
  const btn = (await button(page).boundingBox())!;
  expect(btn.x).toBeGreaterThanOrEqual(pill.x);
  expect(btn.x + btn.width).toBeLessThanOrEqual(pill.x + pill.width + 0.5);
  // Every pill button stays inside the pill (nothing pushed out).
  for (const b of await page.locator('.dock-pill button').all()) {
    const box = (await b.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(pill.x + pill.width + 0.5);
  }
  await page.locator('.dock-pill').hover();
  await button(page).click();
  expect(await page.evaluate(() => (window as any).managerCalls)).toBe(1);
  await page.screenshot({
    path: '.local/term-dock.png',
    clip: { x: 0, y: 360, width: 1440, height: 360 },
  });
});

test('Full-size row shows it too', async ({ page }) => {
  await setup(page, { hash: '#mini=row' });
  await expect(button(page)).toBeVisible();
});

test('No button with the built-in terminal off, without the desktop API, hidden in Settings, or in privacy', async ({
  page,
}) => {
  await setup(page, { enabled: false });
  await expect(button(page)).toHaveCount(0);
  await page.close();
});
for (const [name, opts] of [
  ['no desktop API', { api: false }],
  ['display option off', { hidden: true }],
  ['privacy', { privacy: true }],
] as const)
  test(`No button: ${name}`, async ({ page }) => {
    await setup(page, opts);
    await expect(button(page)).toHaveCount(0);
  });
