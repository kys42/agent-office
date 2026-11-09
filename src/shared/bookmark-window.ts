// The bookmark reader's own window (one per bookmark), opened beside the window it was asked
// from (docs/development/POPUP-CARDS.md · 옆에 뜨는 팝업 창). Its sizes and target rules;
// desktop/popup-windows.ts owns the windows. The window gets only the bookmark's id: it reads
// the bookmark through the office API, so the service stays the source of truth.

/** First size of a reader window; the person's own resize is remembered after that. */
export const READER_WINDOW_SIZE = { width: 560, height: 680 };
/** Still a title bar and a message or two. */
export const READER_WINDOW_MIN = { width: 360, height: 320 };
/** Reader windows open at once; opening one more closes the oldest. */
export const READER_WINDOW_MAX = 8;
/** Where a reader window's size is remembered (userData). */
export const READER_WINDOW_SIZE_FILE = 'reader-window-size.json';

/**
 * What a reader window shows: one bookmark, or one recorded output of a session (#350, a
 * markdown or HTML file it made), by its id.
 */
export interface ReaderTarget {
  id: string;
  /** Absent: a bookmark (as every reader window before outputs). */
  kind?: 'bookmark' | 'output';
}

/** What a window may ask to read: an id and its kind, nothing else (never a path or text). */
export function parseReaderTarget(raw: unknown): ReaderTarget {
  const t = raw as { id?: unknown; kind?: unknown } | null;
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('bad target');
  if (typeof t.id !== 'string' || !t.id.length || t.id.length > 100) throw new Error('bad target');
  if (t.kind !== undefined && t.kind !== 'bookmark' && t.kind !== 'output')
    throw new Error('bad target');
  return t.kind === 'output' ? { id: t.id, kind: 'output' } : { id: t.id };
}

/** One reader window per bookmark and per output: their keys never meet. */
export const readerKey = (target: ReaderTarget) =>
  target.kind === 'output' ? `output:${target.id}` : target.id;

/**
 * How "read saved conversation" opens: its own window in the desktop app, or the in-page
 * reader where there are no windows (the web preview) and in the demo.
 */
export function readerOpens({ windows, demo }: { windows: boolean; demo: boolean }) {
  return windows && !demo ? ('window' as const) : ('modal' as const);
}
