import { test, expect, type Page } from '@playwright/test';
import './korean';

// The terminal manager (터미널 관리 창): every built-in session in one window, the selected one
// drawn live, the others as a few preview rows. The desktop API is stubbed: no daemon, no PTY,
// no agent; each attach answers a restored screen naming its session.

const VIEWS: Record<string, string> = {
  'ao-1': '0b0e2a7c-3a5e-4c58-9d38-5d4e9a1f2b01',
  'ao-2': '0b0e2a7c-3a5e-4c58-9d38-5d4e9a1f2b02',
  'ao-3': '0b0e2a7c-3a5e-4c58-9d38-5d4e9a1f2b03',
  'ao-4': '0b0e2a7c-3a5e-4c58-9d38-5d4e9a1f2b04',
};

interface Options {
  privacy?: boolean;
  /** The session main already chose (a jump opened the manager there). */
  selected?: string;
}

async function setup(page: Page, options: Options = {}) {
  await page.setViewportSize({ width: 900, height: 520 });
  const now = Date.now();
  await page.addInitScript(
    ({ VIEWS, privacy, selected, now }) => {
      const w = window as any;
      w.commands = [];
      w.selects = [];
      w.previews = [];
      w.acts = [];
      w.lists = 0;
      w.windowCalls = [];
      localStorage.setItem('office:onboarding:v1:live', 'seen');
      w.hidden = false;
      Object.defineProperty(document, 'visibilityState', {
        get: () => (w.hidden ? 'hidden' : 'visible'),
      });
      w.setHidden = (hidden: boolean) => {
        w.hidden = hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      };
      const rows = [
        {
          id: 'ao-1',
          program: 'claude',
          cwd: '/Users/me/work/app',
          agents: [
            { id: 's1', name: '버터', alias: '버터', title: '로그인 고치기', provider: 'claude' },
          ],
          project: { key: 'repo:app', name: 'app' },
          startedAt: now - 60_000,
          pid: 4242,
          rss: 214 * 1024 * 1024,
          windowOpen: true,
          attached: 1,
          output: 100,
        },
        {
          id: 'ao-2',
          program: 'codex',
          cwd: '/Users/me/work/b',
          agents: [],
          project: { key: '/Users/me/work/b', name: 'b' },
          startedAt: now - 3600_000,
          pid: 4343,
          rss: 80 * 1024 * 1024,
          windowOpen: false,
          attached: 0,
          output: 100,
        },
        {
          id: 'ao-3',
          program: 'claude',
          cwd: '/Users/me/work/c',
          agents: [],
          project: { key: '/Users/me/work/c', name: 'c' },
          startedAt: now - 7200_000,
          pid: 4444,
          exit: { code: 0, signal: null, at: now - 30_000 },
          windowOpen: false,
          attached: 0,
          output: 100,
        },
        // A second Claude in the same project, known by its session title.
        {
          id: 'ao-4',
          program: 'claude',
          cwd: '/Users/me/work/app',
          agents: [{ id: 's4', name: '테스트 정리', title: '테스트 정리', provider: 'claude' }],
          project: { key: 'repo:app', name: 'app' },
          startedAt: now - 120_000,
          pid: 4545,
          windowOpen: false,
          attached: 0,
          output: 100,
        },
      ];
      const masked = (r: any) =>
        privacy ? { ...r, program: '', cwd: '', agents: [], project: undefined } : r;
      w.office = {
        snapshot: async () => ({}),
        subscribe: () => () => {},
        termManager: {
          list: async () => {
            w.lists++;
            // The second session keeps printing.
            rows[1].output += 50;
            return {
              supported: true,
              hidden: !!privacy,
              daemon: { pid: 9, startedAt: now, rss: 72 * 1024 * 1024, live: 2, sessions: 3 },
              sessions: structuredClone(rows.map(masked)),
            };
          },
          selected: async () => selected ?? null,
          select: async (id: string) => {
            w.selects.push(id);
            const r = rows.find((x) => x.id === id)!;
            return { session: id, title: `${r.program} · ${r.cwd.split('/').pop()}`, cwd: r.cwd };
          },
          preview: async (ids: string[]) => {
            w.previews.push(ids);
            return Object.fromEntries(
              ids.map((id) => [
                id,
                {
                  lines: [`${id} earlier`, `me@mac ${id} % npm run dev`],
                  title: id === 'ao-4' ? '✳ Claude Code' : '',
                },
              ]),
            );
          },
          act: async (id: string, what: string) => {
            w.acts.push([id, what]);
            return true;
          },
          onSelect: (cb: (id: string) => void) => {
            w.mainSelects = cb;
            return () => {};
          },
        },
        term: {
          command: async (c: any) => {
            w.commands.push(c.type === 'resize' ? { type: 'resize' } : c);
            if (c.type === 'attach')
              return {
                viewId: VIEWS[c.session],
                restore: `restored-${c.session}`,
                cols: 80,
                rows: 20,
              };
            if (c.type === 'kill') return false;
          },
          input: () => {},
          onData: () => () => {},
          onResync: () => () => {},
          onLost: () => () => {},
          onExit: () => () => {},
          window: async (what: string) => {
            w.windowCalls.push(what);
            if (what === 'top') return false;
          },
        },
      };
    },
    { VIEWS, privacy: !!options.privacy, selected: options.selected, now },
  );
  await page.goto('/#terms');
}

