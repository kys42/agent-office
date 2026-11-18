import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

// The built-in terminal's window (#401): one session's view, drawn with xterm. The desktop API
// is stubbed (no daemon, no PTY, no agent): attach answers a restored screen, then live output.
const VIEW = '0b0e2a7c-3a5e-4c58-9d38-5d4e9a1f2b3c';
const VIEW2 = '0b0e2a7c-3a5e-4c58-9d38-5d4e9a1f2b3d';

async function setup(page: Page, options: { exited?: boolean } = {}) {
  const s = demoSnapshot();
  await page.setViewportSize({ width: 640, height: 400 });
  await page.addInitScript(
    ({ s, VIEW, VIEW2, exited }) => {
      const w = window as any;
      w.commands = [];
      w.inputs = [];
      w.windowCalls = [];
      localStorage.setItem('office:onboarding:v1:live', 'seen');
      const data = new Set<(id: string, d: Uint8Array) => void>();
      const exits = new Set<(id: string, e: unknown) => void>();
      let attaches = 0;
      w.viewId = () => (attaches > 1 ? VIEW2 : VIEW);
      w.emit = (text: string) =>
        data.forEach((cb) => cb(w.viewId(), new TextEncoder().encode(text)));
      w.exit = () => exits.forEach((cb) => cb(w.viewId(), { code: 0, signal: null }));
      // The page as a hidden window sees it (minimised, another space).
      w.hidden = false;
      Object.defineProperty(document, 'visibilityState', {
        get: () => (w.hidden ? 'hidden' : 'visible'),
      });
      w.setHidden = (hidden: boolean) => {
        w.hidden = hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      };
      w.office = {
        snapshot: async () => structuredClone(s),
        subscribe: () => () => {},
        visit: async () => structuredClone(s),
        artifacts: async () => [],
        term: {
          command: async (c: any) => {
            w.commands.push(c.type === 'resize' ? 'resize' : c);
            if (c.type === 'attach') {
              attaches++;
              if (!exited) setTimeout(() => w.emit('\r\nlive-after-attach'), 0);
              return {
                viewId: w.viewId(),
                restore: '\x1b[?2026hrestored-screen ❯\x1b[?2026l',
                cols: 80,
                rows: 20,
                ...(exited && { exited: { code: 0, signal: null } }),
              };
            }
            if (c.type === 'kill') return w.confirmKill ?? false;
          },
          input: (id: string, d: string) => w.inputs.push([id, d]),
          onData: (cb: any) => {
            data.add(cb);
            return () => data.delete(cb);
          },
          onResync: () => () => {},
          onExit: (cb: any) => {
            exits.add(cb);
            return () => exits.delete(cb);
          },
          window: async (what: string) => {
            w.windowCalls.push(what);
            if (what === 'target')
              return { session: 'ao-1', title: 'claude · example', cwd: '/projects/example' };
            if (what === 'top') return false;
          },
        },
      };
    },
    { s, VIEW, VIEW2, exited: !!options.exited },
  );
  await page.goto('/#term');
}

const screenText = (page: Page) => page.locator('.xterm-rows').innerText();
const commands = (page: Page) => page.evaluate(() => (window as any).commands);

test('a built-in terminal window draws the restored screen, then live output, and types back', async ({
  page,
}) => {
  await setup(page);
  const view = page.getByRole('region', { name: '내장 터미널' });
  await expect(view.getByText('claude · example')).toBeVisible();
  await expect(view.getByText('/projects/example')).toBeVisible();
  await expect.poll(() => screenText(page)).toContain('restored-screen');
  await expect.poll(() => screenText(page)).toContain('live-after-attach');
  const attach = (await commands(page)).find((c: any) => c.type === 'attach');
  expect(attach.cols).toBeGreaterThan(10);
  expect(attach).not.toHaveProperty('session');
  await page.locator('.xterm').click();
  await page.keyboard.type('hi');
  await expect
    .poll(() => page.evaluate(() => (window as any).inputs.map((i: any) => i.join(':')).join(',')))
    .toContain(`${VIEW}:h`);
  await page.screenshot({ path: '.local/term-window.png', animations: 'disabled' });
});

test('hidden, it detaches and nothing streams; shown again, it attaches afresh', async ({
  page,
}) => {
  await setup(page);
  await expect.poll(() => screenText(page)).toContain('live-after-attach');
  await page.evaluate(() => (window as any).setHidden(true));
  await expect
    .poll(async () => (await commands(page)).some((c: any) => c.type === 'detach'))
    .toBe(true);
  expect((await commands(page)).find((c: any) => c.type === 'detach').viewId).toBe(VIEW);
  await expect(page.getByRole('status')).toContainText('창이 가려진 동안은 멈춰 있어요');
  await page.evaluate(() => (window as any).setHidden(false));
  await expect
    .poll(async () => (await commands(page)).filter((c: any) => c.type === 'attach').length)
    .toBe(2);
  await page.locator('.xterm').click();
  await page.keyboard.type('x');
  await expect.poll(() => page.evaluate(() => (window as any).inputs.at(-1)?.[0])).toBe(VIEW2);
});

test('the end button asks main (which confirms) and the view says when the agent ended', async ({
  page,
}) => {
  await setup(page);
  await expect.poll(() => screenText(page)).toContain('live-after-attach');
  await page.evaluate(() => ((window as any).confirmKill = true));
  await page.getByRole('button', { name: '종료' }).click();
  await expect
    .poll(async () => (await commands(page)).some((c: any) => c.type === 'kill'))
    .toBe(true);
  await page.evaluate(() => (window as any).exit());
  await expect(page.getByRole('status')).toHaveText('에이전트가 끝났어요.');
  await expect(page.getByRole('button', { name: '종료' })).toBeDisabled();
});

test('an ended session shows its last screen and attaches nothing', async ({ page }) => {
  await setup(page, { exited: true });
  await expect.poll(() => screenText(page)).toContain('restored-screen');
  await expect(page.getByRole('status')).toHaveText('에이전트가 끝났어요.');
  await page.locator('.xterm').click();
  await page.keyboard.type('x');
  expect(await page.evaluate(() => (window as any).inputs.length)).toBe(0);
  expect((await commands(page)).filter((c: any) => c.type === 'detach')).toHaveLength(0);
});

test('closing the window goes through main (the session keeps running)', async ({ page }) => {
  await setup(page);
  await expect.poll(() => screenText(page)).toContain('restored-screen');
  await page.getByRole('button', { name: '닫기 (계속 실행)' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).windowCalls)).toContain('close');
});
