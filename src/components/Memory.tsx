import { useEffect, useState } from 'react';
import { Search, ArrowUpRight, BookOpen, FileText, X, Pin } from 'lucide-react';
import type { Provider, SearchHit, Session } from '../shared/types';
import { PROVIDERS, MOODS } from '../shared/types';
import { api } from '../lib/api';
import { Sprite } from './Sprite';
import { ago } from '../lib/format';
export function Memory({
  sessions,
  onSelect,
  demo,
  privacy,
}: {
  sessions: Session[];
  onSelect: (id: string) => void;
  demo: boolean;
  privacy: boolean;
}) {
  const [query, setQuery] = useState(''),
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
    <div className="memory-page">
      <div className="page-intro">
        <span className="eyebrow">THE MEMORY DRAWER</span>
        <h1>지나간 일도, 이어질 이야기.</h1>
        <p>어느 도구에서 했든, 다시 찾고 싶은 작업의 맥락을 꺼내보세요.</p>
      </div>
      <div className="memory-search">
        <Search size={21} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="프로젝트, 결정, 오류, 기억하고 싶은 단어…"
          aria-label="기록 검색"
          maxLength={200}
        />
        {query && (
          <button className="icon-btn" aria-label="검색어 지우기" onClick={() => setQuery('')}>
            <X size={16} />
          </button>
        )}
        <kbd>⌘ K</kbd>
      </div>
      <div className="memory-controls">
        <div className="provider-filters">
          {(['all', 'claude', 'codex', 'openclaw'] as const).map((p) => (
            <button className={filter === p ? 'active' : ''} key={p} onClick={() => setFilter(p)}>
              {p === 'all' ? '모든 도구' : PROVIDERS[p].name}
            </button>
          ))}
        </div>
        <button
          className={`button subtle ${notesOnly ? 'active' : ''}`}
          onClick={() => setNotesOnly(!notesOnly)}
        >
          <BookOpen size={15} />
          메모 있는 기록
        </button>
      </div>
      <div className="results-header">
        <span>
          {loading
            ? '기록을 찾고 있어요…'
            : `${results.length}개의 기억${results.length >= 50 ? ' · 최대 50개 표시' : ''}`}
        </span>
        <span>최근 활동순</span>
      </div>
      {error && <div className="inline-error">{error}</div>}
      <div className="memory-grid">
        {results.map(({ session: s, snippet }) => (
          <button className="memory-card" key={s.id} onClick={() => onSelect(s.id)}>
            <div className="memory-card-top">
              <Sprite provider={s.provider} mood="idle" size={46} />
              <span>{PROVIDERS[s.provider].name}</span>
              {s.pinned ? <Pin size={14} /> : <ArrowUpRight size={17} />}
            </div>
            <h3>{privacy ? '숨긴 작업 기록' : s.alias || s.title}</h3>
            <span className="project-label">{privacy ? '프로젝트' : s.project}</span>
            <p>{privacy ? '내용을 숨기고 있어요.' : snippet || s.action}</p>
            <div className="memory-card-bottom">
              <span>{ago(s.updatedAt)}</span>
              <span>
                {s.notes ? (
                  <>
                    <FileText size={12} />
                    메모 있음
                  </>
                ) : (
                  <>
                    <i style={{ background: MOODS[s.status].color }} />
                    {MOODS[s.status].label}
                  </>
                )}
              </span>
            </div>
          </button>
        ))}
      </div>
      {!loading && !results.length && (
        <div className="empty-state">
          <BookOpen size={36} />
          <h3>아직 꺼낼 기억이 없어요</h3>
          <p>다른 단어로 찾아보거나 도구 필터를 바꿔보세요.</p>
        </div>
      )}
      <p className="page-note">
        로컬에 수집된 구간을 검색해요. 큰 기록은 처음과 최근 구간만 포함할 수 있어요.
      </p>
    </div>
  );
}
