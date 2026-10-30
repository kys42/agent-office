import { launchSpecSchema, type RemoteLaunchInfo } from '../src/shared/remote-launch.js';
import { TmuxResume, summonSession } from './tmux-resume.js';
import { describeShell, MiniShells } from './mini-shell.js';
import { ShellWindows } from './shell-windows.js';
import { ReaderWindows } from './reader-windows.js';
import { parseReaderTarget } from '../src/shared/bookmark-window.js';
import { popupFloats } from '../src/shared/popup-window.js';
import { parseShellWindowTarget } from '../src/shared/shell-window.js';
import { parseShellCommand, validShellInput } from '../src/shared/mini-shell.js';
import { OrcaLaunch } from './orca-launch.js';
import { findOrcaTab, focusOrcaTab, lookupOrcaTab, orcaTabTarget } from './orca-tabs.js';
import { TerminalFocusError } from './terminal-host.js';
import { checkDuplicate, duplicateNote, livenessFor } from './launch-guard.js';
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
  nativeTheme,
} from 'electron';
import { dropAppMenu, windowStyle } from './window-style.js';
import { glassLevel } from '../src/shared/glass.js';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { MobileServer } from '../server/mobile/server.js';
import { ServiceBridge } from '../server/bridge.js';
import { isRemoteId } from '../src/shared/federation.js';
import { syncLocale } from '../server/locale.js';
import type {
  Bookmark,
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
  DuplicateCheck,
} from '../src/shared/types.js';
import { parseArtifact } from '../src/shared/office.js';
import { m, setLocale } from '../src/shared/i18n/index.js';
import { OPENABLE_FILE, fileLink, webLink } from '../src/shared/links.js';
import {
  clampInto,
  dockHeight,
  moveOntoArea,
  petBounds,
  petFeet,
  readDockPrefs,
  readPetSpot,
  rowBounds,
  type Point,
  type Rect,
} from '../src/shared/dock-geometry.js';
import {
  defaultTerminalDeps,
  focusTerminal,
  forgetTerminal,
  hostName,
  claudeAttachCommand,
  claudeNoTerminalReason,
  locateTerminal,
  lookupTerminal,
  sendToTerminal,
  inspectTerminalDraft,
  terminalTarget,
  TerminalInputError,
  type TerminalHost,
  type TerminalLookup,
} from './terminals.js';
import {
  codexDestinationTarget,
  codexRecordsRequest,
  findCodexDestination,
  sendToCodex,
} from './codex-send.js';
import { findCodexTerminal, lookupCodexTerminal } from './codex-focus.js';
import { composerFor } from './composer/index.js';
import { AttachmentError, AttachmentStore } from './attachments.js';
import { promptsFor } from './prompts/index.js';
import { answerRequest, decodeSetting, inspectPrompt } from './answers.js';
import type { PromptTarget } from './prompts/types.js';
import { openRequest } from '../src/shared/requests.js';
import { SnapshotDelivery, type Viewer } from './delivery.js';
import { CardWindows, type CardMaterial } from './card-windows.js';
import { isSettingsSection, type SettingsSection } from '../src/shared/settings.js';
import type { SnapshotPatch } from '../src/shared/snapshot-patch.js';
import { present, quiet, quietStart } from './quiet.js';
import { Notifier } from './notify.js';
/** Test runs read notifications instead of showing them, even when not quiet (CI). */
const recordNotifications = process.env.AGENT_OFFICE_RECORD_NOTIFICATIONS === '1';
let main: BrowserWindow | null = null,
  dock: BrowserWindow | null = null,
  settingsWindow: BrowserWindow | null = null,
  tray: Tray | null = null,
  bridge: ServiceBridge,
  quitting = false;
let cards: CardWindows;
let shellWindows: ShellWindows;
let readerWindows: ReaderWindows;
let notifier: Notifier;
// The colleague card open in the big office, as its page reports it (notifications skip it).
let mainSelected: string | null = null;
let mobile: MobileServer | undefined;
// Desk pet: presentation-only window state. Office data comes from the same snapshot.
let dockMode: DockMode = 'pet',
  petEnabled = false,
  petSpot: Point | null = null,
  // Tiny row/floor (쪼꼬미): remembered so the window opens at the right height.
  dockTiny = false,
  drag: ReturnType<typeof setInterval> | null = null;
