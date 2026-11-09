import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  BookmarkCheck,
  Copy,
  ExternalLink,
  EyeOff,
  FolderOpen,
  PackageOpen,
  X,
} from 'lucide-react';
import type { Bookmark, OutputPreview, Snapshot } from '../shared/types';
import type { ReaderTarget } from '../shared/bookmark-window';
import { bookmarkName } from '../shared/bookmarks';
import { api } from '../lib/api';
import { writeClipboard } from '../lib/clipboard';
import { useOffice } from '../lib/useOffice';
import { useI18n, useSharedLocale } from '../lib/i18n';
import { isMac, isWindows } from '../lib/platform';
import { BookmarkReading } from './BookmarkReader';
import { MessageMarkdown } from './MessageMarkdown';
import { OnTopButton, usePopupOnTop } from './WindowPin';

/**
 * The reader's own window (`#reader`, desktop/reader-windows.ts), beside the office: one saved
 * conversation (a bookmark), or one output a session made (#350, a markdown or HTML file). It is
 * given only an id and reads what it shows through the office API (the service's filters decide
 * whether it is there). The office core (`useOffice`) brings whether the screen content is
 * hidden. Moved by its header; Esc or its close button closes it.
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
  const [target, setTarget] = useState<ReaderTarget | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    if (!api.bookmarkWindow) {
      setError(t.memory.readerGoneTitle);
      return;
    }
    api
      .bookmarkWindow('target')
      .then((next) => alive && next && setTarget(next))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [t]);
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
  const props = { snapshot, notify, error, setError };
  return (
    <div className="reader-window">
      {target?.kind === 'output' ? (
        <OutputReader id={target.id} {...props} />
      ) : (
        <BookmarkReader id={target?.id ?? null} {...props} />
      )}
      {toast && (
        <div className="reader-window-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

interface ReaderProps {
  snapshot: Snapshot | null;
  notify: (s: string) => void;
  error: string;
  setError: (s: string) => void;
}

/** The window's own controls: stay on top, close. */
function WindowControls({ notify }: { notify: (s: string) => void }) {
  const { t } = useI18n();
  const close = () => void api.bookmarkWindow?.('close').catch(() => window.close());
  const onTop = usePopupOnTop(api.bookmarkWindow);
  return (
    <>
      {onTop.available && (
        <OnTopButton
          className="icon-btn"
          on={onTop.on}
          busy={onTop.busy}
          onToggle={() => void onTop.toggle().catch((e: Error) => notify(e.message))}
        />
      )}
      <button className="icon-btn" aria-label={t.app.close} title={t.app.close} onClick={close}>
        <X size={16} />
      </button>
    </>
  );
}

function Hidden({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <EyeOff size={28} />
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

/** One saved conversation, read again whenever the office's bookmarks change. */
function BookmarkReader({
  id,
  snapshot,
  notify,
  error,
  setError,
}: ReaderProps & { id: string | null }) {
  const { t } = useI18n();
  /** undefined: still reading; null: not there (removed, or hidden by the settings). */
  const [bookmark, setBookmark] = useState<Bookmark | null | undefined>(undefined);
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
  const shown = !privacy && bookmark ? bookmark : null;
  const copy = () => {
    if (!shown) return;
    void writeClipboard(shown.text)
      .then(() => notify(t.memory.copied))
      .catch(() => notify(t.memory.copyFailed));
  };
  const go = () => void api.bookmarkWindow?.('go').catch((e: Error) => notify(e.message));
  return (
    <>
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
          <WindowControls notify={notify} />
        </span>
      </header>
      <main className="reader-window-body">
        {privacy ? (
          <Hidden title={t.memory.hiddenTitle} body={t.memory.hiddenBody} />
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
    </>
  );
}

/**
 * An HTML output as a document of its own: no scripts, forms, popups or navigation (an empty
 * `sandbox`), and nothing fetched from anywhere (its own CSP, on top of the page's: inline styles
 * and embedded data images only).
 */
export function sandboxedHtml(html: string) {
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'">${html}`;
}

/**
 * One output read now: markdown with the conversation's renderer, HTML in a sandboxed frame. It
 * is read once the office says the screen content is not hidden, and again when it shows again.
 */
function OutputReader({ id, snapshot, notify, error, setError }: ReaderProps & { id: string }) {
  const { t } = useI18n();
  /** undefined: still reading; null: not there (moved, deleted, or hidden by the settings). */
  const [preview, setPreview] = useState<OutputPreview | null | undefined>(undefined);
  const privacy = snapshot?.preferences.privacy ?? false;
  const known = !!snapshot;
  useEffect(() => {
    if (!known || privacy) {
      setPreview(undefined);
      return;
    }
    let alive = true;
    if (!api.outputPreview) {
      setPreview(null);
      return;
    }
    api
      .outputPreview(id)
      .then((p) => {
        if (!alive) return;
        setPreview(p);
        setError('');
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [id, known, privacy]);
  const shown = !privacy && preview ? preview : null;
  useEffect(() => {
    document.title = shown ? `${t.outputs.readerTitle} · ${shown.name}` : t.outputs.readerTitle;
  }, [t, shown?.name]);
  const act = (what: 'open' | 'reveal' | 'copy') =>
    void api.outputAction?.(what, id).then(
      (done) => {
        if (done === 'missing') notify(t.outputs.missingToast);
        else if (done === 'copied') notify(t.outputs.copied);
      },
      (e: Error) => notify(e.message),
    );
  const reveal = isMac ? t.outputs.revealMac : t.outputs.revealOther;
  return (
    <>
      <header className="reader-window-bar">
        <PackageOpen size={14} aria-hidden />
        <b title={shown?.name}>
          {privacy ? t.outputs.hiddenName : shown?.name || t.outputs.readerTitle}
        </b>
        <span className="reader-window-actions">
          {shown && api.outputAction && (
            <>
              <button className="button primary" onClick={() => act('open')}>
                {t.outputs.open}
                <ExternalLink size={13} />
              </button>
              <button
                className="icon-btn"
                aria-label={reveal}
                title={reveal}
                onClick={() => act('reveal')}
              >
                <FolderOpen size={14} />
              </button>
              <button
                className="icon-btn"
                aria-label={t.outputs.copyPath}
                title={t.outputs.copyPath}
                onClick={() => act('copy')}
              >
                <Copy size={14} />
              </button>
            </>
          )}
          <WindowControls notify={notify} />
        </span>
      </header>
      <main className="reader-window-body output-reader">
        {privacy ? (
          <Hidden title={t.outputs.hiddenName} body={t.outputs.previewHidden} />
        ) : shown ? (
          <>
            {shown.truncated && <p className="output-reader-note">{t.outputs.truncated}</p>}
            {shown.format === 'markdown' ? (
              <article className="output-markdown message-text">
                <MessageMarkdown text={shown.text} notify={notify} />
              </article>
            ) : (
              <>
                <p className="output-reader-note">{t.outputs.htmlNote}</p>
                <iframe
                  className="output-html"
                  title={shown.name}
                  sandbox=""
                  referrerPolicy="no-referrer"
                  srcDoc={sandboxedHtml(shown.text)}
                />
              </>
            )}
          </>
        ) : error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : preview === null ? (
          <div className="empty-state">
            <PackageOpen size={28} />
            <h3>{t.outputs.readerGoneTitle}</h3>
            <p>{t.outputs.readerGoneBody}</p>
          </div>
        ) : (
          <p className="reader-window-opening">{t.outputs.readerOpening}</p>
        )}
      </main>
    </>
  );
}
