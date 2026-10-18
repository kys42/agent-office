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
  clipboard,
} from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ServiceBridge } from '../server/bridge.js';
import { isRemoteId } from '../src/shared/federation.js';
import { syncLocale } from '../server/locale.js';
import type {
  AnswerResult,
  AnswerSetting,
  AnswerSettings,
  InputRequest,
  CardTarget,
  PromptView,
  SessionDetail,
  DockAction,
  DockMode,
  JumpResult,
  SendResult,
  Session,
  SessionIdentity,
  Snapshot,
} from '../src/shared/types.js';
import { parseArtifact } from '../src/shared/office.js';
import { m, setLocale } from '../src/shared/i18n/index.js';
import { webLink } from '../src/shared/links.js';
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
import {
  focusTerminal,
  forgetTerminal,
  hostName,
  locateTerminal,
  sendToTerminal,
  inspectTerminalDraft,
  terminalTarget,
  TerminalInputError,
} from './terminals.js';
import { codexTarget, findCodexThread, queueToCodex } from './codex-queue.js';
import { findCodexTerminal } from './codex-focus.js';
import { composerFor } from './composer/index.js';
import { promptsFor } from './prompts/index.js';
import { answerRequest, decodeSetting, inspectPrompt } from './answers.js';
import type { PromptTarget } from './prompts/types.js';
import { openRequest } from '../src/shared/requests.js';
import { SnapshotDelivery, type Viewer } from './delivery.js';
import { CardWindows } from './card-windows.js';
import type { SnapshotPatch } from '../src/shared/snapshot-patch.js';
let main: BrowserWindow | null = null,
  dock: BrowserWindow | null = null,
  tray: Tray | null = null,
  bridge: ServiceBridge,
  quitting = false;
let cards: CardWindows;
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
    // The collector worker inherits this: `auto` then follows the OS language list, not just LANG.
    process.env.AGENT_OFFICE_SYSTEM_LANGUAGES ??= app.getPreferredSystemLanguages().join(',');
    // System language until the first snapshot brings the saved preference.
    syncLocale(undefined);
    // Use the same art as the bundle even when macOS remembers an older Dock icon.
    if (process.platform === 'darwin') app.dock?.setIcon(path.join(root, 'dist', 'icon.png'));
    bridge = new ServiceBridge(path.join(__dirname, 'worker.cjs'));
    cards = new CardWindows({
      index,
      preload: path.join(__dirname, 'preload.cjs'),
      dir: process.env.AGENT_OFFICE_DATA_DIR ?? app.getPath('userData'),
      secure,
      watch,
    });
    app.on('before-quit', () => cards.dispose());
    const windows = () =>
      [main, dock, ...cards.windows()]
        .filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
        .map(viewer);
    // Follow the language the collector actually resolved, so tray and windows always agree.
    const followLanguage = (s: Snapshot) => {
      if (s.locale ? setLocale(s.locale) : syncLocale(s.preferences?.locale)) buildTray();
    };
    const publish = (s: Snapshot) => {
      followLanguage(s);
      delivery.publish(s, windows());
    };
    bridge.on('snapshot', publish);
    bridge.on('patch', (patch: SnapshotPatch) => {
      if (delivery.update(patch, windows())) followLanguage(delivery.latest!);
      // A change that does not start from what is held here (e.g. the collector restarted).
      else void bridge.call('snapshot').then(publish, () => {});
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
    buildTray();
    tray.on('click', () => showMain());
    // Displays, resolution or the macOS Dock changed: re-seat the pet/row inside a work area.
    const reseat = () => {
      if (dock && !dock.isDestroyed() && !drag) dock.setBounds(dockBounds(dockMode));
      cards.reseat();
    };
    screen.on('display-removed', reseat);
    screen.on('display-metrics-changed', reseat);
  });
}
/** Tray labels are rebuilt whenever the office language changes. */
function buildTray() {
  if (!tray || tray.isDestroyed()) return;
  const t = m().desktop.tray;
  tray.setToolTip(t.tooltip);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t.open, click: () => showMain() },
      { label: t.pet, click: () => showDock('pet') },
      { label: t.row, click: () => showDock('row') },
      { label: t.floor, click: () => showDock('floor') },
      { type: 'separator' },
      {
        label: t.quit,
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}
const delivery = new SnapshotDelivery();
const onScreen = (w: BrowserWindow) => !w.isDestroyed() && w.isVisible() && !w.isMinimized();
const viewers = new WeakMap<BrowserWindow, Viewer>();
function viewer(w: BrowserWindow): Viewer {
  let v = viewers.get(w);
  if (!v) {
    const id = w.webContents.id;
    v = {
      id,
      shown: () => onScreen(w),
      send: (s) => w.webContents.send('office:snapshot', s),
    };
    viewers.set(w, v);
  }
  return v;
}
/**
 * Snapshots go only to windows on screen (`document.hidden` is not reliable for a hidden
 * Electron window), and the page is told when it shows or hides so its clocks and polls rest.
 */
