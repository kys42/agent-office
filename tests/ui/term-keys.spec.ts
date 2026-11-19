import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

// Mac terminal feel in both terminal windows (TermChrome.tsx): editing keys, ⌘ shortcuts, find,
// text size, the right-click menu and dropped files. The desktop API is stubbed (no daemon, no
// tmux, no PTY); the page reports a Mac so the Mac keys apply on any CI host.
const VIEW = '0b0e2a7c-3a5e-4c58-9d38-5d4e9a1f2b3c';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
test.use({ userAgent: MAC_UA });

async function setup(page: Page, route: '#term' | '#shell' = '#term') {
  const s = demoSnapshot();
  await page.setViewportSize({ width: 640, height: 400 });
  await page.addInitScript(
    ({ s, VIEW }) => {
      const w = window as any;
      w.commands = [];
      w.inputs = [];
      w.pastes = 0;
      w.opened = [];
      localStorage.setItem('office:onboarding:v1:live', 'seen');
      window.open = ((url: string) => {
        w.opened.push(url);
        return null;
      }) as typeof window.open;
      const data = new Set<(id: string, d: any) => void>();
      w.emit = (text: string) => data.forEach((cb) => cb(VIEW, text));
      const on = (set: Set<any>) => (cb: any) => {
        set.add(cb);
        return () => set.delete(cb);
      };
      const view = {
        input: (id: string, d: string) => w.inputs.push([id, d]),
        onData: on(data),
        onExit: on(new Set()),
      };
      w.office = {
        snapshot: async () => structuredClone(s),
        subscribe: () => () => {},
        visit: async () => structuredClone(s),
        artifacts: async () => [],
        termView: {
          paste: async () => {
            w.pastes++;
          },
          pathForFile: (f: File) => `/tmp/drop/${f.name}`,
        },
        term: {
          ...view,
          command: async (c: any) => {
            w.commands.push(c.type === 'resize' ? 'resize' : c);
            if (c.type === 'attach') {
              setTimeout(() => w.emit('\r\nsee https://example.com/docs here'), 0);
              return { viewId: VIEW, restore: 'restored-screen ❯', cols: 80, rows: 20 };
            }
          },
          onResync: on(new Set()),
          onLost: on(new Set()),
          window: async (what: string) => {
            if (what === 'target')
              return { session: 'ao-1', title: 'claude · example', cwd: '/projects/example' };
            if (what === 'top') return false;
          },
        },
        shell: {
          ...view,
          command: async (c: any) => {
            w.commands.push(c.type === 'resize' ? 'resize' : c);
            if (c.type === 'list') return [];
            if (c.type === 'open' || c.type === 'attach') {
              setTimeout(() => w.emit('mini-shell-ready$ '), 0);
              return { ptyId: VIEW, name: 'shell-0123456789abcdef', cwd: '/projects/example' };
            }
          },
          window: async (action: string) => {
            if (action === 'target') return { id: s.sessions[0].id, cwd: '/projects/example' };
            if (action === 'top') return false;
          },
        },
      };
    },
    { s, VIEW },
  );
  await page.goto(`/${route}`);
  await expect.poll(() => page.locator('.xterm-rows').innerText()).toMatch(/restored|ready/);
  await page.locator('.xterm').click();
}

const typed = (page: Page) =>
  page.evaluate(() => (window as any).inputs.map((i: [string, string]) => i[1]).join(''));
const reset = (page: Page) => page.evaluate(() => ((window as any).inputs = []));

test('Option and ⌘ editing keys send what zsh and Claude Code read as word and line moves', async ({
  page,
}) => {
  await setup(page);
  for (const [keys, seq] of [
    ['Alt+ArrowLeft', '\x1bb'],
    ['Alt+ArrowRight', '\x1bf'],
    ['Meta+ArrowLeft', '\x01'],
    ['Meta+ArrowRight', '\x05'],
    ['Alt+Backspace', '\x1b\x7f'],
    ['Meta+Backspace', '\x15'],
    ['Alt+Delete', '\x1bd'],
  ]) {
    await reset(page);
    await page.keyboard.press(keys);
    await expect.poll(() => typed(page), keys).toBe(seq);
  }
  // ⌘C with nothing selected never becomes ^C; plain keys still type.
  await reset(page);
  await page.keyboard.press('Meta+c');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => typed(page)).toBe('\x1b[D');
});

