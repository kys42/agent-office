import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCheck, ChevronDown, Pin, Search, X } from 'lucide-react';
import type { OfficeNotice, OfficeZone, Provider, Session } from '../shared/types';
import { MOODS, PROVIDERS } from '../shared/types';
import { Sprite } from './Sprite';
import { ago, date } from '../lib/format';
import { sessionActivity, activityLabel } from '../shared/activity';
import { sessionName } from '../shared/office';
import {
  durationShort,
  triage,
  TRIAGE_LABELS,
  unreadInbox,
  workingFor,
  type TriageGroup,
} from '../shared/triage';
import { PanelTabs } from './PanelTabs';
import type { ReceiptHandler } from './News';
import { isWorking } from '../shared/presentation';
import { isAttentionNotice } from '../shared/notices';
const TITLES: Record<OfficeZone, string> = {
  office: '사무실의 동료',
  waiting: '라운지의 동료',
  archive: '보관된 기록',
};
const HINTS: Record<TriageGroup, string> = {
  attention: '원래 앱에서 답해 주세요',
  results: '최종 응답이 도착했어요',
  working: '작업 기록이 이어지는 중',
  resting: '새 기록을 기다리는 중',
};
function saved(key: string) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
export function Roster({
  zone,
  sessions,
  totalSessions,
  zoneCount,
  notices,
  unread,
  query,
  onQuery,
  sort,
  onSort,
  selected,
  onSelect,
  hovered,
  onHover,
  onInbox,
  onReceipt,
  privacy,
  filter,
  onFilter,
}: {
  zone: OfficeZone;
  sessions: Session[];
  totalSessions: Session[];
  zoneCount: number;
  notices: OfficeNotice[];
  unread: number;
  query: string;
  onQuery: (q: string) => void;
  sort: 'recent' | 'frequent';
  onSort: (s: 'recent' | 'frequent') => void;
  selected: string | null;
  onSelect: (id: string) => void;
  hovered: string | null;
  onHover: (id: string | null) => void;
  onInbox: () => void;
  onReceipt: ReceiptHandler;
  privacy: boolean;
  filter: Provider | 'all';
  onFilter: (p: Provider | 'all') => void;
}) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const [restFolded, setRestFolded] = useState(() => saved('office:roster:rest-folded'));
  useEffect(() => {
    try {
      localStorage.setItem('office:roster:rest-folded', restFolded ? '1' : '0');
    } catch {
      /* per-viewer convenience only */
    }
  }, [restFolded]);
  const scroller = useRef<HTMLDivElement>(null);
  const summary = useMemo(
    () => triage(totalSessions, notices, clock),
    [totalSessions, notices, clock],
  );
  const byGroup = Object.fromEntries(summary.map((g) => [g.group, g.sessions])) as Record<
    TriageGroup,
    Session[]
  >;
  // Tiles are facts that may overlap (a working colleague can also have a result to read);
  // the list below is the exclusive to-do order.
  const tiles = [
    { key: 'attention', tone: 'calling', label: TRIAGE_LABELS.attention, ids: byGroup.attention },
    {
      key: 'results',
      tone: 'done',
      label: TRIAGE_LABELS.results,
      ids: totalSessions.filter((s) => unreadInbox(s, notices).length),
    },
    {
      key: 'working',
      tone: 'working',
      label: '일하는 중',
      ids: totalSessions.filter((s) => workingFor(s, clock) !== null || isWorking(s, clock)),
    },
    { key: 'all', tone: 'resting', label: '함께', ids: totalSessions },
  ] as const;
  const visible = sessions.filter((s) => filter === 'all' || s.provider === filter);
  // Rooms other than the office are not a to-do list; keep them as one calm list.
  const groups =
    zone === 'office'
      ? triage(visible, notices, clock).filter((g) => g.sessions.length)
      : [{ group: 'resting' as TriageGroup, sessions: visible }];
  const jump = (ids: readonly Session[]) => {
    const target = ids.find((s) => visible.includes(s)) ?? ids[0];
    if (!target) return;
    if (byGroup.resting.includes(target)) setRestFolded(false);
    requestAnimationFrame(() =>
      scroller.current
        ?.querySelector(`[data-session-id="${CSS.escape(target.id)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    );
    onHover(target.id);
  };
  const hour = new Date(clock).getHours();
  const greeting =
    hour < 6
      ? '늦은 밤이에요'
      : hour < 12
        ? '좋은 아침이에요'
        : hour < 18
          ? '좋은 오후예요'
          : '좋은 저녁이에요';
  const resultCount = totalSessions.reduce((n, s) => n + unreadInbox(s, notices).length, 0);
  const headline = tiles[0].ids.length
    ? `${tiles[0].ids.length}명이 나를 기다려요`
    : resultCount
      ? `확인할 결과가 ${resultCount}건 있어요`
      : tiles[2].ids.length
        ? `${tiles[2].ids.length}명이 일하고 있어요`
        : '모두 조용히 쉬고 있어요';
  return (
    <aside className="roster" aria-label="동료 목록">
      <PanelTabs active="roster" unread={unread} onInbox={onInbox} />
      <div className="roster-head">
        <span>
          {date(clock)} · {greeting}
        </span>
        <h2>{headline}</h2>
      </div>
      <div className="stats-grid" role="group" aria-label="할 일 요약">
        {tiles.map((t) => (
          <button
            key={t.key}
            className={`stat ${t.tone} ${t.ids.length && t.key !== 'all' ? { attention: 'is-alert', results: 'is-result', working: 'is-live' }[t.key] : ''}`}
            onClick={() => jump(t.ids)}
            disabled={zone !== 'office' || !t.ids.length}
            title={`${t.label} · 목록에서 찾기`}
          >
            <span>
              <i />
              {t.label}
            </span>
            <strong>{t.ids.length}</strong>
          </button>
        ))}
      </div>
      <div className="roster-panel">
        <div className="section-title">
          <h2>{TITLES[zone]}</h2>
          <span>{zoneCount}</span>
          <select
            aria-label="동료 정렬"
            value={sort}
            onChange={(e) => onSort(e.target.value as 'recent' | 'frequent')}
          >
            <option value="recent">최근 활동순</option>
            <option value="frequent">자주 찾은 순</option>
          </select>
        </div>
        <div className="roster-finder">
          <label>
            <Search size={13} />
            <input
              aria-label="동료 이름 검색"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="이름 · 프로젝트로 찾기"
            />
            {query && (
              <button aria-label="검색어 지우기" onClick={() => onQuery('')}>
                <X size={12} />
              </button>
            )}
          </label>
        </div>
        <div className="provider-filters" role="group" aria-label="도구 필터">
          {(['all', 'claude', 'codex', 'openclaw'] as const).map((p) => (
            <button
              key={p}
              className={`${filter === p ? 'active' : ''} chip-${p}`}
              onClick={() => onFilter(p)}
            >
              {p !== 'all' && <i />}
              {p === 'all' ? '전체' : PROVIDERS[p].short}
            </button>
          ))}
        </div>
        <div className="roster-scroll" ref={scroller} onMouseLeave={() => onHover(null)}>
          {groups.map(({ group, sessions: rows }) => {
            const foldable = zone === 'office' && group === 'resting' && groups.length > 1;
            const folded = foldable && restFolded && !query;
            return (
              <section key={group} className={`roster-group group-${group}`} data-group={group}>
                {zone === 'office' && (
                  <div className="group-head">
                    <button
                      aria-expanded={!folded}
                      onClick={() => foldable && setRestFolded(!restFolded)}
                      disabled={!foldable}
                    >
                      <i />
                      <b>{TRIAGE_LABELS[group]}</b>
                      <em>{rows.length}</em>
                      {foldable && <ChevronDown size={13} className="group-chev" />}
                    </button>
                    {group === 'results' ? (
                      <button
                        className="group-action"
                        title="이 그룹의 최종 응답을 모두 읽음으로 표시 · 확인 필요는 남겨요"
                        onClick={() =>
                          onReceipt(
                            rows
                              .flatMap((r) => unreadInbox(r, notices))
                              .filter((n) => !isAttentionNotice(n))
                              .map(({ id, version }) => ({ id, version })),
                            'read',
                          )
                        }
                      >
                        <CheckCheck size={12} />
                        모두 읽음
                      </button>
                    ) : (
                      <small>{HINTS[group]}</small>
                    )}
                  </div>
                )}
                {!folded &&
                  rows.map((s) => {
                    const news = unreadInbox(s, notices);
                    const elapsed = workingFor(s, clock);
                    const activity = sessionActivity(s);
                    const active =
                      s.id === selected || s.resident?.sessionIds.includes(selected ?? '');
                    const result = zone === 'office' && group === 'results' ? news[0] : undefined;
                    return (
                      <button
                        key={s.id}
                        data-session-id={s.id}
                        className={`session-row status-${s.status} ${elapsed !== null ? 'is-live' : ''} ${active ? 'selected' : ''} ${hovered === s.id ? 'is-hover' : ''}`}
                        onClick={() => onSelect(s.id)}
                        onMouseEnter={() => onHover(s.id)}
                      >
                        <div className={`face face-${s.provider}`}>
                          <Sprite provider={s.provider} mood={s.status} size={36} />
                          <i style={{ background: MOODS[s.status].color }} />
                        </div>
                        <div className="session-copy">
                          <strong>
                            <span>{privacy ? PROVIDERS[s.provider].name : sessionName(s)}</span>
                            {s.pinned && <Pin size={10} />}
                            {news.length > 0 && (
                              <em title={`미확인 소식 ${news.length}건`}>{news.length}</em>
                            )}
                          </strong>
                          <span className="session-meta">
                            {privacy ? '내용 숨김' : s.project}
                            <i>·</i>
                            {sort === 'frequent'
                              ? `${s.openCount || 0}번 열어봄`
                              : ago(s.updatedAt)}
                          </span>
                          {!privacy && (
                            <p
                              className="session-progress"
                              title={`${activityLabel(s)} · ${ago(activity.at)}\n${activity.text}`}
                            >
                              {result ? result.text : activity.text}
                            </p>
                          )}
                          <small style={{ color: MOODS[s.status].color }}>
                            {elapsed !== null
                              ? `일하는 중 · ${durationShort(elapsed)}`
                              : result
                                ? `새 결과 ${news.length}건 · ${ago(result.at)}`
                                : MOODS[s.status].label}
                            {s.resident ? ` · 실행 ${s.resident.sessionIds.length}개` : ''}
                            {s.relation?.kind === 'subagent' || s.relation?.kind === 'child'
                              ? ' · 보조 동료'
                              : s.relation?.kind === 'fork'
                                ? ' · 분기한 작업'
                                : ''}
                          </small>
                        </div>
                      </button>
                    );
                  })}
              </section>
            );
          })}
          {visible.length === 0 && <div className="empty-small">조건에 맞는 동료가 없어요.</div>}
        </div>
      </div>
    </aside>
  );
}
