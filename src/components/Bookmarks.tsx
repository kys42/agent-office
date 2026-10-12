import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  BookmarkCheck,
  ChevronDown,
  Copy,
  LoaderCircle,
  PencilLine,
  Trash2,
} from 'lucide-react';
import type { Bookmark, BookmarkLine, Session } from '../shared/types';
import { PROVIDERS } from '../shared/types';
import { api } from '../lib/api';
import { ago, time, date } from '../lib/format';
import { messageExcerpt } from '../shared/activity';
import { BOOKMARK_NOTE, BOOKMARK_PAGE, BOOKMARK_PAGE_MAX } from '../shared/bookmarks';
import { useI18n } from '../lib/i18n';

/** One saved line of a bookmark's context, clipped like the cards' excerpts. */
function Line({ line, label }: { line: BookmarkLine; label: string }) {
  return (
    <li className={`bookmark-line kind-${line.kind}`}>
      <span>
        {label} · <time title={date(line.at)}>{time(line.at)}</time>
      </span>
      <p>{messageExcerpt(line.text, 600)}</p>
    </li>
  );
}
function BookmarkCard({
  bookmark: b,
  session,
  privacy,
  onOpen,
  onRemove,
  onNote,
  notify,
}: {
  bookmark: Bookmark;
  /** Its colleague as the office shows it now; absent when the record is gone or hidden. */
  session?: Session;
  privacy: boolean;
  onOpen: (b: Bookmark) => void;
  onRemove: (b: Bookmark) => void;
  onNote: (b: Bookmark, note: string) => Promise<void>;
  notify: (s: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(b.note);
  useEffect(() => {
    if (!editing) setNote(b.note);
  }, [b.note, editing]);
  const name = session ? session.alias || session.title : b.source.alias || b.source.title;
  const long = b.text.length > 240;
  const { request, progress, omitted, tools } = b.context;
  const hasContext = !!request || progress.length > 0 || tools > 0;
  return (
    <article className="bookmark-card">
      <div className="memory-card-top">
        <span className="project-label">{privacy ? t.memory.hiddenProject : b.source.project}</span>
        <span className="memory-provider">{PROVIDERS[b.source.provider].short}</span>
        <time title={date(b.at)}>{time(b.at)}</time>
      </div>
      <h3>{privacy ? t.memory.hiddenTitle : name}</h3>
      {privacy ? (
        <p className="bookmark-text">{t.memory.hiddenBody}</p>
      ) : (
        <>
          <p className={`bookmark-text ${open ? 'is-open' : ''}`}>
            {open || !long ? b.text : messageExcerpt(b.text, 240)}
          </p>
          {(b.truncated || b.excerpt) && (
            <small className="bookmark-flag">
              {b.truncated ? t.memory.truncated : t.memory.excerpt}
            </small>
          )}
          {open && hasContext && (
            <ol className="bookmark-context">
              {request && <Line line={request} label={t.memory.request} />}
              {progress.length > 0 && (
                <li className="bookmark-context-head">
                  {t.memory.progress(progress.length)}
                  {omitted > 0 && ` · ${t.memory.omitted(omitted)}`}
                </li>
              )}
              {progress.map((line) => (
                <Line key={line.eventId} line={line} label={PROVIDERS[b.source.provider].name} />
              ))}
              {tools > 0 && <li className="bookmark-context-head">{t.memory.tools(tools)}</li>}
            </ol>
          )}
          {(long || hasContext) && (
            <button className="bookmark-expand" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? t.memory.hideContext : hasContext ? t.memory.showContext : t.memory.more}
              <ChevronDown size={13} />
            </button>
          )}
          {editing ? (
            <div className="bookmark-note-edit">
              <textarea
                value={note}
                maxLength={BOOKMARK_NOTE}
                placeholder={t.memory.notePlaceholder}
                aria-label={t.memory.noteEdit}
                autoFocus
                onChange={(e) => setNote(e.target.value)}
              />
              <div>
                <button onClick={() => setEditing(false)}>{t.memory.noteCancel}</button>
                <button
                  className="primary"
                  onClick={() => void onNote(b, note).then(() => setEditing(false))}
                >
                  {t.memory.noteSave}
                </button>
              </div>
            </div>
          ) : (
            b.note && <p className="bookmark-note">{b.note}</p>
          )}
        </>
      )}
      {!session && <small className="bookmark-flag">{t.memory.sourceGone}</small>}
      <div className="bookmark-actions">
        <span title={date(b.createdAt)}>
          <BookmarkCheck size={11} />
          {t.memory.savedAt(ago(b.createdAt))}
        </span>
        {!privacy && !editing && (
          <button
            aria-label={b.note ? t.memory.noteEdit : t.memory.noteAdd}
            title={b.note ? t.memory.noteEdit : t.memory.noteAdd}
            onClick={() => setEditing(true)}
          >
            <PencilLine size={13} />
          </button>
        )}
        {!privacy && (
          <button
            aria-label={t.memory.copy}
            title={t.memory.copy}
            onClick={() =>
              void (api.copyText ?? ((s: string) => navigator.clipboard.writeText(s)))(b.text)
                .then(() => notify(t.memory.copied))
                .catch(() => notify(t.memory.copyFailed))
            }
          >
            <Copy size={13} />
          </button>
        )}
        <button aria-label={t.memory.remove} title={t.memory.remove} onClick={() => onRemove(b)}>
          <Trash2 size={13} />
        </button>
        {session && (
          <button className="bookmark-open" onClick={() => onOpen(b)}>
            {t.memory.open}
            <ArrowUpRight size={13} />
          </button>
        )}
      </div>
    </article>
  );
}
/**
 * The person's bookmarked messages, newest saved first, narrowed by `query`. Read again when
 * the office's bookmarks change (another window, the conversation tab).
 */
export function Bookmarks({
  query,
  sessions,
  privacy,
  demo,
  stamp,
  onOpen,
  onRemove,
  notify,
}: {
  query: string;
  sessions: Session[];
  privacy: boolean;
  demo: boolean;
  /** Changes whenever the office's bookmarks do. */
  stamp: string;
  onOpen: (b: Bookmark) => void;
  onRemove: (id: string) => Promise<void>;
  notify: (s: string) => void;
}) {
  const { t } = useI18n();
  const [list, setList] = useState<Bookmark[]>([]);
  const [more, setMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  // Read again after a change elsewhere: as many as were listed (up to a page's bound), so
  // what was loaded further down does not fold back to the first page.
  const latest = useRef(list);
  latest.current = list;
  // Which reading of the list a page continues: a new query or a change elsewhere starts another.
  const generation = useRef(0);
  useEffect(() => {
    if (demo) return;
    const reading = ++generation.current;
    let active = true;
    setLoading(true);
    setError('');
    const timer = setTimeout(async () => {
      try {
        const page = await api.bookmarks({
          text: query,
          limit: Math.min(Math.max(latest.current.length, BOOKMARK_PAGE), BOOKMARK_PAGE_MAX),
        });
        if (!active || reading !== generation.current) return;
        setList(page.bookmarks);
        setMore(page.more);
        setTotal(page.total);
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, stamp, demo]);
  /** The next page, after the last one listed. */
  const loadMore = async () => {
    const last = list.at(-1);
    if (!last || loadingMore) return;
    const reading = generation.current;
    setLoadingMore(true);
    try {
      const page = await api.bookmarks({
        text: query,
        before: { createdAt: last.createdAt, id: last.id },
      });
      // The list was read again meanwhile (another query, a change elsewhere): this page no
      // longer follows it.
      if (reading !== generation.current || latest.current.at(-1)?.id !== last.id) return;
      setList([...latest.current, ...page.bookmarks]);
      setMore(page.more);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const remove = (b: Bookmark) =>
    void onRemove(b.id)
      .then(() => {
        setList((l) => l.filter((x) => x.id !== b.id));
        notify(t.memory.removed);
      })
      .catch((e) => notify((e as Error).message));
  const saveNote = async (b: Bookmark, note: string) => {
    try {
      const next = await api.bookmarkNote(b.id, note);
      setList((l) => l.map((x) => (x.id === next.id ? next : x)));
      notify(t.memory.noteSaved);
    } catch (e) {
      notify((e as Error).message);
      throw e;
    }
  };
  if (demo)
    return (
      <div className="empty-state">
        <BookmarkCheck size={30} />
        <p>{t.memory.bookmarksDemo}</p>
      </div>
    );
  return (
    <>
      <div className="results-header">
        <span>
          {loading ? <LoaderCircle size={12} className="spin" /> : t.memory.bookmarkResults(total)}
        </span>
        <span>{t.memory.bookmarkSort}</span>
      </div>
      {error && <div className="inline-error">{error}</div>}
      <div className="bookmark-list">
        {list.map((b) => (
          <BookmarkCard
            key={b.id}
            bookmark={b}
            session={byId.get(b.sessionId)}
            privacy={privacy}
            onOpen={onOpen}
            onRemove={remove}
            onNote={saveNote}
            notify={notify}
          />
        ))}
      </div>
      {more && (
        <button className="older-messages" disabled={loadingMore} onClick={() => void loadMore()}>
          {t.memory.more}
        </button>
      )}
      {!loading && !error && !list.length && (
        <div className="empty-state">
          <BookmarkCheck size={30} />
          <h3>{query.trim() ? t.memory.bookmarksNoMatch : t.memory.bookmarksEmptyTitle}</h3>
          {!query.trim() && <p>{t.memory.bookmarksEmptyBody}</p>}
        </div>
      )}
    </>
  );
}
