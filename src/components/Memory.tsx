import { useEffect, useState } from 'react';
import { Search, ArrowUpRight, BookOpen, FileText, X, Pin, LoaderCircle } from 'lucide-react';
import type { Provider, SearchHit, Session } from '../shared/types';
import { PROVIDERS, MOODS } from '../shared/types';
import { api } from '../lib/api';
import { Sprite } from './Sprite';
import { ago } from '../lib/format';
import { messageExcerpt } from '../shared/activity';
import { useI18n } from '../lib/i18n';
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? <mark key={i}>{part}</mark> : part,
      )}
    </>
  );
}
export function Memory({
  sessions,
  onSelect,
  demo,
  privacy,
  initialQuery = '',
}: {
  initialQuery?: string;
  sessions: Session[];
  onSelect: (id: string) => void;
  demo: boolean;
  privacy: boolean;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState(initialQuery),
    [filter, setFilter] = useState<Provider | 'all'>('all'),
    [notesOnly, setNotesOnly] = useState(false),
    [hits, setHits] = useState<SearchHit[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const timer = setTimeout(async () => {
      try {
        const result = demo
          ? sessions
              .filter(
                (s) =>
                  `${s.title} ${s.alias} ${s.project} ${s.notes}`.includes(query) &&
                  (filter === 'all' || s.provider === filter),
              )
              .map((session) => ({ session, snippet: session.action, eventId: null }))
          : await api.search(query, filter === 'all' ? undefined : filter);
        if (active) setHits(result);
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
  }, [query, filter, demo, sessions]);
  const results = hits.filter((h) => !notesOnly || h.session.notes);
  return (
    <div className="memory-page page">
      <header className="page-head">
        <div>
          <span className="eyebrow">{t.memory.eyebrow}</span>
          <h1>{t.memory.title}</h1>
          <p>{t.memory.intro}</p>
        </div>
      </header>
      <div className="memory-search">
        {loading ? <LoaderCircle size={19} className="spin" /> : <Search size={19} />}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.memory.placeholder}
          aria-label={t.memory.searchLabel}
          maxLength={200}
        />
        {query && (
          <button className="icon-btn" aria-label={t.memory.clear} onClick={() => setQuery('')}>
            <X size={15} />
          </button>
        )}
        <kbd>⌘K</kbd>
      </div>
      <div className="memory-controls">
        <div className="provider-filters">
          {(['all', 'claude', 'codex', 'openclaw'] as const).map((p) => (
            <button
              className={`${filter === p ? 'active' : ''} chip-${p}`}
              key={p}
              onClick={() => setFilter(p)}
            >
              {p !== 'all' && <i />}
              {p === 'all' ? t.memory.allTools : PROVIDERS[p].name}
            </button>
          ))}
        </div>
        <button
          className={`chip-toggle ${notesOnly ? 'active' : ''}`}
          aria-pressed={notesOnly}
          onClick={() => setNotesOnly(!notesOnly)}
        >
          <BookOpen size={13} />
          {t.memory.withNotes}
        </button>
        {!query && (
          <div className="memory-suggest">
            <span>{t.memory.suggestLabel}</span>
            {t.memory.suggestions.map((word) => (
              <button key={word} onClick={() => setQuery(word)}>
                {word}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="results-header">
        <span>{loading ? t.memory.searching : t.memory.results(results.length)}</span>
        <span>{t.memory.sort}</span>
      </div>
      {error && <div className="inline-error">{error}</div>}
      <div className="memory-grid">
        {results.map(({ session: s, snippet }) => (
          <button className="memory-card" key={s.id} onClick={() => onSelect(s.id)}>
            <div className={`face face-lg face-${s.provider}`}>
              <Sprite session={s} provider={s.provider} mood="idle" size={40} />
            </div>
            <div className="memory-card-body">
              <div className="memory-card-top">
                <span className="project-label">
                  {privacy ? t.memory.hiddenProject : s.project}
                </span>
                <span className="memory-provider">{PROVIDERS[s.provider].short}</span>
              </div>
              <h3>{privacy ? t.memory.hiddenTitle : s.alias || s.title}</h3>
              <p>
                {privacy ? (
                  t.memory.hiddenBody
                ) : (
                  <Highlight text={messageExcerpt(snippet || s.action, 240)} query={query} />
                )}
              </p>
              <div className="memory-card-bottom">
                <span>{ago(s.updatedAt)}</span>
                <span>
                  {s.notes ? (
                    <>
                      <FileText size={11} />
                      {t.memory.hasNotes}
                    </>
                  ) : (
                    <>
                      <i style={{ background: MOODS[s.status].color }} />
                      {MOODS[s.status].label}
                    </>
                  )}
                </span>
              </div>
            </div>
            {s.pinned ? (
              <Pin size={14} className="memory-go" />
            ) : (
              <ArrowUpRight size={16} className="memory-go" />
            )}
          </button>
        ))}
      </div>
      {!loading && !results.length && (
        <div className="empty-state">
          <BookOpen size={30} />
          <h3>{t.memory.emptyTitle}</h3>
          <p>{t.memory.emptyBody}</p>
        </div>
      )}
      <p className="page-note">{t.memory.note}</p>
    </div>
  );
}
