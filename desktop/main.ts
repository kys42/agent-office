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
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ServiceBridge } from '../server/bridge.js';
import { syncLocale } from '../server/locale.js';
import type {
  CardTarget,
  DockAction,
  DockMode,
  JumpResult,
  Session,
  SessionIdentity,
  Snapshot,
} from '../src/shared/types.js';
import { parseArtifact } from '../src/shared/office.js';
import { m, setLocale } from '../src/shared/i18n/index.js';
import { webLink } from '../src/shared/links.js';
import {
  cardBounds,
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
  terminalTarget,
  TerminalInputError,
} from './terminals.js';
import { codexTarget, findCodexThread, queueToCodex } from './codex-queue.js';
let main: BrowserWindow | null = null,
  dock: BrowserWindow | null = null,
  // The dock card: a colleague's card opened at a desk in the dock (presentation only).
  card: BrowserWindow | null = null,
  cardHide: ReturnType<typeof setTimeout> | null = null,
  cardShownAt = 0,
  // A save or confirm sheet on the card takes focus; that is not a click elsewhere.
  cardDialogs = 0,
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
    // The collector worker inherits this: `auto` then follows the OS language list, not just LANG.
    process.env.AGENT_OFFICE_SYSTEM_LANGUAGES ??= app.getPreferredSystemLanguages().join(',');
    // System language until the first snapshot brings the saved preference.
    syncLocale(undefined);
    bridge = new ServiceBridge(path.join(__dirname, 'worker.cjs'));
    bridge.on('snapshot', (s: Snapshot) => {
      // Follow the language the collector actually resolved, so tray and windows always agree.
      if (s.locale ? setLocale(s.locale) : syncLocale(s.preferences?.locale)) buildTray();
      for (const w of [main, dock, card])
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
    buildTray();
    tray.on('click', () => showMain());
    // Displays, resolution or the macOS Dock changed: re-seat the pet/row inside a work area.
    const reseat = () => {
      if (dock && !dock.isDestroyed() && !drag) dock.setBounds(dockBounds(dockMode));
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
/**
 * The colleague card for the dock: the same card as the big office's right panel, in a small
 * focusable window above the clicked desk. The dock itself stays see-through and unfocused.
 */
function showCard(target: CardTarget, anchor: Rect) {
  if (cardHide) clearTimeout(cardHide);
  cardHide = null;
  if (!card || card.isDestroyed()) {
    card = new BrowserWindow({
      ...cardBounds(anchor, workAreaFor(anchor)),
      show: false,
      resizable: false,
      frame: false,
      transparent: true,
      fullscreenable: false,
      skipTaskbar: true,
      type: process.platform === 'darwin' ? 'panel' : undefined,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    secure(card);
    // Above the dock, which is itself always on top.
    card.setAlwaysOnTop(true, 'pop-up-menu');
    card.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    // Clicking anywhere else puts the card away. A short delay lets a click on another desk
    // reopen it in place instead of flickering.
    card.on('blur', () => {
      // Opening shifts focus between the dock and the card for a moment; that is not a click
      // elsewhere. A blur during that moment is checked again once it has passed.
      if (cardDialogs > 0) return;
      const settle = Math.max(150, cardShownAt + 500 - Date.now());
      if (cardHide) clearTimeout(cardHide);
      cardHide = setTimeout(() => {
        if (card && !card.isDestroyed() && !card.isFocused()) hideCard();
      }, settle);
    });
    card.on('closed', () => {
      card = null;
    });
    void card.loadFile(index, { hash: 'card' });
  } else card.setBounds(cardBounds(anchor, workAreaFor(anchor)));
  const window = card;
  const send = () => {
    if (!window.isDestroyed()) window.webContents.send('office:card', target);
  };
  const reveal = () => {
    if (window.isDestroyed()) return;
    cardShownAt = Date.now();
    window.show();
    window.focus();
  };
  // A new card window shows once its page is ready, so it never flashes empty.
  if (window.webContents.isLoadingMainFrame()) {
    window.webContents.once('did-finish-load', () => {
      send();
      reveal();
    });
  } else {
    send();
    reveal();
  }
}
function hideCard() {
  if (cardHide) clearTimeout(cardHide);
  cardHide = null;
  if (card && !card.isDestroyed() && card.isVisible()) {
    // A put-away card shows nothing: no background polling, no stale flash on the next open.
    card.webContents.send('office:card', null);
    card.hide();
  }
}
const finite = (n: unknown, max = 100_000) =>
  typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= max;
function trusted(e: Electron.IpcMainInvokeEvent) {
  if (
    ![main?.webContents, dock?.webContents, card?.webContents].includes(e.sender) ||
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
  ipcMain.handle('office:call', async (e, method, args) => {
    trusted(e);
    if (typeof method !== 'string' || !Array.isArray(args) || args.length > 3)
      throw new Error(m().desktop.badRequest);
    return bridge.call(method, args);
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
  ipcMain.handle('office:card', (e, action, target, anchor) => {
    trusted(e);
    if (action === 'close') {
      if (e.sender !== card?.webContents) throw new Error(m().desktop.untrustedWindow);
      return hideCard();
    }
    const valid =
      target &&
      typeof target.id === 'string' &&
      target.id.length > 0 &&
      target.id.length <= 400 &&
      typeof target.news === 'boolean';
    if (!valid) throw new Error(m().desktop.badRequest);
    const chosen: CardTarget = { id: target.id, news: target.news };
    if (action === 'expand') {
      if (e.sender !== card?.webContents) throw new Error(m().desktop.untrustedWindow);
      hideCard();
      return showMain(chosen.id);
    }
    if (action !== 'open' || e.sender !== dock?.webContents)
      throw new Error(m().desktop.badRequest);
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
    showCard(chosen, {
      x: Math.round(anchor.x),
      y: Math.round(anchor.y),
      width: Math.round(anchor.width),
      height: Math.round(anchor.height),
    });
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
  const identities = new Map<string, SessionIdentity>();
  /** Who these sessions are: one light read (no events) for all of those not known yet. */
  const identify = async (ids: string[]) => {
    const found = new Map<string, SessionIdentity>();
    const unknown: string[] = [];
    for (const id of ids) {
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
          return [id, (await codex(known)) ? codexTarget() : null] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  });
  ipcMain.handle('office:jump', async (e, id): Promise<JumpResult> => {
    trusted(e);
    const known = await identity(id);
    // A terminal Codex session lives in the CLI daemon, not the desktop app: hand back the command.
    const thread = await codex(known, true);
    if (thread) return { action: 'copy', text: `codex resume ${shellQuote(thread.threadId)}` };
    const terminal = await live(known, true);
    if (!terminal) return resume(known);
    try {
      const text = await focusTerminal(terminal);
      // From the dock card, the terminal is where the person goes next.
      if (e.sender === card?.webContents) hideCard();
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
  ipcMain.handle('office:send', async (e, id, text) => {
    trusted(e);
    if (typeof text !== 'string' || text.length > 20000) throw new Error(m().desktop.badRequest);
    if (!(await terminalSendEnabled())) throw new Error(m().desktop.terminal.enableFirst);
    const known = await identity(id);
    const thread = await codex(known, true);
    if (thread)
      try {
        return await queueToCodex(thread, text);
      } catch (error) {
        if (error instanceof TerminalInputError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new Error(m().desktop.terminal.codexMissing);
        throw new Error(m().desktop.terminal.codexUnconfirmed);
      }
    const terminal = await live(known, true);
    if (!terminal) throw new Error(m().desktop.terminal.noTarget);
    try {
      return await sendToTerminal(terminal, text);
    } catch (error) {
      if (error instanceof TerminalInputError) throw error;
      // The text may already be in the terminal; never invite a blind resend.
      throw new Error(m().desktop.terminal.unconfirmed(hostName(terminal.host)));
    } finally {
      forgetTerminal(terminal.process.sessionId);
    }
  });
  ipcMain.handle('office:export', async (e, name, content) => {
    trusted(e);
    if (typeof content !== 'string' || content.length > 30000 || typeof name !== 'string')
      throw new Error(m().desktop.badFile);
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const fromCard = win === card;
    if (fromCard) cardDialogs++;
    let result: Electron.SaveDialogReturnValue;
    try {
      result = await dialog.showSaveDialog(win, {
        defaultPath: path.basename(name).replace(/[^\p{L}\p{N}._ -]/gu, '_'),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
    } finally {
      if (fromCard) {
        cardDialogs--;
        if (!win.isDestroyed()) win.focus();
      }
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
app.on('before-quit', () => {
  quitting = true;
  void bridge?.close();
});
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});