function watch(w: BrowserWindow) {
  const v = viewer(w);
  const tell = () => {
    if (w.isDestroyed()) return;
    w.webContents.send('office:visibility', onScreen(w));
    delivery.reveal(v);
  };
  w.on('show', tell);
  w.on('hide', tell);
  w.on('minimize', tell);
  w.on('restore', tell);
  w.on('closed', () => delivery.forget(v.id));
}
function secure(w: BrowserWindow) {
  // A web page link (target=_blank) opens in the browser; nothing opens inside the app.
  w.webContents.setWindowOpenHandler(({ url }) => {
    const link = webLink(url);
    if (link) void shell.openExternal(link);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  // Electron has no right-click menu of its own: copy what is selected, and handle links.
  // Built on each click, so the labels follow the current language.
  w.webContents.on('context-menu', (_e, params) => {
    const t = m().desktop.menu;
    const link = webLink(params.linkURL);
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (link)
      items.push(
        { label: t.openLink, click: () => void shell.openExternal(link) },
        { label: t.copyLink, click: () => clipboard.writeText(link) },
        { type: 'separator' },
      );
    if (params.isEditable)
      items.push(
        { label: t.cut, role: 'cut', enabled: params.editFlags.canCut },
        { label: t.copy, role: 'copy', enabled: params.editFlags.canCopy },
        { label: t.paste, role: 'paste', enabled: params.editFlags.canPaste },
        { label: t.selectAll, role: 'selectAll' },
      );
    else if (params.selectionText.trim())
      items.push({ label: t.copy, role: 'copy' }, { label: t.selectAll, role: 'selectAll' });
    while (items.at(-1)?.type === 'separator') items.pop();
    if (items.length) Menu.buildFromTemplate(items).popup({ window: w });
  });
}
function createMain() {
  main = new BrowserWindow({
    width: 1440,
    height: 970,
    minWidth: 1050,
    minHeight: 740,
    title: 'Agent Office',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    // The sidebar shows the system's own translucent material; the content column paints itself.
    ...(process.platform === 'darwin'
      ? {
          vibrancy: 'sidebar' as const,
          visualEffectState: 'followWindow' as const,
          backgroundColor: '#00000000',
        }
      : { backgroundColor: '#f5f5f7' }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  secure(main);
  watch(main);
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
      // A macOS panel can float over fullscreen apps without hiding the app's Dock icon.
      type: process.platform === 'darwin' ? 'panel' : undefined,
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    secure(dock);
    watch(dock);
    dock.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
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
const finite = (n: unknown, max = 100_000) =>
  typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= max;
function trusted(e: Electron.IpcMainInvokeEvent) {
  if (
    (![main?.webContents, dock?.webContents].includes(e.sender) && !cards.owns(e.sender)) ||
    e.senderFrame !== e.sender.mainFrame
  )
    throw new Error(m().desktop.untrustedWindow);
}
function setupIPC() {
  ipcMain.handle('office:open-artifact', async (e, url) => {
    trusted(e);
    const artifact = typeof url === 'string' ? parseArtifact(url) : null;
    if (!artifact) throw new Error(m().desktop.unsupportedLink);
    await shell.openExternal(artifact.url);
  });
  ipcMain.handle('office:open-link', async (e, url) => {
    trusted(e);
    const link = webLink(url);
    if (!link) throw new Error(m().desktop.webLinksOnly);
    await shell.openExternal(link);
  });
  ipcMain.handle('office:copy', (e, text) => {
    trusted(e);
    if (typeof text !== 'string' || text.length > 200_000) throw new Error(m().desktop.badRequest);
    clipboard.writeText(text);
  });
  // Whether this page's window is on screen right now (the page also hears each change).
  ipcMain.handle('office:visible', (e) => {
    trusted(e);
    const w = BrowserWindow.fromWebContents(e.sender);
    return w ? onScreen(w) : true;
  });
  ipcMain.handle('office:call', async (e, method, args) => {
    trusted(e);
    if (
      typeof method !== 'string' ||
      ['federation', 'remote-send', 'remote-targets'].includes(method) ||
      !Array.isArray(args) ||
      args.length > 3
    )
      throw new Error(m().desktop.badRequest);
    return bridge.call(method, args);
  });
  ipcMain.handle('office:federation', async (e, command) => {
    trusted(e);
    if (JSON.stringify(command)?.length > 30000) throw new Error(m().desktop.badRequest);
    return bridge.call('federation', [command]);
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
    if (!dock || e.sender !== dock.webContents) throw new Error(m().desktop.untrustedWindow);
    if (action === 'pet' || action === 'row' || action === 'floor') setDockMode(action);
    else if (action === 'drag-start') startDrag();
    else if (action === 'drag-end') stopDrag(true);
    else if (action === 'solid') dock.setIgnoreMouseEvents(false);
    else if (action === 'through') dock.setIgnoreMouseEvents(true, { forward: true });
    else throw new Error(m().desktop.badRequest);
  });
  ipcMain.handle('office:card-state', (e) => {
    trusted(e);
    return cards.state(e.sender);
  });
  ipcMain.handle('office:card', async (e, action, target, anchor) => {
    trusted(e);
    if (typeof action !== 'string') throw new Error(m().desktop.badRequest);
    if (action === 'open' || action === 'select' || action === 'expand') {
      if (
        !target ||
        typeof target.id !== 'string' ||
        !target.id.length ||
        target.id.length > 400 ||
        typeof target.news !== 'boolean'
      )
        throw new Error(m().desktop.badRequest);
      if (
        target.bookmark !== undefined &&
        (!target.bookmark ||
          typeof target.bookmark.eventId !== 'string' ||
          !target.bookmark.eventId.length ||
          target.bookmark.eventId.length > 1000 ||
          typeof target.bookmark.at !== 'number' ||
          !Number.isSafeInteger(target.bookmark.at) ||
          target.bookmark.at < 0 ||
          target.news)
      )
        throw new Error(m().desktop.badRequest);
    }
    const chosen: CardTarget | undefined = target && {
      id: target.id,
      news: target.news,
      ...(target.bookmark
        ? { bookmark: { eventId: target.bookmark.eventId, at: target.bookmark.at } }
        : {}),
    };
    if (action !== 'open') {
      const expanded = await cards.action(e.sender, action, chosen);
      if (expanded) showMain(expanded);
      return;
    }
    if (e.sender !== dock?.webContents) throw new Error(m().desktop.untrustedWindow);
    if (
      !anchor ||
      !finite(anchor.x) ||
      !finite(anchor.y) ||
      !finite(anchor.width, 10_000) ||
      !finite(anchor.height, 10_000) ||
      anchor.width < 0 ||
      anchor.height < 0
    )
      throw new Error(m().desktop.badRequest);
    cards.open(chosen!, {
      x: Math.round(anchor.x),
      y: Math.round(anchor.y),
      width: Math.round(anchor.width),
      height: Math.round(anchor.height),
    });
  });
  ipcMain.handle('office:reveal', async (e, id) => {
    trusted(e);
    if (isRemoteId(id)) throw new Error(m().federation.readOnly);
    const s: Session = await bridge.call('detail', [id]);
    shell.showItemInFolder(s.sourcePath);
  });
  ipcMain.handle('office:resume', async (e, id) => {
    trusted(e);
    if (isRemoteId(id)) throw new Error(m().federation.readOnly);
    return (await resume(await bridge.call('detail', [id]))).text;
  });
  // Live terminals are desktop-only: OfficeService.call is shared with the web preview.
  const identities = new Map<string, SessionIdentity>();
  /** Who these sessions are: one light read (no events) for all of those not known yet. */
  const identify = async (ids: string[]) => {
    const found = new Map<string, SessionIdentity>();
    const unknown: string[] = [];
    for (const id of ids) {
      if (isRemoteId(id)) continue;
      const known = identities.get(id);
      if (known) found.set(id, known);
      else if (id.length <= 400) unknown.push(id); // longer ones are no session's id
    }
    if (unknown.length)
      for (const known of (await bridge.call('identities', [unknown])) as SessionIdentity[]) {
        found.set(known.id, known);
        identities.set(known.id, known);
        if (identities.size > 500) identities.delete(identities.keys().next().value!);
      }
    return found;
  };
  const identity = async (id: unknown) => {
    if (typeof id !== 'string') throw new Error(m().desktop.badRequest);
    if (isRemoteId(id)) throw new Error(m().federation.readOnly);
    const known = (await identify([id])).get(id);
    if (!known) throw new Error(m().server.store.notFound);
    return known;
  };
  const live = (known: SessionIdentity, fresh = false) =>
    known.provider === 'claude' ? locateTerminal(known.nativeId, { fresh }) : null;
  const codex = (known: SessionIdentity, fresh = false) =>
    known.provider === 'codex'
      ? findCodexThread(known.nativeId, known.sourcePath, { fresh })
      : null;
  ipcMain.handle('office:terminals', async (e, ids) => {
    trusted(e);
    if (!Array.isArray(ids) || ids.length > 200 || ids.some((id) => typeof id !== 'string'))
      throw new Error(m().desktop.badRequest);
    const unique = [...new Set(ids as string[])];
    const found = await identify(unique).catch(() => new Map<string, SessionIdentity>());
    const entries = await Promise.all(
      unique.map(async (id) => {
        try {
          const known = found.get(id);
          if (!known) return [id, null] as const;
          const terminal = await live(known);
          if (terminal) return [id, terminalTarget(terminal)] as const;
          if (known.provider !== 'codex') return [id, null] as const;
          // A screen can be present even while the queue's loaded-thread lookup is unavailable.
          const [thread, screen] = await Promise.all([
            Promise.resolve(codex(known)).catch(() => null),
            findCodexTerminal(known.nativeId).catch(() => null),
          ]);
          return [id, codexTarget(screen?.host, !!thread)] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );
    const remote = unique.filter(isRemoteId);
    const remoteTargets = remote.length ? await bridge.call('remote-targets', [remote]) : {};
    return { ...Object.fromEntries(entries), ...remoteTargets };
  });
  ipcMain.handle('office:jump', async (e, id): Promise<JumpResult> => {
    trusted(e);
    const known = await identity(id);
    // The message queue and the visible screen are separate destinations.
    const terminal =
      known.provider === 'codex'
        ? await findCodexTerminal(known.nativeId, { fresh: true })
        : await live(known, true);
    if (!terminal) return resume(known);
    try {
      const text = await focusTerminal(terminal);
      // From the dock card, the terminal is where the person goes next.
      cards.afterJump(e.sender);
      return { action: 'focused', text };
    } catch (error) {
      if (error instanceof TerminalInputError) throw error;
      throw new Error(m().desktop.terminal.jumpFailed(hostName(terminal.host)));
    }
  });
  // The setting lives in the desktop profile, not in the shared preferences, so the web preview
  // can never turn it on. It is on by default; turning it back on always goes through a
  // native confirmation.
  ipcMain.handle('office:terminal-send', async (e, enable) => {
    trusted(e);
    if (typeof enable !== 'boolean') return terminalSendEnabled();
    if (enable) {
      const owner = BrowserWindow.fromWebContents(e.sender);
      const t = m().desktop.terminal.confirm;
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        buttons: [t.enable, t.cancel],
        defaultId: 1,
        cancelId: 1,
        message: t.message,
        detail: t.detail,
      };
      const { response } = owner
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options);
      if (response !== 0) return terminalSendEnabled();
    }
    await writeFile(terminalSendFile(), JSON.stringify({ enabled: enable }), { mode: 0o600 });
    return enable;
  });
  ipcMain.handle('office:inspect-draft', async (e, id) => {
    trusted(e);
    if (!(await terminalSendEnabled()) || isRemoteId(id)) return null;
    const known = await identity(id);
    const composer = composerFor(known.provider);
    if (composer.capabilities(null).delivery !== 'terminal') return null;
    const terminal = await live(known, true);
    return terminal ? inspectTerminalDraft(terminal, composer) : null;
  });
  ipcMain.handle('office:send', async (e, id, text, options): Promise<SendResult> => {
    trusted(e);
    if (typeof text !== 'string' || text.length > 20000) throw new Error(m().desktop.badRequest);
    const replaceDraft: unknown = options?.replaceDraft;
    if (
      (options != null && typeof options !== 'object') ||
      (replaceDraft !== undefined &&
        (typeof replaceDraft !== 'string' || replaceDraft.length > 20000))
    )
      throw new Error(m().desktop.badRequest);
    if (!(await terminalSendEnabled())) throw new Error(m().desktop.terminal.enableFirst);
    if (isRemoteId(id)) {
      if (replaceDraft !== undefined) throw new Error(m().federation.remoteDraft);
      return bridge.call('remote-send', [id, text, randomUUID()]);
    }
    const known = await identity(id);
    // Each agent's adapter says how a follow-up reaches it: its queue (Codex, no composer
    // involved) or its terminal (the composer is read, and cleared only when confirmed).
    const composer = composerFor(known.provider);
    const delivery = composer.capabilities(null).delivery;
    if (delivery === 'none') throw new Error(m().desktop.terminal.unsupportedAgent(composer.agent));
    const thread = delivery === 'queue' ? await codex(known, true) : null;
    if (delivery === 'queue' && !thread) throw new Error(m().desktop.terminal.noTarget);
    if (thread)
      try {
        return { status: 'sent', message: await queueToCodex(thread, text) };
      } catch (error) {
        if (error instanceof TerminalInputError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new Error(m().desktop.terminal.codexMissing);
        throw new Error(m().desktop.terminal.codexUnconfirmed);
      }
    const terminal = await live(known, true);
    if (!terminal) throw new Error(m().desktop.terminal.noTarget);
    try {
      return await sendToTerminal(terminal, text, undefined, {
        composer,
        replaceDraft,
        // The main process writes the clipboard: no permission prompt, nothing in the renderer.
        backup: async (draft) => clipboard.writeText(draft),
        clipboardText: () => clipboard.readText(),
      });
    } catch (error) {
      if (error instanceof TerminalInputError) throw error;
      // The text may already be in the terminal; never invite a blind resend.
      throw new Error(m().desktop.terminal.unconfirmed(hostName(terminal.host)));
    } finally {
      forgetTerminal(terminal.process.sessionId);
    }
  });
  // Answering a calling session's dialog by its own keys: desktop-only like sending, off until
  // the person agrees (a native confirmation, per kind), and checked against the screen. Which
  // agent and terminal is the adapter's business; nothing here depends on the provider.
  const asking = async (id: string) =>
    openRequest((await bridge.call('detail', [id])) as SessionDetail);
  const settingFor = (kind: InputRequest['kind']): keyof AnswerSettings =>
    kind === 'permission' ? 'permissions' : 'questions';
  const askAnswers = async (e: Electron.IpcMainInvokeEvent, which: keyof AnswerSettings) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const t = m().prompts.confirm;
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: [t.enable, t.cancel],
      defaultId: 1,
      cancelId: 1,
      message: t[which].message,
      detail: t[which].detail,
    };
    const endCardDialog = cards.dialog(e.sender);
    try {
      const { response } = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      return response === 0;
    } finally {
      endCardDialog();
    }
  };
  /**
   * Turns one setting on or off. Settings changes (from Settings and from a first answer) run
   * one at a time, each re-reading the file and writing back only its own field.
   */
  const changeSetting = (
    e: Electron.IpcMainInvokeEvent,
    which: keyof AnswerSettings,
    on: boolean,
  ): Promise<AnswerSettings> =>
    serially(async () => {
      if (on && (await answerSettings())[which] !== 'on' && !(await askAnswers(e, which)))
        return answerSettings();
      const next = { ...(await answerSettings()), [which]: on ? 'on' : 'off' };
      await writeFile(answerSettingsFile(), JSON.stringify(next), { mode: 0o600 });
      return next;
    });
  ipcMain.handle('office:answer-settings', async (e, patch): Promise<AnswerSettings> => {
    trusted(e);
    if (patch == null) return answerSettings();
    if (typeof patch !== 'object') throw new Error(m().desktop.badRequest);
    let settings = await answerSettings();
    for (const key of ['questions', 'permissions'] as const) {
      const value: unknown = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (typeof value !== 'boolean') throw new Error(m().desktop.badRequest);
      settings = await changeSetting(e, key, value);
    }
    return settings;
  });
  ipcMain.handle('office:prompt', async (e, id): Promise<PromptView> => {
    trusted(e);
    const known = await identity(id);
    const adapter = promptsFor(known.provider);
    const open = await asking(known.id);
    const setting = open ? (await answerSettings())[settingFor(open.request.kind)] : 'unset';
    return inspectPrompt(adapter, open, await adapter.target(known, false), setting);
  });
  const answering = new Set<string>();
  ipcMain.handle('office:answer', async (e, id, choice): Promise<AnswerResult> => {
    trusted(e);
    if (choice == null || typeof choice !== 'object' || JSON.stringify(choice).length > 20000)
      throw new Error(m().desktop.badRequest);
    const t = m().prompts.result;
    const known = await identity(id);
    const adapter = promptsFor(known.provider);
    if (!adapter.answers('tmux').size && !adapter.answers('orca').size)
      throw new Error(t.unsupported(adapter.agent));
    const open = await asking(known.id);
    if (!open) throw new Error(t.notWaiting);
    if (answering.has(known.id)) throw new Error(t.busy);
    // Held from the confirmation on: a second click meanwhile is refused, never queued.
    answering.add(known.id);
    let target: PromptTarget | null = null;
    try {
      const which = settingFor(open.request.kind);
      const setting = (await answerSettings())[which];
      if (setting === 'off') throw new TerminalInputError(t.off);
      if (setting === 'unset') {
        // The first answer of a kind asks once; the choice stays in the desktop profile.
        if ((await changeSetting(e, which, true))[which] !== 'on')
          return { status: 'cancelled', message: '' };
        // The dialog may have changed while the confirmation was open: the same call, or nothing.
        const again = await asking(known.id);
        if (!again || again.id !== open.id || again.callId !== open.callId)
          throw new TerminalInputError(t.changed);
      }
      target = await adapter.target(known, true);
      if (!target) throw new TerminalInputError(t.noTarget);
      return await answerRequest(adapter, open, target, choice);
    } catch (error) {
      if (error instanceof TerminalInputError || !target) throw error;
      // Keys may already be in the terminal; never invite a blind retry.
      throw new Error(t.unconfirmed(target.where));
    } finally {
      answering.delete(known.id);
      forgetTerminal(known.nativeId);
    }
  });
  ipcMain.handle('office:export', async (e, name, content) => {
    trusted(e);
    if (typeof content !== 'string' || content.length > 30000 || typeof name !== 'string')
      throw new Error(m().desktop.badFile);
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const endCardDialog = cards.dialog(e.sender);
    let result: Electron.SaveDialogReturnValue;
    try {
      result = await dialog.showSaveDialog(win, {
        defaultPath: path.basename(name).replace(/[^\p{L}\p{N}._ -]/gu, '_'),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
    } finally {
      endCardDialog();
    }
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, content, { mode: 0o600 });
    return true;
  });
}
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const terminalSendFile = () => path.join(app.getPath('userData'), 'terminal-send.json');
/**
 * On unless the person turned it off: no file means the default (on), and the file records
 * their choice. A file that can't be read counts as off. Turning it back on asks for
 * confirmation again.
 */
async function terminalSendEnabled() {
  let saved: string;
  try {
    saved = await readFile(terminalSendFile(), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT';
  }
  try {
    return JSON.parse(saved).enabled !== false;
  } catch {
    return false;
  }
}
const answerSettingsFile = () => path.join(app.getPath('userData'), 'answer-prompts.json');
/**
 * Never asked (no file, no value), on, or off. A file that cannot be read counts as off. Kept
 * in the desktop profile, never in the preferences the web preview shares.
 */
async function answerSettings(): Promise<AnswerSettings> {
  let text: string;
  try {
    text = await readFile(answerSettingsFile(), 'utf8');
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    return missing
      ? { questions: 'unset', permissions: 'unset' }
      : { questions: 'off', permissions: 'off' };
  }
  try {
    const saved = JSON.parse(text);
    return {
      questions: decodeSetting(saved?.questions),
      permissions: decodeSetting(saved?.permissions),
    };
  } catch {
    return { questions: 'off', permissions: 'off' };
  }
}
/** One settings change at a time (from Settings and from first answers alike). */
let settingsQueue: Promise<unknown> = Promise.resolve();
function serially<T>(change: () => Promise<T>): Promise<T> {
  const next = settingsQueue.then(change, change);
  settingsQueue = next.catch(() => undefined);
  return next;
}
async function resume(s: Pick<Session, 'provider' | 'nativeId'>): Promise<JumpResult> {
  if (s.provider === 'codex' && /^[\w-]+$/.test(s.nativeId)) {
    await shell.openExternal(`codex://threads/${s.nativeId}`);
    return { action: 'opened', text: m().desktop.codexOpened };
  }
  return {
    action: 'copy',
    text:
      s.provider === 'claude'
        ? `claude --resume ${shellQuote(s.nativeId)}`
        : m().desktop.openclawSession(s.nativeId),
  };
}
app.on('activate', () => showMain());
/** The collector has stopped (or timed out): quitting may go on. */
let collectorClosed = false;
/** A stop is in flight: repeated quit requests (a second ⌘Q, tray Quit) wait for it too. */
let collectorClosing = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (collectorClosed || !bridge) return;
  // Let the collector finish its pass and write what it staged, then quit for real.
  event.preventDefault();
  if (collectorClosing) return;
  collectorClosing = true;
  void bridge.close().finally(() => {
    collectorClosed = true;
    app.quit();
  });
});
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});
