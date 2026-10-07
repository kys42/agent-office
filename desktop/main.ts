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
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { ServiceBridge } from '../server/bridge.js';
import type { DockAction, DockMode, Session } from '../src/shared/types.js';
import { parseArtifact } from '../src/shared/office.js';
import {
  clampInto,
  FLOOR_HEIGHT,
  ROW_HEIGHT,
  petBounds,
  petFeet,
  readPetSpot,
  rowBounds,
  type Point,
  type Rect,
} from '../src/shared/dock-geometry.js';
let main: BrowserWindow | null = null,
  dock: BrowserWindow | null = null,
  tray: Tray | null = null,
  bridge: ServiceBridge,
  quitting = false;
// Desk pet: presentation-only window state. Office data comes from the same snapshot.
let dockMode: DockMode = 'pet',
  petEnabled = false,
  petSpot: Point | null = null,
  drag: ReturnType<typeof setInterval> | null = null;
const root = path.join(__dirname, '..');
const index = path.join(root, 'dist', 'index.html');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showMain());
  app.whenReady().then(() => {
    bridge = new ServiceBridge(path.join(__dirname, 'worker.cjs'));
    bridge.on('snapshot', (s) => {
      for (const w of [main, dock])
        if (w && !w.isDestroyed()) w.webContents.send('office:snapshot', s);
    });
    bridge.on('failure', (message) => console.error('Collector worker:', message));
    petSpot = loadPetSpot();
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
        { label: '데스크 펫', click: () => showDock('pet') },
        { label: '책상 줄 펼치기', click: () => showDock('row') },
        { label: '바닥 책상 펼치기', click: () => showDock('floor') },
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
    // Displays, resolution or the macOS Dock changed: re-seat the pet/row inside a work area.
    const reseat = () => {
      if (dock && !dock.isDestroyed() && !drag) dock.setBounds(dockBounds(dockMode));
    };
    screen.on('display-removed', reseat);
    screen.on('display-metrics-changed', reseat);
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
      // Someone who keeps the pet gets it back when the big office goes away.
      if (petEnabled) showDock('pet');
    }
  });
}
function showMain(id?: string) {
  if (!main || main.isDestroyed()) createMain();
  stopDrag(false);
  if (dock && !dock.isDestroyed()) dock.hide();
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
const petFile = () =>
  path.join(process.env.AGENT_OFFICE_DATA_DIR ?? app.getPath('userData'), 'desk-pet.json');
function loadPetSpot(): Point | null {
  try {
    return readPetSpot(JSON.parse(readFileSync(petFile(), 'utf8')));
  } catch {
    return null;
  }
}
async function savePetSpot() {
  try {
    await mkdir(path.dirname(petFile()), { recursive: true, mode: 0o700 });
    await writeFile(petFile(), JSON.stringify({ v: 2, ...petSpot }), { mode: 0o600 });
  } catch (e) {
    console.error('Desk pet position:', e);
  }
}
const workAreaFor = (b: Rect) => screen.getDisplayMatching(b).workArea;
function dockBounds(mode: DockMode): Rect {
  // The display under the pet's feet (the nearest one if that display is gone).
  const area = petSpot
    ? workAreaFor({ x: petSpot.x - 1, y: petSpot.y - 1, width: 2, height: 2 })
    : screen.getPrimaryDisplay().workArea;
  const pet = petBounds(petSpot, area);
  // The row (or the floor desks) opens along the bottom of whichever display the pet is on.
  return mode === 'pet' ? pet : rowBounds(area, mode === 'floor' ? FLOOR_HEIGHT : ROW_HEIGHT);
}
function setDockMode(mode: DockMode) {
  stopDrag(false);
  dockMode = mode;
  if (!dock || dock.isDestroyed()) return;
  dock.setBounds(dockBounds(mode));
  // Start see-through; the renderer claims the mouse again over drawn things.
  dock.setIgnoreMouseEvents(true, { forward: true });
  dock.webContents.send('office:dock', mode);
}
function showDock(mode: DockMode = 'pet') {
  petEnabled = true;
  if (!dock || dock.isDestroyed()) {
    dockMode = mode;
    dock = new BrowserWindow({
      ...dockBounds(mode),
      show: false,
      resizable: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    secure(dock);
    dock.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    dock.setIgnoreMouseEvents(true, { forward: true });
    dock.on('closed', () => {
      stopDrag(false);
      dock = null;
    });
    // The renderer follows the main process; tell it the mode it may have missed while loading.
    dock.webContents.on('did-finish-load', () => dock?.webContents.send('office:dock', dockMode));
    void dock.loadFile(index, { hash: mode === 'pet' ? 'mini' : `mini=${mode}` });
  } else setDockMode(mode);
  dock.showInactive();
  main?.hide();
}
// Dragging follows the OS cursor from the main process, so a fast flick never loses the pet.
function startDrag() {
  if (!dock || dock.isDestroyed() || dockMode !== 'pet') return;
  stopDrag(false);
  const cursor = screen.getCursorScreenPoint();
  const [x, y] = dock.getPosition();
  const offset = { x: cursor.x - x, y: cursor.y - y };
  const started = Date.now();
  drag = setInterval(() => {
    if (!dock || dock.isDestroyed() || Date.now() - started > 30_000) return stopDrag(true);
    const c = screen.getCursorScreenPoint();
    dock.setPosition(c.x - offset.x, c.y - offset.y);
  }, 16);
}
function stopDrag(save: boolean) {
  if (!drag) return;
  clearInterval(drag);
  drag = null;
  if (!save || !dock || dock.isDestroyed() || dockMode !== 'pet') return;
  const b = dock.getBounds();
  const fixed = clampInto(b, workAreaFor(b));
  if (fixed.x !== b.x || fixed.y !== b.y) dock.setBounds(fixed);
  const feet = petFeet(fixed);
  if (petSpot?.x === feet.x && petSpot?.y === feet.y) return;
  petSpot = feet;
  void savePetSpot();
}
function trusted(e: Electron.IpcMainInvokeEvent) {
  if (
    ![main?.webContents, dock?.webContents].includes(e.sender) ||
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
    if (action === 'mini') showDock('pet');
    else if (action === 'main') showMain(typeof id === 'string' ? id : undefined);
    else if (action === 'hide') {
      if (e.sender === dock?.webContents) {
        stopDrag(false);
        petEnabled = false;
      }
      BrowserWindow.fromWebContents(e.sender)?.hide();
    } else if (action === 'quit') {
      quitting = true;
      app.quit();
    }
  });
  ipcMain.handle('office:dock', (e, action: DockAction) => {
    trusted(e);
    if (!dock || e.sender !== dock.webContents) throw new Error('허용되지 않은 창입니다.');
    if (action === 'pet' || action === 'row' || action === 'floor') setDockMode(action);
    else if (action === 'drag-start') startDrag();
    else if (action === 'drag-end') stopDrag(true);
    else if (action === 'solid') dock.setIgnoreMouseEvents(false);
    else if (action === 'through') dock.setIgnoreMouseEvents(true, { forward: true });
    else throw new Error('잘못된 요청');
  });
  ipcMain.handle('office:reveal', async (e, id) => {
    trusted(e);
    const s: Session = await bridge.call('detail', [id]);
    shell.showItemInFolder(s.sourcePath);
  });
  ipcMain.handle('office:resume', async (e, id) => {
    trusted(e);
    const s: Session = await bridge.call('detail', [id]);
    if (s.provider === 'codex' && /^[\w-]+$/.test(s.nativeId)) {
      await shell.openExternal(`codex://threads/${s.nativeId}`);
      return 'Codex에서 세션 열기를 요청했어요';
    }
    const quoted = "'" + s.nativeId.replace(/'/g, "'\\''") + "'";
    return s.provider === 'claude' ? `claude --resume ${quoted}` : `OpenClaw 세션: ${s.nativeId}`;
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
app.on('activate', () => showMain());
app.on('before-quit', () => {
  quitting = true;
  void bridge?.close();
});
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});
