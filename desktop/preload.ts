import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { CardTarget, DockMode, OfficeAPI } from '../src/shared/types.js';
import type { SnapshotMessage } from '../src/shared/snapshot-patch.js';
const call = (method: string, ...args: unknown[]) =>
  ipcRenderer.invoke('office:call', method, args);
// Electron prefixes main-process errors; terminal actions show their message to the person.
const action = (channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args).catch((e: Error) => {
    throw new Error(e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
  });
const api: OfficeAPI = {
  appHealth: () => action('office:app-health'),
  openPrivacy: (pane) => action('office:privacy-settings', pane),
  mobile: (command) => action('office:mobile', command),
  remoteLaunch: (id, phase, spec) => action('office:remote-launch', id, phase, spec),
  federation: (command) => action('office:federation', command),
  quotas: () => call('quotas'),
  snapshot: () => call('snapshot'),
  detail: (id, page) => call('detail', id, page),
  visit: (id) => call('visit', id),
  notices: (receipts, action) => call('notices', receipts, action),
  readReplies: (sessionId, asOf) => call('readReplies', sessionId, asOf),
  returnToOffice: (id) => call('returnToOffice', id),
  artifacts: (id) => call('artifacts', id),
  openArtifact: (url) => ipcRenderer.invoke('office:open-artifact', url),
  openLink: (url) => action('office:open-link', url),
  openFile: (path) => action('office:open-file', path),
  copyText: (text) => action('office:copy', text),
  startupRelease: () => ipcRenderer.invoke('office:startup-release'),
  refresh: () => call('refresh'),
  patch: (id, p) => call('patch', id, p),
  veil: (ids, on) => call('veil', ids, on),
  pin: (ids, on) => call('pin', ids, on),
  reorderSeats: (ids) => call('reorderSeats', ids),
  search: (q, p) => call('search', q, p),
  bookmarks: (query) => call('bookmarks', query),
  bookmark: (sessionId, eventId, note) => call('bookmark', sessionId, eventId, note),
  unbookmark: (id) => call('unbookmark', id),
  unbookmarkMessage: (sessionId, eventId) => call('unbookmarkMessage', sessionId, eventId),
  bookmarkNote: (id, note) => call('bookmarkNote', id, note),
  bookmarkById: (id) => call('bookmarkById', id),
  outputs: (query) => call('outputs', query),
  outputAction: (what, id) => action('office:output', what, id),
  outputPreview: (id) => call('outputPreview', id),
  bookmarkWindow: ((what: string, target?: unknown) =>
    action('office:reader-window', what, target)) as OfficeAPI['bookmarkWindow'],
  onReaderRefresh: (cb) => {
    const f = () => cb();
    ipcRenderer.on('office:reader-refresh', f);
    return () => ipcRenderer.removeListener('office:reader-refresh', f);
  },
  onPopupOnTop: (cb) => {
    const f = (_: unknown, on: boolean) => cb(on === true);
    ipcRenderer.on('office:popup-on-top', f);
    return () => ipcRenderer.removeListener('office:popup-on-top', f);
  },
  handoff: (id, r) => call('handoff', id, r),
  preferences: (p) => call('preferences', p),
  subscribe: (callback, _since, health) => {
    const f = (_: unknown, s: SnapshotMessage) => callback(s);
    const h = (_: unknown, error: string | null) => health?.(error);
    ipcRenderer.on('office:snapshot', f);
    ipcRenderer.on('office:health', h);
    return () => {
      ipcRenderer.removeListener('office:snapshot', f);
      ipcRenderer.removeListener('office:health', h);
    };
  },
  visible: () => ipcRenderer.invoke('office:visible'),
  onVisibility: (cb) => {
    const f = (_: unknown, shown: boolean) => cb(shown);
    ipcRenderer.on('office:visibility', f);
    return () => ipcRenderer.removeListener('office:visibility', f);
  },
  window: (action, id) => ipcRenderer.invoke('office:window', action, id),
  reveal: (id) => ipcRenderer.invoke('office:reveal', id),
  ...(['darwin', 'linux'].includes(process.platform)
    ? {
        shell: {
          command: (command: unknown) => action('office:shell', command),
          input: (ptyId: string, data: string) =>
            ipcRenderer.send('office:shell-input', ptyId, data),
          onData: (cb: (ptyId: string, data: string) => void) => {
            const f = (_: unknown, ptyId: string, data: string) => cb(ptyId, data);
            ipcRenderer.on('office:shell-data', f);
            return () => ipcRenderer.removeListener('office:shell-data', f);
          },
          onExit: (cb: (ptyId: string) => void) => {
            const f = (_: unknown, ptyId: string) => cb(ptyId);
            ipcRenderer.on('office:shell-exit', f);
            return () => ipcRenderer.removeListener('office:shell-exit', f);
          },
          window: (what: string, target?: unknown) => action('office:shell-window', what, target),
        } as OfficeAPI['shell'],
        // The built-in terminal's window (#401): its own view only.
        term: {
          command: (command: unknown) => action('office:term', command),
          input: (viewId: string, data: string) =>
            ipcRenderer.send('office:term-input', viewId, data),
          onData: (cb: (viewId: string, data: Uint8Array) => void) => {
            const f = (_: unknown, viewId: string, data: Uint8Array) => cb(viewId, data);
            ipcRenderer.on('office:term-data', f);
            return () => ipcRenderer.removeListener('office:term-data', f);
          },
          onResync: (cb: (viewId: string, restore: string, cols: number, rows: number) => void) => {
            const f = (_: unknown, viewId: string, restore: string, cols: number, rows: number) =>
              cb(viewId, restore, cols, rows);
            ipcRenderer.on('office:term-resync', f);
            return () => ipcRenderer.removeListener('office:term-resync', f);
          },
          onExit: (
            cb: (viewId: string, exit: { code: number | null; signal: number | null }) => void,
          ) => {
            const f = (
              _: unknown,
              viewId: string,
              exit: { code: number | null; signal: number | null },
            ) => cb(viewId, exit);
            ipcRenderer.on('office:term-exit', f);
            return () => ipcRenderer.removeListener('office:term-exit', f);
          },
          onLost: (cb: (viewId: string) => void) => {
            const f = (_: unknown, viewId: string) => cb(viewId);
            ipcRenderer.on('office:term-lost', f);
            return () => ipcRenderer.removeListener('office:term-lost', f);
          },
          window: (what: string) => action('office:term-window', what),
        } as OfficeAPI['term'],
        // Settings › 내장 터미널: the background sessions and what to do with one.
        builtinTerminals: {
          list: () => action('office:builtin-terminals', 'list'),
          act: (session: string, what: string) =>
            action('office:builtin-terminals', 'act', session, what),
          manager: () => action('office:builtin-terminals', 'manager'),
        } as OfficeAPI['builtinTerminals'],
        // The terminal manager's window: its list, the session it shows, previews, actions.
        termManager: {
          list: () => action('office:term-manager', 'list'),
          selected: () => action('office:term-manager', 'selected'),
          select: (session: string) => action('office:term-manager', 'select', session),
          preview: (sessions: string[]) => action('office:term-manager', 'preview', sessions),
          act: (session: string, what: string) =>
            action('office:term-manager', 'act', session, what),
          onSelect: (cb: (session: string) => void) => {
            const f = (_: unknown, session: string) => cb(session);
            ipcRenderer.on('office:term-manager-select', f);
            return () => ipcRenderer.removeListener('office:term-manager-select', f);
          },
        } as OfficeAPI['termManager'],
        // Both terminal windows: paste where the keyboard is, and a dropped file's path.
        termView: {
          paste: () => action('office:term-paste'),
          pathForFile: (file: File) => webUtils.getPathForFile(file),
        },
      }
    : {}),
  // Orca is a macOS app: bringing it to the front is offered there only.
  ...(process.platform === 'darwin'
    ? {
        orcaReveal: (id?: string) => action('office:orca-reveal', id),
        orcaSleeping: (id: string) => action('office:orca-sleeping', id),
      }
    : {}),
  // Every destination says itself whether this platform has it (desktop/launch/).
  launch: (request) => action('office:launch', request),
  launchOptions: (intent) => action('office:launch-options', intent),
  launchSupport: () => action('office:launch-support'),
  resume: (id) => ipcRenderer.invoke('office:resume', id),
  terminals: (ids) => action('office:terminals', ids),
  jump: (id) => action('office:jump', id),
  send: (id, text, options) => action('office:send', id, text, options),
  renameSession: (id, title) => action('office:rename-session', id, title),
  attachImage: (bytes) => action('office:attach-image', bytes),
  attachmentPreview: (id) => action('office:attachment-preview', id),
  inspectDraft: (id) => action('office:inspect-draft', id),
  composerDraft: (id) => action('office:composer-draft', id),
  submitDraft: (id, text, options) =>
    action(
      'office:submit-draft',
      id,
      text,
      options?.suggestion === true ? { suggestion: true } : {},
    ),
  terminalSend: (enable) => action('office:terminal-send', enable),
  prompt: (id) => action('office:prompt', id),
  answer: (id, choice) => action('office:answer', id, choice),
  answerSettings: (patch) => action('office:answer-settings', patch),
  onDesktopSettings: (cb) => {
    const f = () => cb();
    ipcRenderer.on('office:desktop-settings', f);
    return () => ipcRenderer.removeListener('office:desktop-settings', f);
  },
  card: (what, target, anchor) => ipcRenderer.invoke('office:card', what, target, anchor),
  onCard: (cb) => {
    const f = (_: unknown, target: CardTarget | null) => cb(target);
    ipcRenderer.on('office:card', f);
    return () => ipcRenderer.removeListener('office:card', f);
  },
  cardState: () => action('office:card-state'),
  onCardState: (cb) => {
    const f = (_: unknown, state: import('../src/shared/types.js').CardWindowState) => cb(state);
    ipcRenderer.on('office:card-state', f);
    return () => ipcRenderer.removeListener('office:card-state', f);
  },
  exportFile: (name, content) => ipcRenderer.invoke('office:export', name, content),
  onSelect: (cb) => {
    const f = (_: unknown, id: string, bookmark?: { eventId: string; at: number }) =>
      cb(id, bookmark);
    ipcRenderer.on('office:select', f);
    return () => ipcRenderer.removeListener('office:select', f);
  },
  selected: (id) => ipcRenderer.send('office:selected', id),
  settings: {
    open: (section) => ipcRenderer.invoke('office:settings', section ?? null),
    onOpen: (cb) => {
      const f = (_: unknown, section: import('../src/shared/settings.js').SettingsSection | null) =>
        cb(section);
      ipcRenderer.on('office:settings', f);
      return () => ipcRenderer.removeListener('office:settings', f);
    },
  },
  dock: (action) => ipcRenderer.invoke('office:dock', action),
  dockLook: () => ipcRenderer.invoke('office:dock-look'),
  onDockLook: (cb) => {
    const f = (_: unknown, look: unknown) => cb(look);
    ipcRenderer.on('office:dock-look', f);
    return () => ipcRenderer.removeListener('office:dock-look', f);
  },
  onDock: (cb) => {
    const f = (_: unknown, mode: DockMode, tiny?: boolean) => cb(mode, tiny);
    ipcRenderer.on('office:dock', f);
    return () => ipcRenderer.removeListener('office:dock', f);
  },
  onDockSide: (cb) => {
    const f = (_: unknown, side: 'left' | 'right') => cb(side === 'left' ? 'left' : 'right');
    ipcRenderer.on('office:dock-side', f);
    return () => ipcRenderer.removeListener('office:dock-side', f);
  },
};
contextBridge.exposeInMainWorld('office', api);
