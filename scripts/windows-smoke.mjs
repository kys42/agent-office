// Real native window, synthetic records and a disposable profile only.
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
if (process.platform !== 'win32') throw new Error('This smoke test needs a Windows desktop.');
const temp = await mkdtemp(path.join(os.tmpdir(), 'office-windows-'));
await mkdir('.local', { recursive: true });
const project = path.join(temp, 'project');
const claude = path.join(temp, 'claude');
await mkdir(project);
await mkdir(path.join(claude, 'projects', 'fixture'), { recursive: true });
await writeFile(
  path.join(claude, 'projects', 'fixture', 'session.jsonl'),
  [
    {
      type: 'user',
      sessionId: 'windows-fixture',
      timestamp: new Date().toISOString(),
      cwd: project,
      message: { role: 'user', content: 'Windows 창과 작업 표시를 확인해 주세요.' },
    },
    {
      type: 'assistant',
      sessionId: 'windows-fixture',
      timestamp: new Date().toISOString(),
      message: {
        id: 'reply',
        role: 'assistant',
        content: '창 조작과 단축키를 확인하고 있어요.',
        stop_reason: 'end_turn',
      },
    },
  ]
    .map((row) => JSON.stringify(row))
    .join('\n') + '\n',
);
let app;
try {
  app = await electron.launch({
    executablePath: process.env.AGENT_OFFICE_EXECUTABLE,
    args: [
      ...(process.env.AGENT_OFFICE_EXECUTABLE ? [] : ['.']),
      `--user-data-dir=${path.join(temp, 'profile')}`,
    ],
    env: {
      ...process.env,
      AGENT_OFFICE_DATA_DIR: path.join(temp, 'data'),
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: path.join(temp, 'codex'),
      OPENCLAW_STATE_DIR: path.join(temp, 'openclaw'),
      AGENT_OFFICE_SYSTEM_LANGUAGES: 'ko',
    },
  });
  const page = await app.firstWindow();
  const nativeScreenshot = async (file) => {
    const url = await app.evaluate(async ({ desktopCapturer, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: win
          .getSize()
          .reduce((size, n, i) => ({ ...size, [i ? 'height' : 'width']: n }), {}),
      });
      const own = sources.find((source) => source.id === win.getMediaSourceId());
      if (!own || own.thumbnail.isEmpty())
        throw new Error('Cannot capture the synthetic app window');
      return own.thumbnail.toDataURL();
    });
    await writeFile(file, Buffer.from(url.split(',')[1], 'base64'));
  };
  await page.emulateMedia({ colorScheme: null });
  await app.evaluate(async ({ clipboard }) => {
    globalThis.__officeTestClipboard = await clipboard.read();
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.windows-titlebar').waitFor();
  await page.getByRole('button', { name: '직접 둘러볼게요' }).click();
  await page.evaluate(() => window.office.refresh());
  assert.equal(await page.locator('.windows-titlebar').count(), 1);
  const chrome = await page.evaluate(() => ({
    height: document.querySelector('.windows-titlebar').getBoundingClientRect().height,
    safeWidth: document.querySelector('.windows-titlebar').getBoundingClientRect().right,
    width: innerWidth,
    modifier: document.querySelector('.search-trigger')?.textContent,
    font: getComputedStyle(document.body).getPropertyValue('--font-ui'),
  }));
  assert.equal(chrome.height, 36);
  assert.ok(chrome.safeWidth <= chrome.width - 100, 'native caption area stays clear');
  assert.match(chrome.font, /Segoe/);
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible()),
    false,
  );
  // Ctrl+K must still open the palette, and it must not teach Mac shortcuts.
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog').waitFor();
  const input = page.getByRole('dialog').locator('input').first();
  await input.fill('Clipboard selection');
  await input.press('Control+a');
  assert.equal(
    await input.evaluate((el) => el.selectionEnd - el.selectionStart),
    'Clipboard selection'.length,
  );
  await input.press('Control+c');
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'Clipboard selection');
  await page.keyboard.press('Escape');
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'light';
  });
  await page.waitForFunction(() => !matchMedia('(prefers-color-scheme: dark)').matches);
  await page.screenshot({ path: '.local/windows-light.png' });
  await nativeScreenshot('.local/windows-native-light.png');
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'dark';
  });
  await page.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches);
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase(),
    ),
    '#1c1c1e',
  );
  await page.screenshot({ path: '.local/windows-dark.png' });
  await nativeScreenshot('.local/windows-native-dark.png');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()),
    true,
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 740));
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  await page.locator('.windows-support-note').waitFor();
  assert.equal(
    await page
      .locator('.windows-titlebar')
      .evaluate((el) => Math.round(el.getBoundingClientRect().height)),
    36,
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await page.evaluate(() => window.office.window('main'));
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
    false,
  );
  // Clicking the native close keeps the tray application alive; reopening restores the same window.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    false,
  );
  await page.evaluate(() => window.office.window('main'));
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      windowsChrome: true,
      ctrlPaletteAndCopy: true,
      lightDark: true,
      maximizeRestore: true,
      trayCloseReopen: true,
      syntheticOnly: true,
    }),
  );
} finally {
  await app
    ?.evaluate(async ({ clipboard }) => {
      if (
        (await clipboard.readText()) === 'Clipboard selection' &&
        globalThis.__officeTestClipboard
      )
        await clipboard.write(globalThis.__officeTestClipboard);
    })
    .catch(() => {});
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
