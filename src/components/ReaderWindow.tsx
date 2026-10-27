import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, BookmarkCheck, Copy, EyeOff, X } from 'lucide-react';
import type { Bookmark } from '../shared/types';
import { bookmarkName } from '../shared/bookmarks';
import { api } from '../lib/api';
import { useOffice } from '../lib/useOffice';
import { useI18n, useSharedLocale } from '../lib/i18n';
import { isMac, isWindows } from '../lib/platform';
import { BookmarkReading } from './BookmarkReader';

/**
 * The bookmark reader's own window (`#reader`, desktop/reader-windows.ts): one saved
 * conversation, the whole window, beside the office. It is given only the bookmark's id and
 * reads the bookmark through the office API (the service's filters decide whether it is there),
 * again whenever the office's bookmarks change. The office core (`useOffice`) brings the
 * colleague as shown now and whether the screen content is hidden. Moved by its header; Esc or
 * its close button closes it.
 */
export function ReaderWindow() {
  const { t } = useI18n();
  useSharedLocale();
  const [toast, setToast] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(''), 3600);
  }, []);
  const { snapshot } = useOffice(false, notify, { quotas: false });
  const [id, setId] = useState<string | null>(null);
  /** undefined: still reading; null: not there (removed, or hidden by the settings). */
  const [bookmark, setBookmark] = useState<Bookmark | null | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    if (!api.bookmarkWindow) {
      setError(t.memory.readerGoneTitle);
      return;
    }
    api
      .bookmarkWindow('target')
      .then((next) => alive && next && setId(next.id))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [t]);
  const prefs = snapshot?.preferences;
  const privacy = prefs?.privacy ?? false;
  // Whatever changes which bookmarks there are to read (as the lists read again).
  const stamp = JSON.stringify([
    snapshot?.bookmarkStamp,
    snapshot?.bookmarked,
    prefs?.excludedProjects,
    prefs?.enabledProviders,
  ]);
  const known = !!snapshot;
  useEffect(() => {
    // Nothing is read until the office says whether its content is hidden, nor while it is.
    if (!id || !known || privacy) {
      setBookmark(undefined);
      return;
    }
    let alive = true;
    api
      .bookmarkById(id)
      .then((b) => {
        if (!alive) return;
        setBookmark(b);
        setError('');
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [id, known, privacy, stamp]);
  const session = bookmark
    ? snapshot?.sessions.find((s) => s.id === bookmark.sessionId)
    : undefined;
  const name = bookmark && !privacy ? bookmarkName(bookmark, session) : '';
  useEffect(() => {
    document.title = name ? `${t.memory.read} · ${name}` : t.memory.read;
  }, [t, name]);
  useEffect(() => {
    const body = document.body.classList;
    body.add('reader-mode');
    body.toggle('is-mac', isMac);
    body.toggle('is-windows', isWindows);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void api.bookmarkWindow?.('close').catch(() => {});
    };
    window.addEventListener('keydown', key);
    return () => {
      body.remove('reader-mode');
      window.removeEventListener('keydown', key);
    };
  }, []);
  const shown = !privacy && bookmark ? bookmark : null;
  const copy = () => {
    if (!shown) return;
    void (api.copyText ?? ((s: string) => navigator.clipboard.writeText(s)))(shown.text)
      .then(() => notify(t.memory.copied))
      .catch(() => notify(t.memory.copyFailed));
  };
  const go = () => void api.bookmarkWindow?.('go').catch((e: Error) => notify(e.message));
  const close = () => void api.bookmarkWindow?.('close').catch(() => window.close());
  return (
    <div className="reader-window">
      <header className="reader-window-bar">
        <BookmarkCheck size={14} aria-hidden />
        <b title={name || undefined}>{privacy ? t.memory.hiddenTitle : name || t.memory.read}</b>
        <span className="reader-window-actions">
          {shown && session && (
            <button className="button primary" onClick={go}>
              {t.memory.open}
              <ArrowUpRight size={13} />
            </button>
          )}
          {shown && (
            <button
              className="icon-btn"
              aria-label={t.memory.copy}
              title={t.memory.copy}
              onClick={copy}
            >
              <Copy size={14} />
            </button>
          )}
          <button className="icon-btn" aria-label={t.app.close} title={t.app.close} onClick={close}>
            <X size={16} />
          </button>
        </span>
      </header>
      <main className="reader-window-body">
        {privacy ? (
          <div className="empty-state">
            <EyeOff size={28} />
            <h3>{t.memory.hiddenTitle}</h3>
            <p>{t.memory.hiddenBody}</p>
          </div>
        ) : shown ? (
          <BookmarkReading bookmark={shown} name={name} canOpen={!!session} notify={notify} />
        ) : error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : bookmark === null ? (
          <div className="empty-state">
            <BookmarkCheck size={28} />
            <h3>{t.memory.readerGoneTitle}</h3>
            <p>{t.memory.readerGoneBody}</p>
          </div>
        ) : (
          <p className="reader-window-opening">{t.memory.readerOpening}</p>
        )}
      </main>
      {toast && (
        <div className="reader-window-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
