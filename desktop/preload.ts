import { contextBridge, ipcRenderer } from 'electron';
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
  mobile: (command) => action('office:mobile', command),
  federation: (command) => action('office:federation', command),
  quotas: () => call('quotas'),
  snapshot: () => call('snapshot'),
  detail: (id, page) => call('detail', id, page),
  visit: (id) => call('visit', id),
  notices: (receipts, action) => call('notices', receipts, action),
  noticePage: (request) => call('noticePage', request),
  noticeReadAll: (query, asOf) => call('noticeReadAll', query, asOf),
  returnToOffice: (id) => call('returnToOffice', id),
  artifacts: (id) => call('artifacts', id),
  openArtifact: (url) => ipcRenderer.invoke('office:open-artifact', url),
  openLink: (url) => action('office:open-link', url),
  openFile: (path) => action('office:open-file', path),
  copyText: (text) => action('office:copy', text),
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
  handoff: (id, r) => call('handoff', id, r),
  preferences: (p) => call('preferences', p),
  subscribe: (callback) => {
    const f = (_: unknown, s: SnapshotMessage) => callback(s);
    ipcRenderer.on('office:snapshot', f);
    return () => ipcRenderer.removeListener('office:snapshot', f);
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
        tmuxSummon: (
          id: string,
          actionName: 'status' | 'start' | 'open',
          provider: 'claude' | 'codex',
          name: string,
          initialMessage?: string,
        ) => action('office:tmux-summon', id, actionName, provider, name, initialMessage),
        tmuxResume: (id: string, actionName: 'status' | 'start' | 'open') =>
          action('office:tmux-resume', id, actionName),
      }
    : {}),
  resume: (id) => ipcRenderer.invoke('office:resume', id),
  terminals: (ids) => action('office:terminals', ids),
  jump: (id) => action('office:jump', id),
  send: (id, text, options) => action('office:send', id, text, options),
  inspectDraft: (id) => action('office:inspect-draft', id),
  terminalSend: (enable) => action('office:terminal-send', enable),
  prompt: (id) => action('office:prompt', id),
  answer: (id, choice) => action('office:answer', id, choice),
  answerSettings: (patch) => action('office:answer-settings', patch),
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
    const f = (_: unknown, id: string) => cb(id);
    ipcRenderer.on('office:select', f);
    return () => ipcRenderer.removeListener('office:select', f);
  },
  dock: (action) => ipcRenderer.invoke('office:dock', action),
  onDock: (cb) => {
    const f = (_: unknown, mode: DockMode) => cb(mode);
    ipcRenderer.on('office:dock', f);
    return () => ipcRenderer.removeListener('office:dock', f);
  },
};
contextBridge.exposeInMainWorld('office', api);
