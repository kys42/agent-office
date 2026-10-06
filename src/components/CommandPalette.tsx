import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { zoneLabel } from '../shared/zones';
import { CornerDownLeft, FileSearch, LoaderCircle, Search } from 'lucide-react';
import type { OfficeNotice, SearchHit, Session } from '../shared/types';
import { PROVIDERS } from '../shared/types';
import { api } from '../lib/api';
import { sessionName } from '../shared/office';
import { messageExcerpt } from '../shared/activity';
import { triageGroup, TRIAGE_LABELS, TRIAGE_ORDER, type TriageGroup } from '../shared/triage';
import { ago } from '../lib/format';
import { Sprite } from './Sprite';

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  keys?: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void;
}
type Item =
  | { kind: 'session'; session: Session; group: TriageGroup }
  | { kind: 'hit'; hit: SearchHit }
  | { kind: 'action'; action: PaletteAction }
  | { kind: 'deep'; query: string };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Jump anywhere without leaving the office: colleagues, recorded text and app actions. */
export function CommandPalette({
  sessions,
  notices,
  actions,
  demo,
  privacy,
  onClose,
  onSelect,
  onDeepSearch,
}: {
  sessions: Session[];
  notices: OfficeNotice[];
  actions: PaletteAction[];
  demo: boolean;
  privacy: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onDeepSearch: (query: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const q = norm(query);
  useEffect(() => {
    setHits([]);
    if (q.length < 2 || privacy) {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const result = demo
          ? sessions
              .filter((s) => norm(`${s.title} ${s.notes} ${s.action}`).includes(q))
              .map((session) => ({ session, snippet: session.action, eventId: null }))
          : await api.search(query);
        if (live) setHits(result.slice(0, 5));
      } catch {
        if (live) setHits([]);
      } finally {
        if (live) setLoading(false);
      }
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, demo, privacy]);
  const sections = useMemo(() => {
    const rank = (s: Session) => TRIAGE_ORDER.indexOf(triageGroup(s, notices));
    const people = sessions
      .filter(
        (s) =>
          !q ||
          (!privacy &&
            norm(
              `${sessionName(s)} ${s.project} ${s.area?.name ?? ''} ${s.title} ${s.alias}`,
            ).includes(q)) ||
          norm(PROVIDERS[s.provider].name).includes(q),
      )
      .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
      .filter((s) => q || rank(s) < 3)
      .slice(0, q ? 8 : 6);
    const shownIds = new Set(people.map((s) => s.id));
    const out: { title: string; items: Item[] }[] = [];
    if (people.length)
      out.push({
        title: q ? '동료' : '지금 볼 동료',
        items: people.map((session) => ({
          kind: 'session',
          session,
          group: triageGroup(session, notices),
        })),
      });
    const acts = actions.filter(
      (a) => !q || norm(`${a.label} ${a.keywords ?? ''} ${a.hint ?? ''}`).includes(q),
    );
    // A matching command beats a full-text search; record search stays reachable below.
    if (acts.length)
      out.push({
        title: '이동 · 설정',
        items: acts.map((action) => ({ kind: 'action', action })),
      });
    const extra = hits.filter((h) => !shownIds.has(h.session.id) || h.snippet);
    if (q.length >= 2 && !privacy)
      out.push({
        title: '기록에서 찾기',
        items: [
          ...extra.map((hit) => ({ kind: 'hit' as const, hit })),
          { kind: 'deep' as const, query },
        ],
      });
    return out;
  }, [sessions, notices, hits, actions, q, privacy, query]);
  const flat = sections.flatMap((s) => s.items);
  useEffect(() => setActive(0), [q, hits.length]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const run = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    if (item.kind === 'session') onSelect(item.session.id);
    else if (item.kind === 'hit') onSelect(item.hit.session.id);
    else if (item.kind === 'deep') onDeepSearch(item.query);
    else item.action.run();
  };
  let index = -1;
  return (
    <div
      className="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="명령 팔레트"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            e.preventDefault();
            onClose();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => Math.min(flat.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            run(flat[active]);
          }
        }}
      >
        <label className="palette-input">
          {loading ? <LoaderCircle size={17} className="spin" /> : <Search size={17} />}
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={flat.length ? `palette-${active}` : undefined}
            aria-label="동료, 기록, 명령 찾기"
            placeholder="동료 이름, 프로젝트, 기억하는 단어, 할 일…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>esc</kbd>
        </label>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {sections.map((section) => (
            <div
              key={section.title}
              className="palette-section"
              role="group"
              aria-label={section.title}
            >
              <h3>{section.title}</h3>
              {section.items.map((item) => {
                index += 1;
                const i = index;
                return (
                  <div
                    key={
                      item.kind === 'session'
                        ? `s:${item.session.id}`
                        : item.kind === 'hit'
                          ? `h:${item.hit.session.id}:${item.hit.eventId}`
                          : item.kind === 'deep'
                            ? 'deep'
                            : `a:${item.action.id}`
                    }
                    id={`palette-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    className={`palette-item ${i === active ? 'active' : ''}`}
                    onMouseMove={() => setActive(i)}
                    onClick={() => run(item)}
                  >
                    {item.kind === 'session' ? (
                      <>
                        <span className={`face face-${item.session.provider}`}>
                          <Sprite
                            provider={item.session.provider}
                            mood={item.session.status}
                            size={24}
                          />
                        </span>
                        <div>
                          <b>
                            {privacy
                              ? PROVIDERS[item.session.provider].name
                              : sessionName(item.session)}
                          </b>
                          <small>
                            {privacy ? '내용 숨김' : zoneLabel(item.session)} ·{' '}
                            {ago(item.session.updatedAt)}
                          </small>
                        </div>
                        <em className={`palette-group group-${item.group}`}>
                          {TRIAGE_LABELS[item.group]}
                        </em>
                      </>
                    ) : item.kind === 'hit' ? (
                      <>
                        <span className={`face face-${item.hit.session.provider}`}>
                          <Sprite provider={item.hit.session.provider} mood="idle" size={24} />
                        </span>
                        <div>
                          <b>{sessionName(item.hit.session)}</b>
                          <small>
                            {messageExcerpt(item.hit.snippet || item.hit.session.action, 120)}
                          </small>
                        </div>
                      </>
                    ) : item.kind === 'deep' ? (
                      <>
                        <span className="palette-icon">
                          <FileSearch size={15} />
                        </span>
                        <div>
                          <b>기억 서랍에서 ‘{item.query}’ 전체 검색</b>
                          <small>모든 도구의 기록을 넓게 찾아요</small>
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="palette-icon">{item.action.icon}</span>
                        <div>
                          <b>{item.action.label}</b>
                          {item.action.hint && <small>{item.action.hint}</small>}
                        </div>
                        {item.action.keys && <kbd>{item.action.keys}</kbd>}
                      </>
                    )}
                    {i === active && <CornerDownLeft size={13} className="palette-enter" />}
                  </div>
                );
              })}
            </div>
          ))}
          {!flat.length && <div className="empty-small">찾는 항목이 없어요.</div>}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 이동
          </span>
          <span>
            <kbd>↵</kbd> 열기
          </span>
          <span>
            <kbd>?</kbd> 모든 단축키
          </span>
        </div>
      </div>
    </div>
  );
}
