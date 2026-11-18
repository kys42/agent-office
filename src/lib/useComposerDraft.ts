import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { addToDraft } from '../shared/bubble-share';

const listeners = new Set<() => void>();
const storageKey = (draftKey: string) => `office:reply-draft:v1:${draftKey}`;

/** A colleague's chat box draft, kept per run (the card's `draftKey`), not per window. */
export function replyDraftKey(id: string, demo: boolean) {
  return `${demo ? 'demo' : 'live'}:${id}`;
}
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

/**
 * Puts handed text after what a colleague's chat box already holds (bubbles handed on from
 * another card, #377), as a draft only: its card, open here or in another window, shows it and
 * nothing is sent. False, and nothing changes, when the two would not fit the box.
 */
export function addToComposerDraft(draftKey: string, text: string) {
  const key = storageKey(draftKey);
  const next = addToDraft(read(key), text);
  if (next === null) return false;
  write(key, next);
  return true;
}

/** Write on each edit: a native popup can disappear without an unmount/blur callback. */
export function useComposerDraft(draftKey?: string) {
  const key = draftKey ? storageKey(draftKey) : null;
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
