import { useSyncExternalStore } from 'react';
import { clampFontSize, TERM_FONT } from '../shared/term-keys';

/**
 * The terminal windows' text size (Settings › Terminal, ⌘= / ⌘- / ⌘0 in a terminal). A per-viewer
 * convenience kept in this computer's storage: every window of the app shares it, and the
 * `storage` event carries a change to the other open terminal windows at once.
 */
const KEY = 'office:term-font-size';
const listeners = new Set<() => void>();

export function termFontSize(): number {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === null ? TERM_FONT.default : clampFontSize(saved);
  } catch {
    return TERM_FONT.default;
  }
}

export function setTermFontSize(size: number) {
  const next = clampFontSize(size);
  try {
    if (next === TERM_FONT.default) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(next));
  } catch {
    /* storage unavailable: the size still applies to this window */
  }
  for (const f of listeners) f();
}

/** Calls `f` when the size changes here or in another window. */
export function onTermFontSize(f: () => void): () => void {
  const storage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) f();
  };
  listeners.add(f);
  window.addEventListener('storage', storage);
  return () => {
    listeners.delete(f);
    window.removeEventListener('storage', storage);
  };
}

export const useTermFontSize = () => useSyncExternalStore(onTermFontSize, termFontSize);
