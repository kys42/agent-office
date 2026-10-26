import { useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import {
  IMAGE_MIME,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  parseStoredImages,
  type StoredImage,
} from '../shared/attachments';
import { m } from '../shared/i18n';
import { api } from './api';

/** An image attached in the composer: the id main gave back, and a local preview. */
export interface ComposerImage {
  id: string;
  /** Object URL of its bytes in this window; absent while they are fetched again. */
  url?: string;
  name: string;
}

/**
 * Attached images per composer. A draft's list (ids and names only: main keeps the files and
 * checks every id again on send) is saved next to its text draft, so a card window that is closed
 * (destroyed) and opened again, or the app restarted, shows them again; their thumbnails are read
 * back from main by id. A composer of its own (no draft key: the bubble's quick reply) keeps its
 * list in memory while it is open. Uploads in flight are counted per composer here too, so a
 * remount never forgets one and Send stays off until every image has arrived.
 */
const PREFIX = 'office:reply-images:v1:';
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
// Lists not saved (no draft key, or storage unavailable), by key.
const unsaved = new Map<string, StoredImage[]>();
// The last parse per key, so the same saved text gives the same list (a stable snapshot).
const parsed = new Map<string, { raw: string | null; list: StoredImage[] }>();
const uploads = new Map<string, number>();
// Previews in this window, by id; ids being fetched; ids main no longer has.
const previews = new Map<string, string>();
const fetching = new Set<string>();
const EMPTY: StoredImage[] = [];

function readList(key: string, saved: boolean): StoredImage[] {
  if (!saved || unsaved.has(key)) return unsaved.get(key) ?? EMPTY;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PREFIX + key);
  } catch {
    return EMPTY;
  }
  const last = parsed.get(key);
  if (last && last.raw === raw) return last.list;
  const list = raw ? parseStoredImages(raw) : EMPTY;
  parsed.set(key, { raw, list });
  return list;
}

function writeList(key: string, saved: boolean, list: StoredImage[]) {
  if (saved)
    try {
      if (list.length) localStorage.setItem(PREFIX + key, JSON.stringify(list));
      else localStorage.removeItem(PREFIX + key);
      unsaved.delete(key);
      notify();
      return;
    } catch {
      // Storage unavailable: kept in this window instead.
    }
  if (list.length) unsaved.set(key, list);
  else unsaved.delete(key);
  notify();
}

function forgetPreview(id: string) {
  const url = previews.get(id);
  if (url) URL.revokeObjectURL(url);
  previews.delete(id);
}

const pendingUploads = (key: string) => uploads.get(key) ?? 0;
function countUpload(key: string, by: number) {
  const next = pendingUploads(key) + by;
  if (next > 0) uploads.set(key, next);
  else uploads.delete(key);
  notify();
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
  const saved = !!draftKey;
  const key = draftKey ?? `own:${own}`;
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(PREFIX)) listener();
    };
    window.addEventListener('storage', changed);
    return () => {
      listeners.delete(listener);
      window.removeEventListener('storage', changed);
    };
  }, []);
  const list = useSyncExternalStore(
    subscribe,
    () => readList(key, saved),
    () => EMPTY,
  );
  const uploading = useSyncExternalStore(
    subscribe,
    () => pendingUploads(key),
    () => 0,
  );
  // Re-render when a preview arrives (previews are shared by every composer in this window).
  const [shown, setShown] = useState(0);
  const [error, setError] = useState('');
  const get = () => readList(key, saved);
  const set = (next: StoredImage[]) => writeList(key, saved, next);

  // Thumbnails for ids this window has no bytes for (a reopened card, another window's add).
  useEffect(() => {
    let live = true;
    for (const { id } of list) {
      if (previews.has(id) || fetching.has(id) || !api.attachmentPreview) continue;
      fetching.add(id);
      api
        .attachmentPreview(id)
        .then((preview) => {
          if (!preview) {
            // Gone (removed after a week, another profile): dropped without a word.
            writeList(
              key,
              saved,
              readList(key, saved).filter((image) => image.id !== id),
            );
            return;
          }
          previews.set(
            id,
            URL.createObjectURL(new Blob([new Uint8Array(preview.bytes)], { type: preview.type })),
          );
          if (live) setShown((n) => n + 1);
        })
        .catch(() => undefined)
        .finally(() => fetching.delete(id));
    }
    return () => {
      live = false;
    };
  }, [list, key, saved]);

  // A composer of its own lets its images go with it.
  useEffect(() => {
    if (saved) return;
    return () => {
      for (const image of unsaved.get(key) ?? []) forgetPreview(image.id);
      unsaved.delete(key);
    };
  }, [saved, key]);

  const images: ComposerImage[] = useMemo(
    () => list.map((image) => ({ ...image, url: previews.get(image.id) })),
    // `shown` counts previews that arrived.
    [list, shown],
  );

  const add = async (files: File[]) => {
    const t = m().terminal.images;
    setError('');
    if (!files.length || !api.attachImage) return;
    if (get().length + pendingUploads(key) + files.length > MAX_IMAGES) {
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
      countUpload(key, 1);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { id } = await api.attachImage(bytes);
        // Re-read: another add may have finished meanwhile, in this or another window.
        if (get().length >= MAX_IMAGES) setError(t.tooMany(MAX_IMAGES));
        else {
          previews.set(id, URL.createObjectURL(file));
          set([...get(), { id, name: file.name }]);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        countUpload(key, -1);
      }
    }
  };
  const remove = (id: string) => {
    forgetPreview(id);
    set(get().filter((image) => image.id !== id));
    setError('');
  };
  /** After a send: only the images that went out (one added meanwhile stays). */
  const clearSent = (ids: readonly string[]) => {
    for (const id of ids) forgetPreview(id);
    set(get().filter((image) => !ids.includes(image.id)));
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