const commands = (page: Page) => page.evaluate(() => (window as any).commands as any[]);
/** Views attached and not detached yet. */
const live = async (page: Page) => {
  const on = new Set<string>();
  for (const c of await commands(page)) {
    if (c.type === 'attach') on.add(c.session);
    if (c.type === 'detach')
      for (const [session, view] of Object.entries(VIEWS))
        if (view === c.viewId) on.delete(session);
  }
  return [...on];
};
const screenText = (page: Page) => page.locator('.xterm-rows').innerText();
const list = (page: Page) => page.getByRole('navigation', { name: '내장 터미널 세션' });

test('lists the sessions, shows the newest live and previews the others', async ({ page }) => {
  await setup(page);
  const nav = list(page);
  const first = nav.locator('li[data-term-session="ao-1"]');
  await expect(first.getByText('버터')).toBeVisible();
  await expect(first.getByText('claude')).toBeVisible();
  // Grouped by project, the most recent first; two Claude sessions told apart by name.
  await expect(nav.locator('.term-manager-group-head')).toHaveText(['app2', 'b1', 'c1']);
  expect(
    await nav
      .locator('li[data-term-session]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-term-session'))),
  ).toEqual(['ao-1', 'ao-4', 'ao-2', 'ao-3']);
  await expect(nav.locator('li[data-term-session="ao-4"] b')).toHaveText('테스트 정리');
  // No conversation linked: what was typed at its prompt.
  await expect(nav.locator('li[data-term-session="ao-2"] b')).toHaveText('npm run dev');
  await expect(nav.locator('li[data-term-session="ao-2"] b')).toHaveAttribute(
    'data-title-source',
    'prompt',
  );
  await expect(first.getByText('창 열림')).toBeVisible();
  await expect(first.getByText('214 MB')).toBeVisible();
  await expect(nav.locator('li[data-term-session="ao-2"]').getByText('뒤에서')).toBeVisible();
  await expect(nav.locator('li[data-term-session="ao-3"]').getByText('끝남')).toBeVisible();
  // The newest is selected and drawn live, through its own session.
  await expect(first).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => screenText(page)).toContain('restored-ao-1');
  expect(await live(page)).toEqual(['ao-1']);
  // The others: a few rows of their screen; the selected and the ended one have none.
  await expect(nav.locator('li[data-term-session="ao-2"] .term-manager-preview')).toContainText(
    'ao-2 earlier',
  );
  await expect(first.locator('.term-manager-preview')).toHaveCount(0);
  const asked = await page.evaluate(() => (window as any).previews.at(-1));
  expect(asked).toEqual(['ao-4', 'ao-2']);
  // A session printing since the last list is marked busy.
  await expect
    .poll(() =>
      nav.locator('li[data-term-session="ao-2"] .term-manager-dot').getAttribute('data-busy'),
    )
    .toBe('true');
  await page.screenshot({ path: '.local/term-manager.png', animations: 'disabled' });
  await page.screenshot({ path: '.local/term-groups.png', animations: 'disabled' });
});

test('switching detaches the previous view, so only one is ever attached', async ({ page }) => {
  await setup(page);
  await expect.poll(() => screenText(page)).toContain('restored-ao-1');
  await list(page).locator('li[data-term-session="ao-2"] .term-manager-row').click();
  await expect.poll(() => screenText(page)).toContain('restored-ao-2');
  await expect.poll(() => live(page)).toEqual(['ao-2']);
  const all = await commands(page);
  expect(all.find((c) => c.type === 'detach')?.viewId).toBe(VIEWS['ao-1']);
  // The ended one still shows its last screen, still one view at a time.
  await list(page).locator('li[data-term-session="ao-3"] .term-manager-row').click();
  await expect.poll(() => screenText(page)).toContain('restored-ao-3');
  await expect.poll(() => live(page)).toEqual(['ao-3']);
  expect(await page.evaluate(() => (window as any).selects)).toEqual(['ao-1', 'ao-2', 'ao-3']);
});