const root = path.join(__dirname, '..');
const index = path.join(root, 'dist', 'index.html');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showMain());
  app.whenReady().then(() => {
    quietStart();
    if (process.platform === 'win32') app.setAppUserModelId('dev.kys.agentoffice');
    // Keep edit accelerators while removing Electron's default File/Edit/View/Window bar.
    if (process.platform !== 'darwin')
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }]));
    // The collector worker inherits this: `auto` then follows the OS language list, not just LANG.
    process.env.AGENT_OFFICE_SYSTEM_LANGUAGES ??= app.getPreferredSystemLanguages().join(',');
    // System language until the first snapshot brings the saved preference.
    syncLocale(undefined);
    // Use the same art as the bundle even when macOS remembers an older Dock icon.
    if (process.platform === 'darwin') app.dock?.setIcon(path.join(root, 'dist', 'icon.png'));
    bridge = new ServiceBridge(path.join(__dirname, 'worker.cjs'));
    // Attached images are kept a week (the Codex queue passes paths the agent may open later).
    void attachments()
      .cleanup()
      .catch(() => undefined);
    cards = new CardWindows({
      index,
      preload: path.join(__dirname, 'preload.cjs'),
      dir: process.env.AGENT_OFFICE_DATA_DIR ?? app.getPath('userData'),
      secure,
      watch,
      // A preview card stays while the person works in a terminal or reader window it opened.
      companion: () => !!shellWindows?.focused() || !!readerWindows?.focused(),
      material: () => cardMaterial(delivery.latest),
    });
    app.on('before-quit', () => cards.dispose());
    shellWindows = new ShellWindows({
      index,
      preload: path.join(__dirname, 'preload.cjs'),
      dir: process.env.AGENT_OFFICE_DATA_DIR ?? app.getPath('userData'),
      secure,
      blurred: () => cards.recheck(),
    });
    // The bookmark reader's windows read the office like the other windows: snapshots too.
    readerWindows = new ReaderWindows({
      index,
      preload: path.join(__dirname, 'preload.cjs'),
      dir: process.env.AGENT_OFFICE_DATA_DIR ?? app.getPath('userData'),
      secure,
      blurred: () => cards.recheck(),
      created: watch,
    });
    notifier = new Notifier({
      // Quiet runs, and test runs that take the real focus (CI), record instead of showing.
      record: quiet || recordNotifications,
      focus: () => ({
        mainFocused: !!main && onScreen(main) && main.isFocused(),
        selected: mainSelected,
        cards: cards.shown(),
      }),
      open: (sessionId) => {
        // Someone working with the desk pet or row gets the colleague's card there (shown, never
        // toggled closed if already open); otherwise the big office opens at that colleague.
        // A summary (no one colleague) opens the big office beside the dock, which stays.
        const docked = !!dock && !dock.isDestroyed() && dock.isVisible();
        if (sessionId && docked) cards.reveal({ id: sessionId, news: false }, dock!.getBounds());
        else
          showMain(sessionId, { keepDock: docked, from: docked ? dock!.getBounds() : undefined });
      },
    });
    app.on('before-quit', () => notifier.dispose());
    // Test runs read what would have been shown.
    if (quiet || recordNotifications)
      (globalThis as { __agentOfficeNotifications?: unknown }).__agentOfficeNotifications =
        notifier.recorded;
    const windows = () =>
      [main, dock, settingsWindow, ...cards.windows(), ...readerWindows.windows()]
        .filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
        .map(viewer);
    // Follow the language the collector actually resolved, so tray and windows always agree.
    const followLanguage = (s: Snapshot) => {
      if (s.locale ? setLocale(s.locale) : syncLocale(s.preferences?.locale)) buildTray();
    };
    // Hiding the screen's content (화면 내용 숨기기) closes the popup windows: tmux keeps the
    // shells, and a reader closes like the in-page one does.
    const hidePopups = (s: Snapshot) => {
      if (!s.preferences?.privacy) return;
      shellWindows.closeAll();
      readerWindows.closeAll();
    };
    // Settings › Look › Glass: cards on the clearer glass while the person set their own level.
    let material = cardMaterial(null);
    const followGlass = (s: Snapshot) => {
      const next = cardMaterial(s);
      if (next === material) return;
      material = next;
      cards.setMaterial(next);
    };
    const publish = (s: Snapshot) => {
      followLanguage(s);
      hidePopups(s);
      followGlass(s);
      delivery.publish(s, windows());
      notifier.observe(s);
    };
    bridge.on('snapshot', publish);
    bridge.on('patch', (patch: SnapshotPatch) => {
      if (delivery.update(patch, windows())) {
        followLanguage(delivery.latest!);
        hidePopups(delivery.latest!);
        followGlass(delivery.latest!);
        notifier.observe(delivery.latest!);
      }
      // A change that does not start from what is held here (e.g. the collector restarted).
      else void bridge.call('snapshot').then(publish, () => {});
    });
    bridge.on('failure', (message) => console.error('Collector worker:', message));
    petSpot = loadPetSpot();
    dockTiny = loadDockTiny();
    createMain();
    setupIPC();
    const icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABXUlEQVQ4T6WTsUoDQRRFz8yuJGKhSLEKCgYK/gMLC5sQv8BCsPEHbCxs7WwsLC3sLSz8BxYSa2uxCIJYCCKCYmwUzGRnHLGZnWQFV3hmzpw7d96bBcEEIAIwBPQBHEWzXxdQB2ABuAK8eAsaASaADWAB2LVNgAkgC+QF2AGWQgCWgCeArYhS2K1ICxzqfwEOI+gjmgGmAW0xDdCUkcSOKuAMQF9EQ0ClCzgFlEVSJr9wAU8BxSLmBRwnDEAzABeAWUKBggaITRXoBgRbVKktsCsA50XMpPMCUFdIj68twDxAb8AOoAfolOEhGnT0EMH2noPnsSqTOIVmIZdGTuOA1V8PqxCAY4AkOmR01YAQdBgXMSbMNTE62CEawEqGwGUyJvrb1+ksHlEGQ6MvCSAaQAuCpTOZY/gjgNP17c/gDKr0jdGwXuMK4FnAUjQYZ4wA75pM3fEn8rwAPcApYOvPCZ3hF1cCPzdlP+RhAAAAAElFTkSuQmCC',
    );
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    const trayIcon =
      process.platform === 'win32'
        ? nativeImage
            .createFromPath(path.join(root, 'dist', 'icon.png'))
            .resize({ width: 20, height: 20 })
        : icon;
    tray = new Tray(trayIcon);
    buildTray();
    tray.on('click', () => showMain());
    nativeTheme.on('updated', () => {
      if (process.platform === 'darwin') return;
      const style = windowStyle(process.platform, nativeTheme.shouldUseDarkColors);
      for (const w of [main, settingsWindow]) {
        if (!w || w.isDestroyed()) continue;
        w.setBackgroundColor(style.backgroundColor!);
        if (process.platform === 'win32')
          w.setTitleBarOverlay(style.titleBarOverlay as Electron.TitleBarOverlay);
      }
    });
    // Displays, resolution or the macOS Dock changed: re-seat the pet/row inside a work area.
    const reseat = () => {
      if (dock && !dock.isDestroyed() && !drag) dock.setBounds(roomyBounds(dockMode));
      cards.reseat();
      shellWindows.reseat();
      readerWindows.reseat();
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
      { label: t.settings, click: () => showSettings() },
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
/** The big office's smallest size, lowered only for a display smaller than this. */
/** The card's glass: the clearer `popover` once the person chose a glass level. */
const cardMaterial = (s: Snapshot | null): CardMaterial =>
  glassLevel(s?.preferences) === null ? 'under-window' : 'popover';
const MAIN_MIN = { width: 1050, height: 740 };
function createMain() {
  main = new BrowserWindow({
    width: 1440,
    height: 970,
    minWidth: MAIN_MIN.width,
    minHeight: MAIN_MIN.height,
    title: 'Agent Office',
    icon: path.join(root, 'dist', 'icon.png'),
    show: !quiet,
    autoHideMenuBar: process.platform !== 'darwin',
    ...windowStyle(process.platform, nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  dropAppMenu(main);
  secure(main);
  watch(main);
  if (quiet) main.showInactive();
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
/**
 * Opened from another window (the desk pet, the row, a card), the big office comes to that
 * window's display, never back to whichever monitor it was last on. Same size and relative
 * spot (moveOntoArea); a maximized or full-screen office is that again on the new display.
 */
function bringMainOnto(origin: Rect) {
  const window = main;
  if (!window || window.isDestroyed()) return;
  const to = screen.getDisplayMatching(origin);
  const from = screen.getDisplayMatching(window.getBounds());
  if (from.id === to.id) return;
  const place = () => {
    if (window.isDestroyed()) return;
    const normal = window.getNormalBounds();
    // A display smaller than the office's usual minimum (1050×740) lowers it, so the window fits.
    window.setMinimumSize(
      Math.min(MAIN_MIN.width, to.workArea.width),
      Math.min(MAIN_MIN.height, to.workArea.height),
    );
    window.setBounds(moveOntoArea(normal, screen.getDisplayMatching(normal).workArea, to.workArea));
  };
  if (window.isFullScreen()) {
    window.once('leave-full-screen', () => {
      place();
      if (!window.isDestroyed()) window.setFullScreen(true);
    });
    window.setFullScreen(false);
  } else if (window.isMaximized()) {
    window.unmaximize();
    place();
    window.maximize();
  } else place();
}
function showMain(
  id?: string,
  {
    keepDock = false,
    from,
    bookmark,
  }: { keepDock?: boolean; from?: Rect; bookmark?: { eventId: string; at: number } } = {},
) {
  if (!main || main.isDestroyed()) createMain();
  stopDrag(false);
  if (!keepDock && dock && !dock.isDestroyed()) dock.hide();
  const window = main!;
  if (window.isMinimized()) window.restore();
  if (from) bringMainOnto(from);
  present(window);
  if (id) {
    const select = () => {
      if (window.isDestroyed()) return;
      if (bookmark) window.webContents.send('office:select', id, bookmark);
      else window.webContents.send('office:select', id);
    };
    if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', select);
    else select();
  }
}
/**
 * The settings window (#87): the same Settings as the big office's page, as top tabs. Unlike
 * the card window it stays open when it loses focus, so it can sit beside the work it tunes.
 */
const settingsReady = new WeakSet<BrowserWindow>();
function showSettings(section: SettingsSection | null = null) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    const window = settingsWindow;
    // Still loading: ready-to-show shows it, never a blank window before that.
    if (settingsReady.has(window)) {
      if (window.isMinimized()) window.restore();
      present(window);
    }
    const tell = () => !window.isDestroyed() && window.webContents.send('office:settings', section);
    if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', tell);
    else tell();
    return;
  }
  const window = new BrowserWindow({
    width: 680,
    height: 760,
    minWidth: 520,
    minHeight: 480,
    title: m().settings.window.title,
    icon: path.join(root, 'dist', 'icon.png'),
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    fullscreenable: false,
    ...windowStyle(process.platform, nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow = window;
  if (process.platform !== 'darwin') window.removeMenu();
  secure(window);
  watch(window);
  window.once('ready-to-show', () => {
    settingsReady.add(window);
    present(window);
  });
  window.on('closed', () => {
    if (settingsWindow === window) settingsWindow = null;
  });
  void window.loadFile(index, { hash: section ? `settings=${section}` : 'settings' });
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
const dockFile = () =>
  path.join(process.env.AGENT_OFFICE_DATA_DIR ?? app.getPath('userData'), 'dock.json');
function loadDockTiny(): boolean {
  try {
    return readDockPrefs(JSON.parse(readFileSync(dockFile(), 'utf8'))).tiny;
  } catch {
    return false;
  }
}
// Writes run one after another (a quick on/off must never land out of order), each writing
// the size current when it runs, through a temp file so a crash never leaves half a file.
let dockSaving: Promise<void> = Promise.resolve();
function saveDockTiny() {
  dockSaving = dockSaving.then(async () => {
    try {
      const file = dockFile();
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ v: 1, tiny: dockTiny }), { mode: 0o600 });
      await rename(temp, file);
    } catch (e) {
      console.error('Dock size:', e);
    }
  });
  return dockSaving;
}
const workAreaFor = (b: Rect) => screen.getDisplayMatching(b).workArea;
function dockBounds(mode: DockMode): Rect {
  // The display under the pet's feet (the nearest one if that display is gone).
  const area = petSpot
    ? workAreaFor({ x: petSpot.x - 1, y: petSpot.y - 1, width: 2, height: 2 })
    : screen.getPrimaryDisplay().workArea;
  const pet = petBounds(petSpot, area);
  // The row (or the floor desks) opens along the bottom of whichever display the pet is on.
  return mode === 'pet' ? pet : rowBounds(area, dockHeight(mode === 'floor', dockTiny));
}
/** A dialog open in the row or floor (a tiny strip is too short for one): grow upward. */
let dockRoom = false;
const DOCK_ROOM_HEIGHT = 760;
function roomyBounds(mode: DockMode): Rect {
  const b = dockBounds(mode);
  if (!dockRoom || mode === 'pet') return b;
  const area = workAreaFor(b);
  const height = Math.max(b.height, Math.min(DOCK_ROOM_HEIGHT, area.height));
  // The desks stand on the window's bottom edge: keep it, take the room above.
  return { ...b, y: b.y + b.height - height, height };
}
function setDockRoom(on: boolean) {
  if (dockRoom === on) return;
  dockRoom = on;
  if (dock && !dock.isDestroyed() && dockMode !== 'pet') dock.setBounds(roomyBounds(dockMode));
}
function setDockMode(mode: DockMode) {
  stopDrag(false);
  dockMode = mode;
  if (!dock || dock.isDestroyed()) return;
  dock.setBounds(roomyBounds(mode));
  // Start see-through; the renderer claims the mouse again over drawn things.
  dock.setIgnoreMouseEvents(true, { forward: true });
  dock.webContents.send('office:dock', mode, dockTiny);
}
function setDockTiny(tiny: boolean) {
  if (dockTiny === tiny) return;
  dockTiny = tiny;
  void saveDockTiny();
  // The pet keeps its size; the row or floor resizes and re-renders at once.
  if (dockMode === 'pet') return;
  // Shrinking: let the renderer draw tiny before the window shrinks, so the full-size row
  // never shows clipped for a frame (growing is safe: the window gets taller first).
  if (tiny && dock && !dock.isDestroyed()) dock.webContents.send('office:dock', dockMode, true);
  setDockMode(dockMode);
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
      dockRoom = false;
      dock = null;
    });
    // The renderer follows the main process; tell it the mode it may have missed while loading.
    // A reloaded page has no dialog open: drop any room an earlier one asked for.
    dock.webContents.on('did-finish-load', () => {
      setDockRoom(false);
      dock?.webContents.send('office:dock', dockMode, dockTiny);
    });
    void dock.loadFile(index, {
      hash: mode === 'pet' ? 'mini' : `mini=${mode}${dockTiny ? '&tiny' : ''}`,
    });
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
function trusted(e: Pick<Electron.IpcMainInvokeEvent, 'sender' | 'senderFrame'>) {
  if (
    (![main?.webContents, dock?.webContents, settingsWindow?.webContents].includes(e.sender) &&
      !cards.owns(e.sender)) ||
    e.senderFrame !== e.sender.mainFrame
  )
    throw new Error(m().desktop.untrustedWindow);
}
/** What a reader window may ask the service: the office it shows and the bookmark it reads. */
const READER_CALLS = new Set(['snapshot', 'bookmarkById']);
/**
 * The bookmark reader's IPC (its window, the office's reads, copying and opening links) also
 * trusts the reader windows; nothing else does.
 */
function trustedReader(e: Pick<Electron.IpcMainInvokeEvent, 'sender' | 'senderFrame'>) {
  if (readerWindows.owns(e.sender) && e.senderFrame === e.sender.mainFrame) return;
  trusted(e);
}
/** The mini terminal's IPC also trusts its own windows (and nothing else does). */
function trustedShell(e: Pick<Electron.IpcMainInvokeEvent, 'sender' | 'senderFrame'>) {
  if (shellWindows.owns(e.sender) && e.senderFrame === e.sender.mainFrame) return;
  trusted(e);
}
/**
 * The mini terminal (docs/development/TERMINAL.md · Mini terminal). A window names a local
 * session (its folder is read here, never taken from the window), an existing shell, or its own
 * attachment; keystrokes reach only the PTY that window attached.
 */
function setupMiniShell() {
  const shells = new MiniShells();
  app.on('before-quit', () => shells.dispose());
  if (!shells.supported) return;
  const watched = new WeakSet<Electron.WebContents>();
  const watch = (sender: Electron.WebContents) => {
    if (watched.has(sender)) return;
    watched.add(sender);
    const id = sender.id;
    // A closed or reloaded window leaves its clients behind: end them, keep the shells.
    sender.once('destroyed', () => shells.detachOwner(id));
    sender.on('did-start-loading', () => shells.detachOwner(id));
  };
  const sinkFor = (sender: Electron.WebContents) => ({
    data: (ptyId: string, data: string) => {
      if (!sender.isDestroyed()) sender.send('office:shell-data', ptyId, data);
    },
    exit: (ptyId: string) => {
      if (!sender.isDestroyed()) sender.send('office:shell-exit', ptyId);
    },
  });
  // A terminal window per folder shell, beside the window that asked for it (shell-windows.ts).
  ipcMain.handle('office:shell-window', async (e, what: unknown, raw: unknown) => {
    trustedShell(e);
    if (what === 'target') return shellWindows.target(e.sender);
    if (what === 'close' || what === 'focus') return shellWindows.action(e.sender, what);
    // Its own on-top toggle: only a terminal window reads or sets its own.
    if (what === 'top') return shellWindows.onTop(e.sender);
    if (what === 'top-on' || what === 'top-off')
      return shellWindows.setOnTop(e.sender, what === 'top-on');
    if (what === 'close-all') {
      // The big office turning into the sample office lets go of every real shell.
      if (e.sender !== main?.webContents) throw new Error(m().desktop.untrustedWindow);
      return shellWindows.closeAll();
    }
    if (what !== 'open') throw new Error(m().desktop.badRequest);
    let target;
    try {
      target = parseShellWindowTarget(raw);
    } catch {
      throw new Error(m().desktop.badRequest);
    }
    if (delivery.latest?.preferences?.privacy) throw new Error(m().shell.hidden);
    let key: string, cwd: string;
    if (target.name) {
      const found = (await shells.list()).find((s) => s.name === target.name);
      if (!found) throw new Error(m().shell.gone);
      ({ name: key, cwd } = found);
    } else {
      if (isRemoteId(target.id!)) throw new Error(m().federation.readOnly);
      // The folder is read here, never taken from the window.
      const session: Session = await bridge.call('detail', [target.id]);
      if (!session?.cwd || session.remote) throw new Error(m().shell.folderMissing);
      ({ name: key, cwd } = describeShell(session.cwd));
    }
    // Privacy may have come on while the folder was looked up: never open a window after it.
    if (delivery.latest?.preferences?.privacy) throw new Error(m().shell.hidden);
    const from = BrowserWindow.fromWebContents(e.sender);
    if (!from || from.isDestroyed()) return;
    shellWindows.open(key, { ...target, cwd }, from.getBounds(), {
      // Only beside a window that floats (a preview card, a card pinned on top, the desk dock, a
      // popup set on top) does it float too: a plain pinned card, the big office or an ordinary
      // terminal window give an ordinary window. Its own header toggle changes it later.
      float: popupFloats({ main: from === main, alwaysOnTop: from.isAlwaysOnTop() }),
    });
  });
  ipcMain.handle('office:shell', async (e, raw) => {
    trustedShell(e);
    // A terminal never attaches while screen content is hidden.
    const kind = (raw as { type?: unknown } | null)?.type;
    if (delivery.latest?.preferences?.privacy && (kind === 'open' || kind === 'attach'))
      throw new Error(m().shell.hidden);
    let command;
    try {
      command = parseShellCommand(raw);
    } catch {
      throw new Error(m().desktop.badRequest);
    }
    const owner = e.sender.id;
    switch (command.type) {
      case 'list':
        return shells.list();
      case 'open': {
        if (isRemoteId(command.id)) throw new Error(m().federation.readOnly);
        // Track the window and note its lifetime before the first await: a reload while the
        // session is read makes this request stale, and it then opens nothing.
        watch(e.sender);
        const since = shells.epoch(owner);
        const session: Session = await bridge.call('detail', [command.id]);
        if (!session?.cwd || session.remote) throw new Error(m().shell.folderMissing);
        return shells.open(
          owner,
          session.cwd,
          command.cols,
          command.rows,
          sinkFor(e.sender),
          since,
        );
      }
      case 'attach':
        watch(e.sender);
        return shells.attach(owner, command.name, command.cols, command.rows, sinkFor(e.sender));
      case 'resize':
        return shells.resize(owner, command.ptyId, command.cols, command.rows);
      case 'flow':
        return shells.flow(owner, command.ptyId, command.paused);
      case 'detach':
        return shells.detach(owner, command.ptyId);
      case 'kill':
        return shells.kill(command.name, async (shell) => {
          const t = m().shell;
          const window = BrowserWindow.fromWebContents(e.sender);
          const options = {
            type: 'warning' as const,
            title: t.killTitle,
            message: t.killConfirm,
            detail: `${t.folder}: ${shell.cwd}\n${t.name}: ${shell.name}\n\n${t.killDetail}`,
            buttons: [t.cancel, t.killButton],
            defaultId: 0,
            cancelId: 0,
          };
          const end = cards.dialog(e.sender);
          try {
            const result = window
              ? await dialog.showMessageBox(window, options)
              : await dialog.showMessageBox(options);
            return result.response === 1;
          } finally {
            end();
          }
        });
    }
  });
  ipcMain.on('office:shell-input', (e, ptyId: unknown, data: unknown) => {
    try {
      trustedShell(e);
    } catch {
      return;
    }
    if (validShellInput(ptyId, data)) shells.write(e.sender.id, ptyId as string, data);
  });
}
/**
 * The bookmark reader's windows (docs/development/POPUP-CARDS.md · 옆에 뜨는 팝업 창): a window
 * names only a bookmark id; the reader reads the bookmark itself through the office API, and
 * "open in office" reads it again here, so the service decides what is there to show.
 */
function setupReader() {
  ipcMain.handle('office:reader-window', async (e, what: unknown, raw: unknown) => {
    trustedReader(e);
    const reader = readerWindows.owns(e.sender);
    if (what === 'target') return readerWindows.target(e.sender);
    if (what === 'close' || what === 'focus') return readerWindows.action(e.sender, what);
    // Its own on-top toggle: only a reader window reads or sets its own.
    if (what === 'top') return readerWindows.onTop(e.sender);
    if (what === 'top-on' || what === 'top-off')
      return readerWindows.setOnTop(e.sender, what === 'top-on');
    if (what === 'go') {
      if (!reader) throw new Error(m().desktop.untrustedWindow);
      const { id } = readerWindows.target(e.sender);
      const b: Bookmark | null = await bridge.call('bookmarkById', [id]);
      if (!b) throw new Error(m().memory.readerGoneTitle);
      // Like the in-page reader's "open": the big office at that message, on this display.
      showMain(b.sessionId, {
        from: BrowserWindow.fromWebContents(e.sender)?.getBounds(),
        bookmark: { eventId: b.eventId, at: b.at },
      });
      return;
    }
    if (what !== 'open') throw new Error(m().desktop.badRequest);
    let target;
    try {
      target = parseReaderTarget(raw);
    } catch {
      throw new Error(m().desktop.badRequest);
    }
    if (delivery.latest?.preferences?.privacy) throw new Error(m().memory.readerHidden);
    const from = BrowserWindow.fromWebContents(e.sender);
    if (!from || from.isDestroyed()) return;
    readerWindows.open(target.id, target, from.getBounds(), {
      float: popupFloats({ main: from === main, alwaysOnTop: from.isAlwaysOnTop() }),
    });
  });
}
function setupIPC() {
  ipcMain.on('office:selected', (e, id: unknown) => {
    if (!main || e.sender !== main.webContents || e.senderFrame !== e.sender.mainFrame) return;
    mainSelected = typeof id === 'string' && id.length <= 400 ? id : null;
  });
  ipcMain.handle('office:open-artifact', async (e, url) => {
    trustedReader(e);
    const artifact = typeof url === 'string' ? parseArtifact(url) : null;
    if (!artifact) throw new Error(m().desktop.unsupportedLink);
    await shell.openExternal(artifact.url);
  });
  ipcMain.handle('office:open-link', async (e, url) => {
    trustedReader(e);
    const link = webLink(url);
    if (!link) throw new Error(m().desktop.webLinksOnly);
    await shell.openExternal(link);
  });
  // A file named in session text, on the person's click: documents open in their app; anything
  // else (an app, a script, any folder — X.app is one) is only shown in its folder, never run.
  // Judged by the real path, so a link named like a document can't open what it points to.
  ipcMain.handle('office:open-file', async (e, raw) => {
    trustedReader(e);
    const named = fileLink(raw);
    if (!named) throw new Error(m().desktop.badRequest);
    const given = path.resolve(
      named.startsWith('~/') ? path.join(os.homedir(), named.slice(2)) : named,
    );
    const file = await realpath(given).catch(() => null);
    const found = file ? await stat(file).catch(() => null) : null;
    if (!file || !found) return 'missing';
    if (found.isFile() && OPENABLE_FILE.test(file) && !(await shell.openPath(file)))
      return 'opened';
    shell.showItemInFolder(file);
    return 'revealed';
  });
  ipcMain.handle('office:copy', (e, text) => {
    trustedReader(e);
    if (typeof text !== 'string' || text.length > 200_000) throw new Error(m().desktop.badRequest);
    clipboard.writeText(text);
  });
  // Whether this page's window is on screen right now (the page also hears each change).
  ipcMain.handle('office:visible', (e) => {
    trustedReader(e);
    const w = BrowserWindow.fromWebContents(e.sender);
    return w ? onScreen(w) : true;
  });
  ipcMain.handle('office:call', async (e, method, args) => {
    if (readerWindows.owns(e.sender) && !READER_CALLS.has(method))
      throw new Error(m().desktop.untrustedWindow);
    trustedReader(e);
    if (
      typeof method !== 'string' ||
      ['federation', 'remote-send', 'remote-targets', 'remote-launch'].includes(method) ||
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
    // From the pet, the row or a card: on that window's display (the big office's own
    // window matches itself, so nothing moves).
    else if (action === 'main')
      showMain(typeof id === 'string' ? id : undefined, {
        from: BrowserWindow.fromWebContents(e.sender)?.getBounds(),
      });
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
  ipcMain.handle('office:settings', (e, section: unknown) => {
    trusted(e);
    if (section !== null && !isSettingsSection(section)) throw new Error(m().desktop.badRequest);
    showSettings(section);
  });
  ipcMain.handle('office:dock', (e, action: DockAction) => {
    trusted(e);
    if (!dock || e.sender !== dock.webContents) throw new Error(m().desktop.untrustedWindow);
    if (action === 'pet' || action === 'row' || action === 'floor') setDockMode(action);
    else if (action === 'tiny-on' || action === 'tiny-off') setDockTiny(action === 'tiny-on');
    else if (action === 'drag-start') startDrag();
    else if (action === 'drag-end') stopDrag(true);
    else if (action === 'solid') dock.setIgnoreMouseEvents(false);
    else if (action === 'through') dock.setIgnoreMouseEvents(true, { forward: true });
    else if (action === 'room-on' || action === 'room-off') setDockRoom(action === 'room-on');
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
      // The card's spot before it closes: the big office opens on its display.
      const from = BrowserWindow.fromWebContents(e.sender)?.getBounds();
      const expanded = await cards.action(e.sender, action, chosen);
      if (expanded) showMain(expanded, { from });
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
  const tmuxResume = new TmuxResume();
  /** The person's choice in Settings, read when a launch starts. */
  const skipPermissions = () => delivery.latest?.preferences?.tmuxSkipPermissions === true;
  const skipNote = (on: boolean) => (on ? '\n\n' + m().tmux.skipPermissions : '');
  const orcaLaunch = new OrcaLaunch(() => defaultTerminalDeps().bin('orca'));
  /**
   * The duplicate-launch check for a saved conversation (desktop/launch-guard.ts): its agent
   * process (per-agent liveness adapter), its Orca tab, and the app's own tmux session for it.
   */
  const duplicateCheck =
    (session: Session) =>
    (fresh: boolean): Promise<DuplicateCheck> =>
      checkDuplicate(
        {
          agent: (f) => livenessFor(session.provider).lookup(session.nativeId, f),
          orcaTab: async (f) => {
            const tab = await lookupOrcaTab(
              session,
              defaultTerminalDeps(),
              f,
              (delivery.latest?.sessions ?? []).filter((other) => !other.remote),
            );
            // Orca not installed or not running: none of its tabs runs anything right now.
            if (tab.kind === 'unknown' && !(await orcaLaunch.reachable(f))) return { kind: 'none' };
            return tab;
          },
          ownTmux: async () => {
            try {
              return (await tmuxResume.status(session)).running
                ? { kind: 'found', terminal: null }
                : { kind: 'none' };
            } catch (error) {
              // No tmux installed: there is no own session.
              if ((error as Error).message === m().tmux.missing) return { kind: 'none' };
              throw error;
            }
          },
        },
        fresh,
      );
  /** Native confirmations warn about an open tab or an unverifiable check. */
  const dialogType = (check: DuplicateCheck) =>
    check.state === 'none' ? ('question' as const) : ('warning' as const);
  ipcMain.handle('office:tmux-resume', async (e, id, action) => {
    trusted(e);
    if (typeof id !== 'string' || id.length > 400 || !['status', 'start', 'open'].includes(action))
      throw new Error(m().desktop.badRequest);
    if (isRemoteId(id)) throw new Error(m().federation.readOnly);
    const session: Session = await bridge.call('detail', [id]);
    if (action === 'status') {
      const [info, connections, duplicate] = await Promise.all([
        tmuxResume.status(session),
        projectConnections(session.cwd),
        duplicateCheck(session)(false),
      ]);
      return { ...info, duplicate, connections: connections.filter((c) => c.id === session.id) };
    }
    if (action === 'open') return tmuxResume.open(session);
    const skip = skipPermissions();
    return tmuxResume.start(
      { ...session, skipPermissions: skip },
      async (info, check) => {
        const connections = (await projectConnections(session.cwd)).filter(
          (c) => c.id === session.id,
        );
        const owner = BrowserWindow.fromWebContents(e.sender);
        const t = m().tmux;
        const options = {
          type: dialogType(check),
          title: t.title,
          message: t.confirm,
          detail: `${t.intro}\n\n${t.name}: ${info.name}\n${t.folder}: ${info.cwd}\n\n${t.caution}${skipNote(skip)}${duplicateNote(check)}${connections.length ? '\n\n' + t.existingConfirm + '\n' + connections.map((c) => c.name + ' · ' + c.label).join('\n') : ''}`,
          buttons: [t.cancel, t.start],
          defaultId: 0,
          cancelId: 0,
        };
        const endCardDialog = cards.dialog(e.sender);
        try {
          const result = owner
            ? await dialog.showMessageBox(owner, options)
            : await dialog.showMessageBox(options);
          return result.response === 1;
        } finally {
          endCardDialog();
        }
      },
      undefined,
      duplicateCheck(session),
    );
  });
  setupMiniShell();
  setupReader();
  ipcMain.handle('office:orca-launch', async (e, id, action) => {
    trusted(e);
    if (typeof id !== 'string' || id.length > 400 || !['status', 'start', 'focus'].includes(action))
      throw new Error(m().desktop.badRequest);
    if (isRemoteId(id)) throw new Error(m().federation.readOnly);
    const session: Session = await bridge.call('detail', [id]);
    if (action === 'focus') {
      // Only the conversation's own tab, matched again right now (never a jump's fallback).
      try {
        const text = await focusOrcaTab(
          session,
          defaultTerminalDeps(),
          (delivery.latest?.sessions ?? []).filter((other) => !other.remote),
        );
        cards.afterJump(e.sender);
        return { available: true, message: text };
      } catch (error) {
        if (error instanceof TerminalFocusError) throw new Error(error.message);
        throw new Error(m().desktop.terminal.jumpFailed('Orca'));
      }
    }
    const skip = skipPermissions();
    const saved = { ...session, skipPermissions: skip };
    if (action === 'status') {
      const [info, duplicate] = await Promise.all([
        orcaLaunch.status(saved),
        duplicateCheck(session)(false),
      ]);
      return { ...info, duplicate };
    }
    return orcaLaunch.start(
      saved,
      async (info, check) => {
        const owner = BrowserWindow.fromWebContents(e.sender);
        const t = m().tmux;
        const options = {
          type: dialogType(check),
          title: t.orcaTitle,
          message: t.orcaConfirm,
          detail: `${t.orcaIntro}\n\n${t.folder}: ${info.cwd}\n${t.orcaCommand}: ${info.command}\n\n${t.caution}${skipNote(skip)}${duplicateNote(check)}`,
          buttons: [t.cancel, t.orcaStart],
          defaultId: 0,
          cancelId: 0,
        };
        const endCardDialog = cards.dialog(e.sender);
        try {
          const result = owner
            ? await dialog.showMessageBox(owner, options)
            : await dialog.showMessageBox(options);
          return result.response === 1;
        } finally {
          endCardDialog();
        }
      },
      undefined,
      duplicateCheck(session),
    );
  });
  ipcMain.handle('office:remote-launch', async (e, id, action, value) => {
    trusted(e);
    if (
      typeof id !== 'string' ||
      id.length > 400 ||
      !isRemoteId(id) ||
      !['status', 'start'].includes(action)
    )
      throw Error(m().desktop.badRequest);
    const spec = launchSpecSchema.parse(value);
    const authorize = async () => {
      trusted(e);
      if (!(await terminalSendEnabled())) throw Error(m().desktop.terminal.enableFirst);
    };
    await authorize();
    const info = (await bridge.call('remote-launch', [id, spec], authorize)) as RemoteLaunchInfo;
    if (action === 'status') return info;
    if (!info.hosts[spec.host]) throw Error(m().tmux.remoteUnavailable);
    const t = m().tmux;
    const owner = BrowserWindow.fromWebContents(e.sender);
    const options = {
      type: 'question' as const,
      title: t.summonTitle,
      message: t.remoteConfirm,
      detail: `${info.office} · ${spec.host} · ${spec.provider}\n${t.folder}: ${info.cwd}\n${t.agentName}: ${spec.name}\n\n${t.remoteHint}\n\n${spec.initialMessage}`,
      buttons: [t.cancel, t.remoteStart],
      defaultId: 0,
      cancelId: 0,
    };
    const end = cards.dialog(e.sender);
    let response: number;
    try {
      response = (
        owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
      ).response;
    } finally {
      end();
    }
    if (response !== 1) return { ...info, status: 'cancelled' };
    return bridge.call(
      'remote-launch',
      [id, spec, { epoch: info.epoch, plan: info.plan, requestId: randomUUID() }],
      authorize,
    );
  });
  ipcMain.handle('office:tmux-summon', async (e, id, action, provider, name, initialMessage) => {
    trusted(e);
    if (typeof id !== 'string' || id.length > 400 || !['status', 'start', 'open'].includes(action))
      throw new Error(m().desktop.badRequest);
    if (!['claude', 'codex'].includes(provider)) throw new Error(m().desktop.badRequest);
    if (isRemoteId(id)) throw new Error(m().federation.readOnly);
    const original: Session = await bridge.call('detail', [id]);
    if (typeof name !== 'string') throw new Error(m().desktop.badRequest);
    const session = summonSession(original.cwd ?? '', provider, name, initialMessage);
    if (action === 'status')
      return {
        ...(await tmuxResume.status(session)),
        connections: await projectConnections(original.cwd),
      };
    if (action === 'open') return tmuxResume.open(session);
    const skip = skipPermissions();
    return tmuxResume.start({ ...session, skipPermissions: skip }, async (info) => {
      const connections = await projectConnections(original.cwd);
      const owner = BrowserWindow.fromWebContents(e.sender);
      const t = m().tmux;
      const options = {
        type: 'question' as const,
        title: t.summonTitle,
        message: t.summonConfirm,
        detail: `${t.summonIntro}\n\n${provider}\n${t.name}: ${info.name}\n${t.folder}: ${info.cwd}\n\n${t.summonHint}${skipNote(skip)}${session.initialMessage ? '\n\n' + t.initialMessage + ':\n' + session.initialMessage.slice(0, 500) + (session.initialMessage.length > 500 ? '…' : '') : ''}${connections.length ? '\n\n' + t.existingConfirm + '\n' + connections.map((c) => c.name + ' · ' + c.label).join('\n') : ''}`,
        buttons: [t.cancel, t.summonStart],
        defaultId: 0,
        cancelId: 0,
      };
      const endCardDialog = cards.dialog(e.sender);
      try {
        const result = owner
          ? await dialog.showMessageBox(owner, options)
          : await dialog.showMessageBox(options);
        return result.response === 1;
      } finally {
        endCardDialog();
      }
    });
  });
  ipcMain.handle('office:orca-summon', async (e, id, action, provider, name, initialMessage) => {
    trusted(e);
    if (typeof id !== 'string' || id.length > 400 || !['status', 'start'].includes(action))
      throw new Error(m().desktop.badRequest);
    if (!['claude', 'codex'].includes(provider) || typeof name !== 'string')
      throw new Error(m().desktop.badRequest);
    if (isRemoteId(id)) throw new Error(m().federation.readOnly);
    const original: Session = await bridge.call('detail', [id]);
    const skip = skipPermissions();
    // The same new agent as a tmux summon (name and first message checked the same way), in a
    // new Orca tab of the project's own registered folder; its name titles the tab.
    const fresh = summonSession(original.cwd ?? '', provider, name, initialMessage);
    const session = { ...fresh, alias: fresh.agentName, skipPermissions: skip };
    if (action === 'status') return orcaLaunch.status(session);
    const result = await orcaLaunch.start(session, async (info) => {
      const owner = BrowserWindow.fromWebContents(e.sender);
      const t = m().tmux;
      const options = {
        type: 'question' as const,
        title: t.summonTitle,
        message: t.summonOrcaConfirm,
        detail: `${t.summonOrcaIntro}\n\n${provider}\n${t.name}: ${info.name}\n${t.folder}: ${info.cwd}\n${t.orcaCommand}: ${info.command}${skipNote(skip)}`,
        buttons: [t.cancel, t.summonOrca],
        defaultId: 0,
        cancelId: 0,
      };
      const endCardDialog = cards.dialog(e.sender);
      try {
        const answer = owner
          ? await dialog.showMessageBox(owner, options)
          : await dialog.showMessageBox(options);
        return answer.response === 1;
      } finally {
        endCardDialog();
      }
    });
    return result.launched ? { ...result, message: m().tmux.summonOrcaLaunched } : result;
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
  /** Why `live` found no terminal, when the agent's records can tell (else the generic note). */
  const noTerminal = async (known: SessionIdentity) =>
    (known.provider === 'claude'
      ? await claudeNoTerminalReason(known.nativeId).catch(() => null)
      : null) ?? m().desktop.terminal.noTarget;
  const codex = (known: SessionIdentity, fresh = false) =>
    known.provider === 'codex'
      ? findCodexDestination(known.nativeId, known.sourcePath, { fresh })
      : null;
  /**
   * The conversation's Orca tab when no live agent process vouches for a terminal: a jump
   * destination only. Sending never uses it; it keeps requiring `live` or the Codex queue.
   */
  const orcaTab = (s: Session | undefined, fresh = false) =>
    s && !s.remote
      ? findOrcaTab(
          s,
          defaultTerminalDeps(),
          fresh,
          (delivery.latest?.sessions ?? []).filter((other) => !other.remote),
        ).catch(() => null)
      : null;
  const latestSession = (id: string) => delivery.latest?.sessions.find((s) => s.id === id);
  /**
   * The screen a live agent process vouches for. Only `none` (no live process, or every Codex
   * screen read and none shows the thread) lets the Orca tab stand in; `unknown` never does.
   */
  const screenOf = (
    known: SessionIdentity,
    fresh = false,
  ): Promise<TerminalLookup<{ host: TerminalHost }>> =>
    known.provider === 'claude'
      ? lookupTerminal(known.nativeId, { fresh })
      : known.provider === 'codex'
        ? lookupCodexTerminal(known.nativeId, { fresh })
        : Promise.resolve({ kind: 'none' });
  const sendTargets = async (ids: unknown) => {
    if (!Array.isArray(ids) || ids.length > 200 || ids.some((id) => typeof id !== 'string'))
      throw new Error(m().desktop.badRequest);
    const unique = [...new Set(ids as string[])];
    const found = await identify(unique).catch(() => new Map<string, SessionIdentity>());
    const wanted = new Set(unique);
    const sessions = new Map(
      (delivery.latest?.sessions ?? []).filter((s) => wanted.has(s.id)).map((s) => [s.id, s]),
    );
    const entries = await Promise.all(
      unique.map(async (id) => {
        try {
          const known = found.get(id);
          if (!known) return [id, null] as const;
          const unknown = { kind: 'unknown' } as const;
          if (known.provider !== 'codex') {
            const lookup =
              known.provider === 'claude'
                ? await lookupTerminal(known.nativeId).catch(() => unknown)
                : ({ kind: 'none' } as const);
            if (lookup.kind === 'found') return [id, terminalTarget(lookup.terminal)] as const;
            const tab = lookup.kind === 'none' ? await orcaTab(sessions.get(id)) : null;
            return [id, tab ? orcaTabTarget(tab) : null] as const;
          }
          // A screen can be present even while the queue's loaded-thread lookup is unavailable.
          const [thread, screen] = await Promise.all([
            Promise.resolve(codex(known)).catch(() => null),
            lookupCodexTerminal(known.nativeId).catch(() => unknown),
          ]);
          // With no screen at all, its Orca tab can still be jumped to (the queue stays the send).
          const host =
            screen.kind === 'found'
              ? screen.terminal.host
              : screen.kind === 'none'
                ? ((await orcaTab(sessions.get(id))) ?? undefined)
                : undefined;
          return [id, codexDestinationTarget(thread, host)] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );
    const remote = unique.filter(isRemoteId);
    const remoteTargets = remote.length ? await bridge.call('remote-targets', [remote]) : {};
    return { ...Object.fromEntries(entries), ...remoteTargets };
  };
  const projectConnections = async (cwd: string | null) => {
    const snapshot: Snapshot = await bridge.call('snapshot');
    const candidates = snapshot.sessions.filter(
      (s) =>
        !s.remote &&
        s.cwd &&
        cwd &&
        path.resolve(s.cwd) === path.resolve(cwd) &&
        ['claude', 'codex'].includes(s.provider),
    );
    const connections: NonNullable<import('../src/shared/types.js').TmuxResumeInfo['connections']> =
      [];
    const seenTmux = new Set<string>();
    for (const s of candidates) {
      const terminal =
        s.provider === 'claude'
          ? await locateTerminal(s.nativeId, { fresh: true })
          : await findCodexTerminal(s.nativeId, { fresh: true });
      if (terminal) {
        connections.push({ id: s.id, name: s.alias || s.title, label: hostName(terminal.host) });
        if (terminal.host.kind === 'tmux') seenTmux.add(terminal.host.label.split(':')[0]);
      }
    }
    if (cwd)
      connections.push(
        ...(await tmuxResume.connections(cwd)).filter((c) => !seenTmux.has(c.label)),
      );
    return connections;
  };
  // Adopt a launch name only once, after an exact native-session -> owned tmux pane match.
  // It is stored as the normal personal alias; later manual edits (including clearing) win.
  // The same match also tags the summoned tmux session with the conversation it runs, so its
  // resume, jump and the duplicate-launch check find that session by the conversation's id.
  // The tag follows whichever conversation the pane runs now (a pane can switch back and forth),
  // so it is re-checked every round; `adopt` writes only when it changed.
  let naming = false;
  const named = new Set<string>();
  const nameTimer = setInterval(async () => {
    if (naming) return;
    naming = true;
    try {
      const folders = await tmuxResume.namedFolders();
      if (!folders.size) return;
      const snapshot: Snapshot = await bridge.call('snapshot');
      for (const s of snapshot.sessions.filter(
        (s) =>
          !s.remote &&
          s.cwd &&
          folders.has(path.resolve(s.cwd)) &&
          ['claude', 'codex'].includes(s.provider),
      )) {
        const terminal =
          s.provider === 'claude'
            ? await locateTerminal(s.nativeId)
            : await findCodexTerminal(s.nativeId);
        if (!terminal || terminal.host.kind !== 'tmux') continue;
        await tmuxResume
          .adopt(terminal.host, s.provider as 'claude' | 'codex', s.nativeId)
          .catch(() => false);
        if (named.has(s.id)) continue;
        const alias = await tmuxResume.aliasFor(terminal.host, s.id).catch(() => null);
        if (!alias) continue;
        const current: Session = await bridge.call('detail', [s.id]);
        if (!current.alias) await bridge.call('patch', [s.id, { alias }]);
        await tmuxResume.claimAlias(terminal.host, s.id);
        named.add(s.id);
      }
    } catch {
      /* A collector restart or disappearing terminal retries next time. */
    } finally {
      naming = false;
    }
  }, 10000);
  nameTimer.unref();
  app.once('before-quit', () => clearInterval(nameTimer));
  ipcMain.handle('office:terminals', (e, ids) => {
    trusted(e);
    return sendTargets(ids);
  });
  ipcMain.handle('office:jump', async (e, id): Promise<JumpResult> => {
    trusted(e);
    const known = await identity(id);
    // The message queue and the visible screen are separate destinations.
    const screen = await screenOf(known, true);
    const tab = screen.kind === 'none' ? await orcaTab(latestSession(known.id), true) : null;
    const terminal = screen.kind === 'found' ? screen.terminal : tab ? { host: tab } : null;
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
    // Already on (another window turned it on meanwhile): no second confirmation.
    if (enable && (await terminalSendEnabled())) return true;
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
    desktopSettingsChanged();
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
  // The renderer hands over an image's bytes; main checks them and keeps the file. Only an
  // opaque id goes back: a send names ids, never paths.
  ipcMain.handle('office:attach-image', async (e, bytes) => {
    trusted(e);
    try {
      return await attachments().save(bytes);
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      throw new Error(m().desktop.badFile);
    }
  });
  // A thumbnail again, for a composer window that was recreated: bytes of this store's own
  // files only, by id. Never a path, never a file elsewhere.
  ipcMain.handle('office:attachment-preview', async (e, id) => {
    trusted(e);
    return attachments().preview(id);
  });
  const sendMessage = async (
    id: unknown,
    text: unknown,
    options?: { replaceDraft?: string; allowPartialDraft?: boolean; images?: unknown },
    authorized?: () => Promise<void>,
  ): Promise<SendResult> => {
    if (typeof text !== 'string' || text.length > 20000) throw new Error(m().desktop.badRequest);
    // Ids only, resolved to this app's own files; anything else refuses the send.
    const images = await attachments().resolveAll(options?.images);
    const replaceDraft: unknown = options?.replaceDraft;
    const allowPartialDraft: unknown = options?.allowPartialDraft;
    if (
      (options != null && typeof options !== 'object') ||
      (allowPartialDraft !== undefined && typeof allowPartialDraft !== 'boolean') ||
      (allowPartialDraft === true && replaceDraft === undefined) ||
      (replaceDraft !== undefined &&
        (typeof replaceDraft !== 'string' || replaceDraft.length > 20000))
    )
      throw new Error(m().desktop.badRequest);
    if (!(await terminalSendEnabled())) throw new Error(m().desktop.terminal.enableFirst);
    await authorized?.();
    if (isRemoteId(id)) {
      if (images.length) throw new Error(m().desktop.terminal.imagesUnsupported);
      if (replaceDraft !== undefined) throw new Error(m().federation.remoteDraft);
      return bridge.call('remote-send', [id, text, randomUUID()], async () => {
        await authorized?.();
        if (!(await terminalSendEnabled())) throw new Error(m().desktop.terminal.enableFirst);
      });
    }
    const known = await identity(id);
    // Each agent's adapter says how a follow-up reaches it: its queue (Codex, no composer
    // involved) or its terminal (the composer is read, and cleared only when confirmed).
    const composer = composerFor(known.provider);
    const delivery = composer.capabilities(null).delivery;
    if (delivery === 'none') throw new Error(m().desktop.terminal.unsupportedAgent(composer.agent));
    // Each adapter says whether images reach its agent at all (the Codex transports both do).
    if (images.length && !composer.capabilities(null).images)
      throw new Error(m().desktop.terminal.imagesUnsupported);
    const thread = delivery === 'queue' ? await codex(known, true) : null;
    if (delivery === 'queue' && !thread) throw new Error(m().desktop.terminal.noTarget);
    if (thread)
      try {
        return {
          status: 'sent',
          message: await sendToCodex(
            thread,
            text,
            undefined,
            async () => {
              await authorized?.();
              if (!(await terminalSendEnabled()))
                throw new TerminalInputError(m().desktop.terminal.enableFirst);
            },
            images,
          ),
          ...(!codexRecordsRequest(thread, text, images) && { unrecorded: true }),
        };
      } catch (error) {
        if (error instanceof TerminalInputError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new Error(m().desktop.terminal.codexMissing);
        throw new Error(m().desktop.terminal.codexUnconfirmed);
      }
    const terminal = await live(known, true);
    if (!terminal) throw new Error(await noTerminal(known));
    try {
      return await sendToTerminal(terminal, text, undefined, {
        composer,
        replaceDraft,
        allowPartialDraft: allowPartialDraft === true,
        beforeSend: authorized,
        // The main process writes the clipboard: no permission prompt, nothing in the renderer.
        backup: async (draft) => clipboard.writeText(draft),
        clipboardText: () => clipboard.readText(),
        images,
      });
    } catch (error) {
      if (error instanceof TerminalInputError) throw error;
      // The text may already be in the terminal; never invite a blind resend.
      throw new Error(m().desktop.terminal.unconfirmed(hostName(terminal.host)));
    } finally {
      forgetTerminal(terminal.process.sessionId);
    }
  };
  ipcMain.handle('office:send', (e, id, text, options) => {
    trusted(e);
    return sendMessage(id, text, options);
  });
  mobile = new MobileServer(app.getPath('userData'), path.join(root, 'dist'), {
    snapshot: () => bridge.call('snapshot'),
    detail: (id, page) => bridge.call('detail', [id, page]),
    targets: sendTargets,
    send: (id, text, authorized) => sendMessage(id, text, undefined, authorized),
    sendEnabled: terminalSendEnabled,
  });
  void mobile.restore();
  ipcMain.handle('office:mobile', (e, command) => {
    trusted(e);
    return mobile!.command(command);
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
      desktopSettingsChanged();
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
/**
 * The desktop-only settings (terminal send, answering) live outside the shared snapshot; after
 * one changes, every app window re-reads them so a switch flipped in one window shows in all.
 */
function desktopSettingsChanged() {
  for (const w of [main, dock, settingsWindow, ...(cards?.windows() ?? [])])
    if (w && !w.isDestroyed()) w.webContents.send('office:desktop-settings');
}
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const terminalSendFile = () => path.join(app.getPath('userData'), 'terminal-send.json');
let attachmentStore: AttachmentStore | undefined;
/** Images attached in the composer: `<userData>/attachments`, files this app wrote only. */
const attachments = () =>
  (attachmentStore ??= new AttachmentStore(path.join(app.getPath('userData'), 'attachments')));
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
  // A live background session is opened where it runs: `--resume` would start a second copy.
  const attach =
    s.provider === 'claude' ? await claudeAttachCommand(s.nativeId).catch(() => null) : null;
  if (attach) return { action: 'copy', text: attach };
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
  void (async () => {
    await mobile?.close();
    await bridge.close();
  })().finally(() => {
    collectorClosed = true;
    app.quit();
  });
});
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});
