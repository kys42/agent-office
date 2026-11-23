import { test, expect, type Page } from '@playwright/test';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import headless from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import {
  connectTermHost,
  type ConnectOptions,
  type TermHostClient,
} from '../../desktop/term-host/client';
import { TermViews } from '../../desktop/term-views';

// The built-in terminal end to end (#401): a real daemon in a temporary folder, a real PTY
// running an Ink-like program (tests/fixtures/term/ink-like.mjs), main's view service, and the
// window's xterm. Only Electron's IPC is replaced by Playwright's bridge.

const nodePty = (() => {
  try {
    createRequire(import.meta.url)(['node', 'pty'].join('-'));
    return true;
  } catch {
    return false;
  }
})();
test.skip(!nodePty || process.platform === 'win32', 'needs node-pty and a POSIX PTY');

const KO =
  '아니 이런 경우에는 어떻게 해야 하나요? 터미널에 긴 한국어 문단을 붙여 넣으면 입력창 아래쪽이 깨져 보입니다. ' +
  '커서가 오른쪽으로 더 가지 않는 것 같고 글이 잘려 보여요. 창 크기를 바꾸면 다시 제대로 나옵니다. ';

interface Rig {
  dataDir: string;
  client: TermHostClient;
  views: TermViews;
  session: string;
  log: string;
  /** Raw bytes main sent to the window, in order (what the view parsed). */
  sent: { data: number; resync: number; pauses: number };
  /** The window's live view, once attached. */
  view: { id: string; held: boolean; onAttach?: () => Promise<void> };
}

async function start(page: Page, extraEnv: Record<string, string> = {}): Promise<Rig> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'th-paste-'));
  const options: ConnectOptions = {
    dataDir,
    daemon: {
      execPath: process.execPath,
      args: ['--import', import.meta.resolve('tsx'), path.resolve('desktop/term-host/daemon.ts')],
    },
    daemonOptions: { idleMs: 3_000 },
    timeoutMs: 20_000,
    clientName: 'ui-test',
  };
  const client = await connectTermHost(options);
  const log = path.join(dataDir, 'ink.log');
  writeFileSync(log, '');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dataDir,
    TERM: 'xterm-256color',
    LANG: 'ko_KR.UTF-8',
    INK_LOG: log,
    INK_HISTORY: '2000',
    ...extraEnv,
  };
  const stats = await client.create({
    argv: [process.execPath, path.resolve('tests/fixtures/term/ink-like.mjs')],
    cwd: dataDir,
    env,
    cols: 200,
    rows: 50,
  });
  const sent = { data: 0, resync: 0, pauses: 0 };
  const view: Rig['view'] = { id: '', held: false };
  const views = new TermViews({ connect: () => connectTermHost(options) });
  // Main → window, in order (Electron's IPC keeps one order across channels).
  let chain = Promise.resolve();
  const push = (kind: string, ...args: unknown[]) => {
    // Not awaited one by one: like Electron's IPC, main never waits for the window to draw.
    const sent = page
      .evaluate(([kind, args]) => (window as any).__push(kind, args), [kind, args] as const)
      .catch(() => {});
    chain = chain.then(() => sent);
  };
  const sink = {
    data: (viewId: string, data: Uint8Array) => {
      sent.data += data.length;
      push('data', viewId, Buffer.from(data).toString('base64'));
    },
    resync: (viewId: string, restore: string, cols: number, rows: number) => {
      sent.resync++;
      push('resync', viewId, restore, cols, rows);
    },
    exit: (viewId: string) => push('exit', viewId),
    lost: (viewId: string) => push('lost', viewId),
  };
  const OWNER = 1;
  await page.exposeFunction('__termCommand', async (c: any) => {
    if (c.type === 'attach') {
      const a = await views.attach(OWNER, stats.id, { cols: c.cols, rows: c.rows }, sink);
      view.id = a.viewId;
      await view.onAttach?.();
      await chain;
      return a;
    }
    if (c.type === 'resize') return views.resize(OWNER, c.viewId, c.cols, c.rows);
    if (c.type === 'flow' && c.paused) sent.pauses++;
    // While the test holds the view's reading, the window's own resume must not undo it.
    if (c.type === 'flow' && view.held) return;
    if (c.type === 'flow') return views.flow(OWNER, c.viewId, c.paused);
    if (c.type === 'detach') return views.detach(OWNER, c.viewId);
  });
  await page.exposeFunction('__termInput', (viewId: string, data: string) =>
    views.write(OWNER, viewId, data),
  );
  const s = demoSnapshot();
  await page.addInitScript((s) => {
    const w = window as any;
    localStorage.setItem('office:onboarding:v1:live', 'seen');
    const subs: Record<string, Set<(...a: any[]) => void>> = {
      data: new Set(),
      resync: new Set(),
      exit: new Set(),
      lost: new Set(),
    };
    const on = (kind: string) => (cb: any) => {
      subs[kind].add(cb);
      return () => subs[kind].delete(cb);
    };
    w.__push = (kind: string, args: any[]) => {
      if (kind === 'data') {
        const bytes = Uint8Array.from(atob(args[1]), (c) => c.charCodeAt(0));
        subs.data.forEach((cb) => cb(args[0], bytes));
      } else subs[kind].forEach((cb) => cb(...args));
    };
    w.office = {
      snapshot: async () => structuredClone(s),
      subscribe: () => () => {},
      visit: async () => structuredClone(s),
      artifacts: async () => [],
      term: {
        command: (c: any) => w.__termCommand(c),
        input: (id: string, d: string) => void w.__termInput(id, d),
        onData: on('data'),
        onResync: on('resync'),
        onExit: on('exit'),
        onLost: on('lost'),
        window: async (what: string) => {
          if (what === 'target')
            return { session: 'ao-1', title: 'claude · paste', cwd: '/projects/paste' };
          if (what === 'top') return false;
        },
      },
    };
  }, s);
  return { dataDir, client, views, session: stats.id, log, sent, view };
}

