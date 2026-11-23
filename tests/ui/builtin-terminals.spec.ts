import { test, expect, type Page } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';

// Settings › 내장 터미널: the sessions the built-in terminal keeps running in the background, as
// main lists them, with 열기 · 숨기기 · 종료. The desktop API is stubbed: no daemon, no window.

interface Options {
  enabled?: boolean;
  /** No daemon runs. */
  off?: boolean;
  window?: boolean;
}

async function setup(page: Page, options: Options = {}) {
  const s = demoSnapshot();
  s.preferences.locale = 'ko';
  s.preferences.builtinTerminal = options.enabled !== false;
  if (options.window !== undefined) s.preferences.builtinTerminalWindow = options.window;
  const now = Date.now();
  await page.addInitScript(
    ({ s, off, now }) => {
      const w = window as any;
      w.acts = [];
      w.lists = 0;
      w.rows = [
        {
          id: 'ao-1',
          program: 'claude',
          cwd: '/Users/me/work/app',
          agents: [{ id: 's1', name: '버터', provider: 'claude' }],
          startedAt: now - 5 * 60_000,
          pid: 4242,
          rss: 214 * 1024 * 1024,
          windowOpen: true,
          attached: 1,
        },
        {
          id: 'ao-2',
          program: 'codex',
          cwd: '/Users/me/work/b',
          agents: [],
          startedAt: now - 2 * 3600_000,
          pid: 4343,
          rss: 80 * 1024 * 1024,
          windowOpen: false,
          attached: 0,
        },
        {
          id: 'ao-3',
          program: 'claude',
          cwd: '/Users/me/work/c',
          agents: [],
          startedAt: now - 3600_000,
          pid: 4444,
          exit: { code: 0, signal: null, at: now - 60_000 },
          windowOpen: false,
          attached: 0,
        },
      ];
      w.office = {
        snapshot: async () => structuredClone(s),
        subscribe: () => () => {},
        artifacts: async () => [],
        visit: async () => structuredClone(s),
        detail: async (id: string) => structuredClone(s.sessions.find((x: any) => x.id === id)),
        preferences: async (p: any) => {
          (w.saved ??= []).push(p);
          s.preferences = { ...s.preferences, ...p };
          return structuredClone(s);
        },
        terminalSend: async () => true,
        answerSettings: async () => ({ questions: 'unset', permissions: 'unset' }),
        onDesktopSettings: () => () => {},
        terminals: async () => ({}),
        builtinTerminals: {
          list: async () => {
            w.lists++;
            if (off) return { supported: true, daemon: null, sessions: [], hidden: false };
            const live = w.rows.filter((r: any) => !r.exit).length;
            return {
              supported: true,
              hidden: false,
              daemon: {
                pid: 99,
                startedAt: now - 3 * 3600_000,
                rss: 72 * 1024 * 1024,
                live,
                sessions: w.rows.length,
              },
              sessions: structuredClone(w.rows),
            };
          },
          act: async (session: string, action: string) => {
            w.acts.push(`${action}:${session}`);
            const row = w.rows.find((r: any) => r.id === session);
            if (action === 'hide') row.windowOpen = false;
            if (action === 'open') row.windowOpen = true;
            // The confirmation in main: ended.
            if (action === 'kill') row.exit = { code: null, signal: 1, at: Date.now() };
            return true;
          },
        },
      };
    },
    { s, off: !!options.off, now },
  );
  await page.goto('/?lang=ko#settings=terminal');
}

const list = (page: Page) => page.locator('[data-setting="builtin-terminal-list"]');
const row = (page: Page, id: string) => list(page).locator(`[data-term-session="${id}"]`);

test('Settings lists the built-in terminals running in the background, with their facts', async ({
  page,
}) => {
  await setup(page);
  await expect(list(page).getByText('실행 중인 내장 터미널')).toBeVisible();
  await expect(list(page)).toContainText('2개 실행 중 · 터미널 호스트 72 MB');
  const butter = row(page, 'ao-1');
  await expect(butter).toContainText('버터');
  await expect(butter).toContainText('claude');
  await expect(butter).toContainText('~/work/app');
  await expect(butter).toContainText('창 열림');
  await expect(butter).toContainText('5분 전 시작');
  await expect(butter).toContainText('메모리 214 MB');
  await expect(butter).toContainText('PID 4242');
  const codex = row(page, 'ao-2');
  await expect(codex).toContainText('codex');
  await expect(codex).toContainText('뒤에서 실행 중');
  await expect(codex).toContainText('연결된 대화 없음');
  // Only a session with an open window can be hidden; an ended one can't be opened or ended.
  await expect(codex.getByRole('button', { name: '숨기기' })).toBeDisabled();
  const ended = row(page, 'ao-3');
  await expect(ended).toContainText('끝남 (코드 0)');
  await expect(ended.getByRole('button', { name: '열기' })).toBeDisabled();
  await expect(ended.getByRole('button', { name: '종료' })).toBeDisabled();
  await list(page).screenshot({ path: '.local/builtin-terminal-list.png' });
});

test('숨기기 closes the window only, 열기 brings it back and 종료 goes through main', async ({
  page,
}) => {
  await setup(page);
  const butter = row(page, 'ao-1');
  await butter.getByRole('button', { name: '숨기기' }).click();
  await expect(butter).toContainText('뒤에서 실행 중');
  await expect(butter.getByRole('button', { name: '숨기기' })).toBeDisabled();
  await butter.getByRole('button', { name: '열기' }).click();
  await expect(butter).toContainText('창 열림');
  await row(page, 'ao-2').getByRole('button', { name: '종료' }).click();
  await expect(row(page, 'ao-2')).toContainText('끝남');
  expect(await page.evaluate(() => (window as any).acts)).toEqual([
    'hide:ao-1',
    'open:ao-1',
    'kill:ao-2',
  ]);
  await expect(list(page)).toContainText('1개 실행 중');
});

test('the list refreshes by itself while shown', async ({ page }) => {
  await setup(page);
  await expect(row(page, 'ao-1')).toBeVisible();
  const before = await page.evaluate(() => (window as any).lists);
  await page.evaluate(() => {
    (window as any).rows[0].windowOpen = false;
  });
  await expect(row(page, 'ao-1')).toContainText('뒤에서 실행 중', { timeout: 8000 });
  expect(await page.evaluate(() => (window as any).lists)).toBeGreaterThan(before);
});

test('a new session opens its window by default; off, it starts hidden', async ({ page }) => {
  await setup(page);
  const toggle = page
    .locator('[data-setting="builtin-terminal-window"]')
    .getByRole('switch', { name: '시작할 때 터미널 창 열기' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(await page.evaluate(() => (window as any).saved)).toContainEqual({
    builtinTerminalWindow: false,
  });
});

test('with no daemon the list says it is off; with the setting off too, nothing shows', async ({
  page,
}) => {
  await setup(page, { off: true });
  await expect(list(page)).toContainText('내장 터미널이 꺼져 있어요');
  await expect(list(page).locator('[data-term-session]')).toHaveCount(0);
});

test('the setting off with nothing running hides the list and the window switch', async ({
  page,
}) => {
  await setup(page, { enabled: false, off: true });
  await expect(page.locator('[data-setting="builtin-terminal"]')).toBeVisible();
  await expect(list(page)).toHaveCount(0);
  await expect(page.locator('[data-setting="builtin-terminal-window"]')).toHaveCount(0);
});

test('the setting off still lists sessions that keep running', async ({ page }) => {
  await setup(page, { enabled: false });
  await expect(row(page, 'ao-1')).toContainText('버터');
});
