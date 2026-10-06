import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  screen,
  shell,
  dialog,
} from 'electron';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { ServiceBridge } from '../server/bridge.js';
import type { JumpResult, Session, Snapshot } from '../src/shared/types.js';
import { parseArtifact } from '../src/shared/office.js';
import {
  focusTerminal,
  forgetTerminal,
  hostName,
  locateTerminal,
  sendToTerminal,
  terminalTarget,
  TerminalInputError,
} from './terminals.js';
let main: BrowserWindow | null = null,
  mini: BrowserWindow | null = null,
  tray: Tray | null = null,
  bridge: ServiceBridge,
  quitting = false,
  terminalSend: boolean | undefined;
const root = path.join(__dirname, '..');
const index = path.join(root, 'dist', 'index.html');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showMain());
  app.whenReady().then(() => {
    bridge = new ServiceBridge(path.join(__dirname, 'worker.cjs'));
    bridge.on('snapshot', (s: Snapshot) => {
      terminalSend = s.preferences?.terminalSend === true;
      for (const w of [main, mini])
        if (w && !w.isDestroyed()) w.webContents.send('office:snapshot', s);
    });
    bridge.on('failure', (message) => console.error('Collector worker:', message));
    createMain();
    setupIPC();
    const icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABXUlEQVQ4T6WTsUoDQRRFz8yuJGKhSLEKCgYK/gMLC5sQv8BCsPEHbCxs7WwsLC3sLSz8BxYSa2uxCIJYCCKCYmwUzGRnHLGZnWQFV3hmzpw7d96bBcEEIAIwBPQBHEWzXxdQB2ABuAK8eAsaASaADWAB2LVNgAkgC+QF2AGWQgCWgCeArYhS2K1ICxzqfwEOI+gjmgGmAW0xDdCUkcSOKuAMQF9EQ0ClCzgFlEVSJr9wAU8BxSLmBRwnDEAzABeAWUKBggaITRXoBgRbVKktsCsA50XMpPMCUFdIj68twDxAb8AOoAfolOEhGnT0EMH2noPnsSqTOIVmIZdGTuOA1V8PqxCAY4AkOmR01YAQdBgXMSbMNTE62CEawEqGwGUyJvrb1+ksHlEGQ6MvCSAaQAuCpTOZY/gjgNP17c/gDKr0jdGwXuMK4FnAUjQYZ4wA75pM3fEn8rwAPcApYOvPCZ3hF1cCPzdlP+RhAAAAAElFTkSuQmCC',
    );
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip('Agent Office · 우리 사무실');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '사무실 열기', click: () => showMain() },
        { label: '미니 오피스', click: () => showMini() },
        { type: 'separator' },
        {
          label: '종료',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on('click', () => showMain());
    screen.on('display-removed', () => {
      if (mini) {
        mini.setPosition(
          screen.getPrimaryDisplay().workArea.x + 30,
          screen.getPrimaryDisplay().workArea.y + 30,
        );
      }
    });
  });
}
function secure(w: BrowserWindow) {
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
}
function createMain() {
  main = new BrowserWindow({
    width: 1440,
    height: 970,
    minWidth: 1050,
    minHeight: 740,
    title: 'Agent Office',
    backgroundColor: '#0d0e11',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 20 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  secure(main);
  void main.loadFile(index);
  main.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      main?.hide();
    }
  });
}
function showMain(id?: string) {
  if (!main || main.isDestroyed()) createMain();
  if (mini && !mini.isDestroyed()) mini.hide();
  const window = main!;
  window.show();
  window.focus();
  if (id) {
    const select = () => {
      if (!window.isDestroyed()) window.webContents.send('office:select', id);
    };
    if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', select);
    else select();
  }
}
function showMini() {
  if (!mini || mini.isDestroyed()) {
    const b = screen.getPrimaryDisplay().workArea;
    mini = new BrowserWindow({
      width: 840,
      height: 218,
      x: Math.round(b.x + (b.width - 840) / 2),
      y: b.y + b.height - 230,
      resizable: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    secure(mini);
    mini.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    void mini.loadFile(index, { hash: 'mini' });
  }
  mini.showInactive();
  main?.hide();
}
function trusted(e: Electron.IpcMainInvokeEvent) {
  if (
    ![main?.webContents, mini?.webContents].includes(e.sender) ||
    e.senderFrame !== e.sender.mainFrame
  )
    throw new Error('허용되지 않은 창입니다.');
}
function setupIPC() {
  ipcMain.handle('office:open-artifact', async (e, url) => {
    trusted(e);
    const artifact = typeof url === 'string' ? parseArtifact(url) : null;
    if (!artifact) throw new Error('지원하지 않는 결과 링크입니다.');
    await shell.openExternal(artifact.url);
  });
  ipcMain.handle('office:call', async (e, m, args) => {
    trusted(e);
    if (typeof m !== 'string' || !Array.isArray(args) || args.length > 3)
      throw new Error('잘못된 요청');
    return bridge.call(m, args);
  });
  ipcMain.handle('office:window', (e, action, id) => {
    trusted(e);
    if (action === 'mini') showMini();
    else if (action === 'main') showMain(typeof id === 'string' ? id : undefined);
    else if (action === 'hide') BrowserWindow.fromWebContents(e.sender)?.hide();
    else if (action === 'quit') {
      quitting = true;
      app.quit();
    }
  });
  ipcMain.handle('office:reveal', async (e, id) => {
    trusted(e);
    const s: Session = await bridge.call('detail', [id]);
    shell.showItemInFolder(s.sourcePath);
  });
  ipcMain.handle('office:resume', async (e, id) => {
    trusted(e);
    return (await resume(await bridge.call('detail', [id]))).text;
  });
  // Live terminals are desktop-only: OfficeService.call is shared with the web preview.
  const live = async (id: unknown, fresh = false) => {
    const s: Session = await bridge.call('detail', [id]);
    return {
      s,
      terminal: s.provider === 'claude' ? await locateTerminal(s.nativeId, { fresh }) : null,
    };
  };
  ipcMain.handle('office:terminal', async (e, id) => {
    trusted(e);
    const { terminal } = await live(id);
    return terminal ? terminalTarget(terminal) : null;
  });
  ipcMain.handle('office:jump', async (e, id): Promise<JumpResult> => {
    trusted(e);
    const { s, terminal } = await live(id, true);
    if (!terminal) return resume(s);
    try {
      return { action: 'focused', text: await focusTerminal(terminal) };
    } catch {
      throw new Error(`${hostName(terminal.host)} 터미널로 이동하지 못했어요.`);
    }
  });
  ipcMain.handle('office:send', async (e, id, text) => {
    trusted(e);
    if (typeof text !== 'string' || text.length > 20000) throw new Error('잘못된 요청');
    if (terminalSend === undefined)
      terminalSend = (await bridge.call('snapshot')).preferences?.terminalSend === true;
    if (!terminalSend) throw new Error('설정에서 ‘터미널로 보내기’를 켜 주세요.');
    const { terminal } = await live(id, true);
    if (!terminal) throw new Error('지금 열려 있는 Orca·tmux 터미널을 찾지 못했어요.');
    try {
      return await sendToTerminal(terminal, text);
    } catch (error) {
      if (error instanceof TerminalInputError) throw error;
      throw new Error(`${hostName(terminal.host)}에 보내지 못했어요. 터미널을 확인해 주세요.`);
    } finally {
      forgetTerminal(terminal.process.sessionId);
    }
  });
  ipcMain.handle('office:export', async (e, name, content) => {
    trusted(e);
    if (typeof content !== 'string' || content.length > 30000 || typeof name !== 'string')
      throw new Error('잘못된 파일 요청');
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const result = await dialog.showSaveDialog(win, {
      defaultPath: path.basename(name).replace(/[^\p{L}\p{N}._ -]/gu, '_'),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, content, { mode: 0o600 });
    return true;
  });
}
async function resume(s: Session): Promise<JumpResult> {
  if (s.provider === 'codex' && /^[\w-]+$/.test(s.nativeId)) {
    await shell.openExternal(`codex://threads/${s.nativeId}`);
    return { action: 'opened', text: 'Codex에서 세션 열기를 요청했어요' };
  }
  const quoted = "'" + s.nativeId.replace(/'/g, "'\\''") + "'";
  return {
    action: 'copy',
    text: s.provider === 'claude' ? `claude --resume ${quoted}` : `OpenClaw 세션: ${s.nativeId}`,
  };
}
app.on('activate', () => showMain());
app.on('before-quit', () => {
  quitting = true;
  void bridge?.close();
});
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});
