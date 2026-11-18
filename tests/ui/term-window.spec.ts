import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

// The built-in terminal's window (#401): one session's view, drawn with xterm. The desktop API
// is stubbed (no daemon, no PTY, no agent): attach answers a restored screen, then live output.
const VIEW = '0b0e2a7c-3a5e-4c58-9d38-5d4e9a1f2b3c';
const VIEW2 = '0b0e2a7c-3a5e-4c58-9d38-5d4e9a1f2b3d';

interface Options {
  exited?: boolean;
  /** Before the attach answer: the session's last output (with `exitEarly`), its exit. */
  exitEarly?: boolean;
  /** Before the attach answer: a fresh screen from the daemon. */
  resyncEarly?: boolean;
  /** The window hides right after the answer, while its first screen is parsed. */
  hideDuringRestore?: boolean;
  /** Before the attach answer: more output than the view lets queue undrawn. */
  floodEarly?: boolean;
}

async function setup(page: Page, options: Options = {}) {
  const s = demoSnapshot();
  await page.setViewportSize({ width: 640, height: 400 });
  await page.addInitScript(
    ({ s, VIEW, VIEW2, exited, exitEarly, resyncEarly, hideDuringRestore, floodEarly }) => {
      const w = window as any;
      w.commands = [];
      w.inputs = [];
      w.windowCalls = [];
      localStorage.setItem('office:onboarding:v1:live', 'seen');
      const data = new Set<(id: string, d: Uint8Array) => void>();
      const exits = new Set<(id: string, e: unknown) => void>();
      const resyncs = new Set<(id: string, r: string, cols: number, rows: number) => void>();
      const losts = new Set<(id: string) => void>();
      w.resync = (restore: string, cols = 80, rows = 20) =>
        resyncs.forEach((cb) => cb(w.viewId(), restore, cols, rows));
      w.lose = () => losts.forEach((cb) => cb(w.viewId()));
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
              // The session ends right as it attaches: its last output and exit come first.
              if (exitEarly) {
                w.emit('\r\nfinal-output');
                w.exit();
              } else if (resyncEarly) w.resync('\x1b[Hearly-fresh-screen', 80, 20);
              else if (floodEarly) w.emit('flood '.repeat(60_000));
              else if (!exited) setTimeout(() => w.emit('\r\nlive-after-attach'), 0);
              if (hideDuringRestore) setTimeout(() => w.setHidden(true), 0);
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
          onResync: (cb: any) => {
            resyncs.add(cb);
            return () => resyncs.delete(cb);
          },
          onLost: (cb: any) => {
            losts.add(cb);
            return () => losts.delete(cb);
          },
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
    {
      s,
      VIEW,
      VIEW2,
      exited: !!options.exited,
      exitEarly: !!options.exitEarly,
      resyncEarly: !!options.resyncEarly,
      hideDuringRestore: !!options.hideDuringRestore,
      floodEarly: !!options.floodEarly,
    },
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

test('a fresh screen from the daemon replaces what was drawn, after what was queued', async ({
  page,
}) => {
  await setup(page);
  await expect.poll(() => screenText(page)).toContain('live-after-attach');
  await page.evaluate(() => {
    const w = window as any;
    w.emit('\r\nqueued-before-resync');
    w.resync('\x1b[Hfresh-screen-only');
  });
  await expect.poll(() => screenText(page)).toContain('fresh-screen-only');
  const text = await screenText(page);
  expect(text).not.toContain('restored-screen');
  expect(text).not.toContain('queued-before-resync');
});

test('an exit that arrives before the attach answer still ends the view, after its last output', async ({
  page,
}) => {
  await setup(page, { exitEarly: true });
  await expect(page.getByRole('status')).toHaveText('에이전트가 끝났어요.');
  await expect.poll(() => screenText(page)).toContain('final-output');
  await page.locator('.xterm').click();
  await page.keyboard.type('x');
  expect(await page.evaluate(() => (window as any).inputs.length)).toBe(0);
});

test('a lost connection says so and attaches again', async ({ page }) => {
  await setup(page);
  await expect.poll(() => screenText(page)).toContain('live-after-attach');
  await page.evaluate(() => (window as any).lose());
  await expect(page.getByRole('alert')).toContainText('내장 터미널과 연결이 끊겼어요');
  await expect
    .poll(async () => (await commands(page)).filter((c: any) => c.type === 'attach').length)
    .toBe(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a fresh screen that arrives before the attach answer is not lost', async ({ page }) => {
  await setup(page, { resyncEarly: true });
  await expect.poll(() => screenText(page)).toContain('early-fresh-screen');
  expect(await screenText(page)).not.toContain('restored-screen');
});

test('hidden while its first screen is parsed, it lets go instead of going live', async ({
  page,
}) => {
  await setup(page, { hideDuringRestore: true });
  await expect
    .poll(async () => (await commands(page)).find((c: any) => c.type === 'detach')?.viewId)
    .toBe(VIEW);
  await expect(page.getByRole('status')).toContainText('창이 가려진 동안은 멈춰 있어요');
  await page.evaluate(() => (window as any).setHidden(false));
  await expect
    .poll(async () => (await commands(page)).filter((c: any) => c.type === 'attach').length)
    .toBe(2);
});

test('output that floods in before the attach answer still pauses this view', async ({ page }) => {
  await setup(page, { floodEarly: true });
  await expect
    .poll(async () =>
      (await commands(page)).some((c: any) => c.type === 'flow' && c.paused && c.viewId === VIEW),
    )
    .toBe(true);
});
