import type { OfficeAPI } from '../shared/types';
import type { SnapshotMessage } from '../shared/snapshot-patch';
import { parseArtifact } from '../shared/office';
import { m } from '../shared/i18n';
import { webLink } from '../shared/links';
import { isPageHidden, onPageVisibility } from './visibility';
declare global {
  interface Window {
    office?: OfficeAPI;
  }
}
const rpc = async (method: string, ...args: unknown[]) => {
  const r = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Office': '1' },
    body: JSON.stringify({ method, args }),
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error ?? m().shared.api.checkConnection);
  return data.result;
};
export const isDesktop = !!window.office;
export const api: OfficeAPI = window.office ?? {
  quotas: () => rpc('quotas'),
  snapshot: () => rpc('snapshot'),
  detail: (id, page) => rpc('detail', id, page),
  visit: (id) => rpc('visit', id),
  notices: (receipts, action) => rpc('notices', receipts, action),
  noticePage: (request) => rpc('noticePage', request),
  noticeReadAll: (query, asOf) => rpc('noticeReadAll', query, asOf),
  returnToOffice: (id) => rpc('returnToOffice', id),
  artifacts: (id) => rpc('artifacts', id),
  openArtifact: async (url) => {
    const artifact = parseArtifact(url);
    if (artifact) window.open(artifact.url, '_blank', 'noopener,noreferrer');
  },
  openLink: async (url) => {
    const link = webLink(url);
    if (link) window.open(link, '_blank', 'noopener,noreferrer');
  },
  copyText: (text) => navigator.clipboard.writeText(text),
  refresh: () => rpc('refresh'),
  patch: (id, p) => rpc('patch', id, p),
  veil: (ids, on) => rpc('veil', ids, on),
  pin: (ids, on) => rpc('pin', ids, on),
  search: (q, p) => rpc('search', q, p),
  handoff: (id, r) => rpc('handoff', id, r),
  preferences: (p) => rpc('preferences', p),
  subscribe: (cb, since) => {
    // Polls only while the tab is visible, and says which version it holds: an office that did
    // not change answers in a few bytes, one that did sends only what changed.
    let active = true,
      running = false;
    const poll = async () => {
      if (running || isPageHidden()) return;
      running = true;
      try {
        const held = since?.();
        const m: SnapshotMessage | { unchanged: true } = await rpc(
          'snapshot',
          held?.epoch ?? null,
          held?.version ?? null,
        );
        if (active && !('unchanged' in m)) cb(m);
      } catch {
        /* initial fetch and refresh expose failures */
      } finally {
        running = false;
      }
    };
    const t = setInterval(poll, 5000);
    const stop = onPageVisibility(() => void poll());
    return () => {
      active = false;
      clearInterval(t);
      stop();
    };
  },
  window: async (action, id) => {
    if (action === 'mini') {
      location.hash = 'mini';
      location.reload();
    } else if (action === 'main') {
      location.hash = id ? `session=${encodeURIComponent(id)}` : '';
      location.reload();
    }
  },
  reveal: async () => {
    throw new Error(m().shared.api.revealDesktopOnly);
  },
  resume: async (id) => {
    const s = await rpc('detail', id);
    return s.provider === 'claude'
      ? `claude --resume '${String(s.nativeId).replace(/'/g, "'\\''")}'`
      : s.nativeId;
  },
  exportFile: async (name, content) => {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  },
};
