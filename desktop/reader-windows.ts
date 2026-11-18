import { nativeTheme } from 'electron';
import {
  READER_WINDOW_MAX,
  READER_WINDOW_MIN,
  READER_WINDOW_SIZE,
  READER_WINDOW_SIZE_FILE,
  type ReaderTarget,
} from '../src/shared/bookmark-window.js';
import { m } from '../src/shared/i18n/index.js';
import { PopupWindows, type PopupKind, type PopupOptions } from './popup-windows.js';

export const readerKind: PopupKind = {
  label: 'Reader window',
  hash: 'reader',
  sizeFile: READER_WINDOW_SIZE_FILE,
  size: READER_WINDOW_SIZE,
  min: READER_WINDOW_MIN,
  max: READER_WINDOW_MAX,
  window: () => ({
    // The app's own window color in the current theme: no flash of the other one while loading.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
    title: m().memory.read,
  }),
};

/**
 * The bookmark reader's windows: one per bookmark (keyed by its id), opened beside the window
 * "read saved conversation" was pressed in, so the saved conversation stays readable while the
 * person works in the office. The window is given only the id and reads the bookmark through
 * the office API. Only the reader's IPC trusts these windows (desktop/main.ts `trustedReader`).
 */
export class ReaderWindows extends PopupWindows<ReaderTarget> {
  constructor(options: PopupOptions) {
    super(readerKind, options);
  }
}