test('⌘1 / ⌘2 and ⌘⇧] select rows; ⌘W closes the window only', async ({ page }) => {
  await setup(page);
  await expect.poll(() => screenText(page)).toContain('restored-ao-1');
  await page.locator('.xterm').click();
  // The numbers follow the grouped order: app (ao-1, ao-4), then b (ao-2).
  await page.keyboard.press('Meta+3');
  await expect(list(page).locator('li[data-term-session="ao-2"]')).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect.poll(() => live(page)).toEqual(['ao-2']);
  await page.keyboard.press('Meta+1');
  await expect.poll(() => live(page)).toEqual(['ao-1']);
  await page.keyboard.press('Meta+Shift+BracketRight');
  await expect.poll(() => live(page)).toEqual(['ao-4']);
  await page.keyboard.press('Meta+w');
  await expect.poll(() => page.evaluate(() => (window as any).windowCalls)).toContain('close');
  expect((await commands(page)).filter((c) => c.type === 'kill')).toHaveLength(0);
});

test('a session main chooses (a jump) is shown, also while open', async ({ page }) => {
  await setup(page, { selected: 'ao-2' });
  await expect.poll(() => screenText(page)).toContain('restored-ao-2');
  await page.evaluate(() => (window as any).mainSelects('ao-1'));
  await expect.poll(() => live(page)).toEqual(['ao-1']);
});

test('nothing is read while the window is hidden', async ({ page }) => {
  await setup(page);
  await expect.poll(() => page.evaluate(() => (window as any).previews.length)).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).setHidden(true));
  // The view detaches too (TermPanel follows the window's visibility).
  await expect.poll(() => live(page)).toEqual([]);
  const before = await page.evaluate(() => {
    const w = window as any;
    return { previews: w.previews.length, lists: w.lists };
  });
  await page.waitForTimeout(5_600);
  const after = await page.evaluate(() => {
    const w = window as any;
    return { previews: w.previews.length, lists: w.lists };
  });
  expect(after).toEqual(before);
  await page.evaluate(() => (window as any).setHidden(false));
  await expect
    .poll(() => page.evaluate(() => (window as any).previews.length))
    .toBeGreaterThan(before.previews);
  await expect.poll(() => live(page)).toEqual(['ao-1']);
});

test('hidden screen content: no names, folders, previews or terminal', async ({ page }) => {
  await setup(page, { privacy: true });
  const nav = list(page);
  await expect(nav.locator('li[data-term-session="ao-1"]').getByText('ao-1')).toBeVisible();
  await expect(
    page.getByText('화면 내용을 숨기는 동안에는 보여주지 않아요.').first(),
  ).toBeVisible();
  await expect(nav.getByText('버터')).toHaveCount(0);
  await expect(nav.getByText('/Users/me')).toHaveCount(0);
  await expect(nav.getByText('~/work/app')).toHaveCount(0);
  await expect(nav.locator('.term-manager-group-head')).toHaveCount(0);
  await expect(nav.getByText('테스트 정리')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).previews.length)).toBe(0);
  expect(await page.evaluate(() => (window as any).selects.length)).toBe(0);
  expect((await commands(page)).filter((c) => c.type === 'attach')).toHaveLength(0);
  await nav.locator('li[data-term-session="ao-1"]').hover();
  await expect(nav.getByRole('button', { name: '개별 창' }).first()).toBeDisabled();
});

test('a row hides its own window or ends its session through main', async ({ page }) => {
  await setup(page);
  await expect.poll(() => screenText(page)).toContain('restored-ao-1');
  const first = list(page).locator('li[data-term-session="ao-1"]');
  await first.hover();
  await first.getByRole('button', { name: '창 숨기기' }).click();
  const second = list(page).locator('li[data-term-session="ao-2"]');
  await second.hover();
  // No window of its own: nothing to hide.
  await expect(second.getByRole('button', { name: '창 숨기기' })).toBeDisabled();
  await second.getByRole('button', { name: '종료' }).click();
  await second.getByRole('button', { name: '개별 창' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).acts))
    .toEqual([
      ['ao-1', 'hide'],
      ['ao-2', 'kill'],
      ['ao-2', 'open'],
    ]);
  // An ended session cannot be ended again.
  const ended = list(page).locator('li[data-term-session="ao-3"]');
  await ended.hover();
  await expect(ended.getByRole('button', { name: '종료' })).toBeDisabled();
});