async function stop(rig: Rig) {
  rig.views.dispose();
  await rig.client.shutdown().catch(() => {});
  rig.client.destroy();
  await rm(rig.dataDir, { recursive: true, force: true });
}

/** The rows the window shows (drawn DOM) and its xterm buffer. */
const viewRows = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.xterm-rows > div')).map((r) =>
      (r.textContent ?? '').replace(/ /g, ' ').replace(/ +$/, ''),
    ),
  );

async function paste(page: Page, text: string) {
  await page.evaluate((text) => {
    const area = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    area.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    area.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, text);
}

const KOREAN_PASTE = Array.from({ length: 12 }, () => KO.repeat(3)).join('\n\n');
const SHORT_PASTE = [KO.repeat(2), KO].join('\n\n');
const charCount = (text: string) => `${[...text.replace(/\r\n?/g, '\n')].length} chars`;

/** Waits for the program to show `want`, then for the window to show what the daemon shows. */
async function settle(page: Page, rig: Rig, want: string) {
  const daemonRows = async () => (await rig.client.screen(rig.session)).lines;
  await expect
    .poll(() => daemonRows().then((r) => r.join('\n')), { timeout: 30_000 })
    .toContain(want);
  // The program draws for as many rows as the window shows.
  await expect
    .poll(async () => (await rig.client.screen(rig.session)).rows)
    .toBe((await viewRows(page)).length);
  await expect
    .poll(
      async () => {
        const [v, d] = [await viewRows(page), await daemonRows()];
        return v.join('\n') === d.join('\n')
          ? 'same'
          : `view:\n${v.join('\n')}\n---daemon:\n${d.join('\n')}`;
      },
      { timeout: 10_000 },
    )
    .toBe('same');
}

test('a long Korean paste into an Ink-like program draws what the program drew', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 900, height: 560 });
  const rig = await start(page);
  try {
    // A slow window: what it has not drawn yet piles up and pauses its connection.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto('/#term');
    await expect.poll(() => viewRows(page).then((r) => r.join('\n'))).toContain('for shortcuts');
    await paste(page, KOREAN_PASTE);
    await settle(page, rig, charCount(KOREAN_PASTE));
    // Hangul fills its two cells: the gap xterm adds after each syllable stays small (with the
    // plain fallback font it was about 4.4px at 13px, which reads as "아 니 이 런").
    const gap = await page.evaluate(() => {
      const span = Array.from(document.querySelectorAll('.xterm-rows span')).find((s) =>
        /[가-힣]/.test(s.textContent ?? ''),
      );
      return span ? parseFloat(getComputedStyle(span).letterSpacing) : NaN;
    });
    console.log('hangul gap', gap);
    expect(gap).toBeLessThan(2);
    await page.screenshot({ path: '.local/term-paste.png' });
  } finally {
    await stop(rig);
  }
});

test('a window whose height settles while it attaches gives the program its final size', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 900, height: 560 });
  const rig = await start(page);
  try {
    // The window is still being laid out (its saved size applied, half a row more or less)
    // while the attach answer and its nudge are on their way.
    rig.view.onAttach = async () => {
      await page.setViewportSize({ width: 880, height: 523 });
      await page.setViewportSize({ width: 860, height: 517 });
    };
    await page.goto('/#term');
    await expect.poll(() => viewRows(page).then((r) => r.join('\n'))).toContain('for shortcuts');
    await paste(page, SHORT_PASTE);
    await settle(page, rig, charCount(SHORT_PASTE));
  } finally {
    await stop(rig);
  }
});

test('after the view fell behind and got a fresh screen, the input box is drawn right', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 900, height: 560 });
  // The program parks its cursor at the typed text and restores the frame's end before the
  // next redraw (DECSC/DECRC): state a serialized screen does not carry.
  const rig = await start(page, { INK_CARET: '1', INK_HISTORY: '6000' });
  try {
    await page.goto('/#term');
    await expect.poll(() => viewRows(page).then((r) => r.join('\n'))).toContain('for shortcuts');
    await expect.poll(() => rig.view.id).not.toBe('');
    // The window stops reading (as when it is far behind) while the program redraws a lot:
    // the daemon drops this view's backlog and sends a fresh screen once it reads again.
    rig.view.held = true;
    rig.views.flow(1, rig.view.id, true);
    await paste(page, SHORT_PASTE);
    for (let i = 0; i < 12; i++) rig.views.write(1, rig.view.id, '\x06');
    await expect
      .poll(async () => (await rig.client.screen(rig.session)).lines.join('\n'), {
        timeout: 30_000,
      })
      .toContain(`${charCount(SHORT_PASTE)} · 12 answers`);
    rig.view.held = false;
    rig.views.flow(1, rig.view.id, false);
    await expect.poll(() => rig.sent.resync).toBeGreaterThan(0);
    // Typing goes on after the fresh screen: the next frames redraw from where the program
    // left its cursor.
    const more = SHORT_PASTE + '추가로 입력한 줄입니다.';
    await paste(page, '추가로 입력한 줄입니다.');
    await settle(page, rig, charCount(more));
    await page.screenshot({ path: '.local/term-paste-resync.png' });
  } finally {
    await stop(rig);
  }
});
