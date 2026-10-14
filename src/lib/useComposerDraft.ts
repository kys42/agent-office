import { useCallback, useRef, useState, useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
// If storage is unavailable, keep edits through unmounts in this window.
const unsaved = new Map<string, string>();

function read(key: string) {
  if (unsaved.has(key)) return unsaved.get(key)!;
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function write(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
    unsaved.delete(key);
  } catch {
    unsaved.set(key, value);
  }
  for (const listener of listeners) listener();
}

/** Write on each edit: a native popup can disappear without an unmount/blur callback. */
export function useComposerDraft(draftKey?: string) {
  const key = draftKey ? `office:reply-draft:v1:${draftKey}` : null;
  const [localText, setLocalText] = useState('');
  const local = useRef('');
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => {};
      listeners.add(listener);
      const changed = (event: StorageEvent) => {
        if (event.key !== key && event.key !== null) return;
        unsaved.delete(key);
        listener();
      };
      window.addEventListener('storage', changed);
      return () => {
        listeners.delete(listener);
        window.removeEventListener('storage', changed);
      };
    },
    [key],
  );
  const snapshot = useCallback(() => (key ? read(key) : ''), [key]);
  const saved = useSyncExternalStore(subscribe, snapshot, () => '');
  const setText = (value: string) => {
    if (key) write(key, value);
    else {
      local.current = value;
      setLocalText(value);
    }
  };
  return {
    text: key ? saved : localText,
    setText,
    // Sending may finish after closing the popup or editing from another window.
    // Clear only the text that actually went out, using the captured destination key.
    clearText: (sent: string) => {
      if ((key ? read(key) : local.current) !== sent) return;
      setText('');
    },
  };
}