test('the mini terminal gets the same keys', async ({ page }) => {
  await setup(page, '#shell');
  await reset(page);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => typed(page)).toBe('\x1bb');
});

test('⌘F finds in the scrollback; Enter steps, Esc closes back to the terminal', async ({
  page,
}) => {
  await setup(page);
  await expect.poll(() => page.locator('.xterm-rows').innerText()).toContain('example.com');
  await page.keyboard.press('Meta+f');
  const find = page.getByRole('textbox', { name: '찾기' });
  await expect(find).toBeFocused();
  await find.fill('restored');
  await expect(page.getByRole('search')).toContainText('1/1');
  await find.press('Enter');
  await find.fill('nothing-like-this');
  await expect(page.getByRole('search')).toContainText('찾는 글자가 없어요');
  await find.press('Escape');
  await expect(page.getByRole('search')).toHaveCount(0);
  await reset(page);
  await page.keyboard.press('x');
  await expect.poll(() => typed(page)).toBe('x');
});

test('⌘= / ⌘- / ⌘0 change the text size, remembered for the next window', async ({ page }) => {
  await setup(page);
  const size = () => page.evaluate(() => localStorage.getItem('office:term-font-size'));
  await page.keyboard.press('Meta+Equal');
  await page.keyboard.press('Meta+Equal');
  await expect.poll(size).toBe('14');
  await expect(page.getByRole('status').filter({ hasText: '글자 크기 14px' })).toBeVisible();
  await page.keyboard.press('Meta+Minus');
  await expect.poll(size).toBe('13');
  await page.reload();
  await expect.poll(() => page.locator('.xterm-rows').innerText()).toContain('restored');
  expect(
    await page.evaluate(() => getComputedStyle(document.querySelector('.xterm-rows')!).fontSize),
  ).toBe('13px');
  await page.locator('.xterm').click();
  await page.keyboard.press('Meta+0');
  await expect.poll(size).toBe(null);
  expect(await typed(page)).toBe('');
});

test('right-click offers copy, paste, select all and clear selection', async ({ page }) => {
  await setup(page);
  await page.locator('.xterm-screen').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText([
    '복사',
    '붙여넣기',
    '모두 선택',
    '선택 해제',
  ]);
  await menu.getByRole('menuitem', { name: '모두 선택' }).click();
  await expect(menu).toHaveCount(0);
  await page.locator('.xterm-screen').click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: '복사' })).toBeEnabled();
  await menu.getByRole('menuitem', { name: '붙여넣기' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).pastes)).toBe(1);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('a dropped file types its shell-quoted path', async ({ page }) => {
  await setup(page);
  await reset(page);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], "it's a.txt"));
    dt.items.add(new File(['y'], 'b.png'));
    const target = document.querySelector('.xterm')!;
    target.dispatchEvent(
      new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
    target.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  });
  await expect.poll(() => typed(page)).toBe(`'/tmp/drop/it'\\''s a.txt' '/tmp/drop/b.png' `);
});

test('⌘-click opens a web link in the browser; a plain click does not', async ({ page }) => {
  await setup(page);
  await expect.poll(() => page.locator('.xterm-rows').innerText()).toContain('example.com');
  const row = page.locator('.xterm-rows > div').filter({ hasText: 'example.com' });
  const box = (await row.boundingBox())!;
  const cell = box.width / 80;
  // "see " is 4 cells: the link starts at the 5th.
  const at = { x: box.x + cell * 8.5, y: box.y + box.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
  expect(await page.evaluate(() => (window as any).opened)).toEqual([]);
  await page.keyboard.down('Meta');
  await page.mouse.move(at.x + 1, at.y);
  await page.mouse.click(at.x + 1, at.y);
  await page.keyboard.up('Meta');
  await expect
    .poll(() => page.evaluate(() => (window as any).opened))
    .toEqual(['https://example.com/docs']);
});
