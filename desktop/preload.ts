import { contextBridge, ipcRenderer } from 'electron';
import type { OfficeAPI, Snapshot } from '../src/shared/types.js';
const call = (method: string, ...args: unknown[]) =>
  ipcRenderer.invoke('office:call', method, args);
const api: OfficeAPI = {
  quotas: () => call('quotas'),
  snapshot: () => call('snapshot'),
  detail: (id) => call('detail', id),
  visit: (id) => call('visit', id),
  notices: (receipts, action) => call('notices', receipts, action),
  returnToOffice: (id) => call('returnToOffice', id),
  artifacts: (id) => call('artifacts', id),
  openArtifact: (url) => ipcRenderer.invoke('office:open-artifact', url),
  refresh: () => call('refresh'),
  patch: (id, p) => call('patch', id, p),
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
  exportFile: (name, content) => ipcRenderer.invoke('office:export', name, content),
  onSelect: (cb) => {
    const f = (_: unknown, id: string) => cb(id);
    ipcRenderer.on('office:select', f);
    return () => ipcRenderer.removeListener('office:select', f);
  },
};
contextBridge.exposeInMainWorld('office', api);
