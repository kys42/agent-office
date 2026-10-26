import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react';
import { IMAGE_MIME, MAX_IMAGE_BYTES, MAX_IMAGES } from '../shared/attachments';
import { m } from '../shared/i18n';
import { api } from './api';

/** An image attached in the composer: the id main gave back, and a local preview. */
export interface ComposerImage {
  id: string;
  /** Object URL of the bytes picked in this window (never a file path). */
  url: string;
  name: string;
}

/**
 * Attached images per composer, in memory only: they survive closing and reopening a card in
 * this window, never an app restart (the text draft is the part that is saved).
 */
const store = new Map<string, ComposerImage[]>();
const listeners = new Set<() => void>();
const EMPTY: ComposerImage[] = [];
const get = (key: string) => store.get(key) ?? EMPTY;
function set(key: string, next: ComposerImage[]) {
  if (next.length) store.set(key, next);
  else store.delete(key);
  for (const listener of listeners) listener();
}

/** Image files among dropped or pasted items. */
export const imageFiles = (files: Iterable<File> | ArrayLike<File> | null | undefined) =>
  Array.from(files ?? []).filter((file) => file.type.startsWith('image/'));

/**
 * Images for one composer (`draftKey`, or one of its own). `add` checks type, size and count
 * here for a quick answer, hands the bytes to the desktop app (which checks them again and keeps
 * the file) and keeps the returned id; the send carries ids only.
 */
export function useComposerImages(draftKey?: string) {
  const own = useId();
  const key = draftKey ? `images:${draftKey}` : `images:own:${own}`;
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  const images = useSyncExternalStore(
    subscribe,
    () => get(key),
    () => EMPTY,
  );
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState('');
  // A composer of its own (the bubble's quick reply) lets its images go with it.
  useEffect(() => {
    if (draftKey) return;
    return () => {
      for (const image of get(key)) URL.revokeObjectURL(image.url);
      store.delete(key);
    };
  }, [draftKey, key]);

  const add = async (files: File[]) => {
    const t = m().terminal.images;
    setError('');
    if (!files.length || !api.attachImage) return;
    if (get(key).length + files.length > MAX_IMAGES) {
      setError(t.tooMany(MAX_IMAGES));
      return;
    }
    for (const file of files) {
      if (!(IMAGE_MIME as readonly string[]).includes(file.type)) {
        setError(t.notImage);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setError(t.tooLarge(MAX_IMAGE_BYTES / 1024 / 1024));
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { id } = await api.attachImage(bytes);
        const image = { id, url: URL.createObjectURL(file), name: file.name };
        // Re-read: another add may have finished meanwhile.
        if (get(key).length >= MAX_IMAGES) {
          URL.revokeObjectURL(image.url);
          setError(t.tooMany(MAX_IMAGES));
        } else set(key, [...get(key), image]);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  const remove = (id: string) => {
    const image = get(key).find((i) => i.id === id);
    if (image) URL.revokeObjectURL(image.url);
    set(
      key,
      get(key).filter((i) => i.id !== id),
    );
    setError('');
  };
  /** After a send: only the images that went out (one added meanwhile stays). */
  const clearSent = (ids: readonly string[]) => {
    for (const image of get(key)) if (ids.includes(image.id)) URL.revokeObjectURL(image.url);
    set(
      key,
      get(key).filter((i) => !ids.includes(i.id)),
    );
  };
  return {
    images,
    uploading: uploading > 0,
    error,
    clearError: () => setError(''),
    showError: setError,
    add,
    remove,
    clearSent,
  };
}
