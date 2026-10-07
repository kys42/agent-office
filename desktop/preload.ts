import { contextBridge, ipcRenderer } from 'electron';
import type { CardTarget, DockMode, OfficeAPI, Snapshot } from '../src/shared/types.js';
const call = (method: string, ...args: unknown[]) =>
  ipcRenderer.invoke('office:call', method, args);
// Electron prefixes main-process errors; terminal actions show their message to the person.
const action = (channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args).catch((e: Error) => {
    throw new Error(e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
  });
const api: OfficeAPI = {
  quotas: () => call('quotas'),
  snapshot: () => call('snapshot'),
  detail: (id) => call('detail', id),
  visit: (id) => call('visit', id),
  notices: (receipts, action) => call('notices', receipts, action),
  returnToOffice: (id) => call('returnToOffice', id),
  artifacts: (id) => call('artifacts', id),
  openArtifact: (url) => ipcRenderer.invoke('office:open-artifact', url),
  openLink: (url) => action('office:open-link', url),
  copyText: (text) => action('office:copy', text),
  refresh: () => call('refresh'),
  patch: (id, p) => call('patch', id, p),
  veil: (ids, on) => call('veil', ids, on),
  pin: (ids, on) => call('pin', ids, on),
  search: (q, p) => call('search', q, p),
  handoff: (id, r) => call('handoff', id, r),
  preferences: (p) => call('preferences', p),
  subscribe: (callback) => {
    const f = (_: unknown, s: Snapshot) => callback(s);
    ipcRenderer.on('office:snapshot', f);
    return () => ipcRenderer.removeListener('office:snapshot', f);
  },
  window: (action, id) => ipcRenderer.invoke('office:window', action, id),
  reveal: (id) => ipcRenderer.invoke('office:reveal', id),
  resume: (id) => ipcRenderer.invoke('office:resume', id),
  terminals: (ids) => action('office:terminals', ids),
  jump: (id) => action('office:jump', id),
  send: (id, text) => action('office:send', id, text),
  terminalSend: (enable) => action('office:terminal-send', enable),
  card: (what, target, anchor) => ipcRenderer.invoke('office:card', what, target, anchor),
  onCard: (cb) => {
    const f = (_: unknown, target: CardTarget | null) => cb(target);
    ipcRenderer.on('office:card', f);
    return () => ipcRenderer.removeListener('office:card', f);
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
