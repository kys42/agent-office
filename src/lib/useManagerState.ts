import { useSyncExternalStore } from 'react';
import { api } from './api';
import type { ManagerState } from '../shared/manager';

// One status subscription per renderer, shared by the office and reception desk.
let state: ManagerState | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let reading = false;
const listeners = new Set<() => void>();
async function refresh() {
  if (reading || !api.manager || document.hidden) return;
  reading = true;
  try {
    state = await api.manager({ action: 'status' });
    for (const listener of listeners) listener();
  } catch {
    /* The manager panel reports connection errors and provides retry. */
  } finally {
    reading = false;
  }
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    void refresh();
    timer = setInterval(refresh, 2000);
    document.addEventListener('visibilitychange', refresh);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
      document.removeEventListener('visibilitychange', refresh);
    }
  };
}
const none = () => () => {};
export function useManagerState(enabled = true) {
  return useSyncExternalStore(
    enabled && api.manager ? subscribe : none,
    () => (enabled && api.manager ? state : undefined),
    () => undefined,
  );
}
