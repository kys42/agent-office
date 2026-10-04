import { ArrowRight, Pin, Search, X } from 'lucide-react';
import type { OfficeNotice, OfficeZone, Provider, Session } from '../shared/types';
import { MOODS, PROVIDERS } from '../shared/types';
import { Sprite } from './Sprite';
import { ago, date } from '../lib/format';
import { sessionActivity, activityLabel } from '../shared/activity';
import { isWorking } from '../shared/presentation';
import { sessionName } from '../shared/office';
import { unreadNoticeCount } from '../shared/notices';
const TITLES: Record<OfficeZone, string> = {
  office: '사무실의 동료',
  waiting: '라운지의 동료',
  archive: '보관된 기록',
};
export function Roster({
  zone,
  sessions,
  totalSessions,
  zoneCount,
  notices,
  query,
  onQuery,
  sort,
  onSort,
  selected,
  onSelect,
  privacy,
  filter,
  onFilter,
}: {
  zone: OfficeZone;
  sessions: Session[];
  totalSessions: Session[];
  zoneCount: number;
  notices: OfficeNotice[];
  query: string;
  onQuery: (q: string) => void;
  sort: 'recent' | 'frequent';
  onSort: (s: 'recent' | 'frequent') => void;
  selected: string | null;
  onSelect: (id: string) => void;
  privacy: boolean;
  filter: Provider | 'all';
  onFilter: (p: Provider | 'all') => void;
}) {
  const calls = totalSessions.filter((s) => s.status === 'call' || s.status === 'error');
  const working = totalSessions.filter((s) => isWorking(s)).length;
  const replies = totalSessions.filter((s) => s.status === 'done').length;
  const hour = new Date().getHours();
  const greeting =
    hour < 6
      ? '늦은 밤이에요'
      : hour < 12
        ? '좋은 아침이에요'
        : hour < 18
          ? '좋은 오후예요'
          : '좋은 저녁이에요';
  return (
    <aside className="roster" aria-label="동료 목록">
      <div className="roster-head">
        <span>{date(Date.now())}</span>
        <h2>{greeting}</h2>
      </div>
      <div className="stats-grid">
        <div className={`stat working ${working ? 'is-live' : ''}`}>
          <span>
            <i />
            작업 중
          </span>
          <strong>{working}</strong>
        </div>
        <div className={`stat calling ${calls.length ? 'is-alert' : ''}`}>
          <span>
            <i />
            불러요
          </span>
          <strong>{calls.length}</strong>
        </div>
        <div className="stat done">
          <span>
            <i />
            응답 완료
          </span>
          <strong>{replies}</strong>
        </div>
        <div className="stat resting">
          <span>
            <i />
            함께
          </span>
          <strong>{totalSessions.length}</strong>
        </div>
      </div>
      {calls.length > 0 ? (
        <div className="call-stack">
          {calls.slice(0, 3).map((s) => (
            <button
              key={s.id}
              className={`call-card call-${s.status}`}
              onClick={() => onSelect(s.id)}
            >
              <span className={`face face-${s.provider}`}>
                <Sprite provider={s.provider} mood={s.status} size={32} />
              </span>
              <div>
                <b>
                  {privacy ? '동료가' : sessionName(s)}{' '}
                  {s.status === 'call' ? '부르고 있어요' : '확인이 필요해요'}
                </b>
                <p>
                  {s.status === 'call'
                    ? '질문을 확인하고 다시 이어가요.'
                    : '원래 앱에서 작업 상태를 확인해 주세요.'}
                </p>
              </div>
              <ArrowRight size={15} />
            </button>
          ))}
        </div>
      ) : (
        <div className="calm-card">
          <span className="calm-dot" />
          <p>
            <b>모두 각자의 속도로.</b> 동료가 부르면 여기서 먼저 알려드릴게요.
          </p>
        </div>
      )}
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
        <div className="roster-scroll">
          {sessions
            .filter((s) => filter === 'all' || s.provider === filter)
            .map((s) => {
              const unread = unreadNoticeCount(
                notices.filter((n) => (s.resident?.sessionIds ?? [s.id]).includes(n.sessionId)),
              );
              const live = isWorking(s);
              return (
                <button
                  key={s.id}
                  className={`session-row status-${s.status} ${live ? 'is-live' : ''} ${s.id === selected || s.resident?.sessionIds.includes(selected ?? '') ? 'selected' : ''}`}
                  onClick={() => onSelect(s.id)}
                >
                  <div className={`face face-${s.provider}`}>
                    <Sprite provider={s.provider} mood={s.status} size={36} />
                    <i style={{ background: MOODS[s.status].color }} />
                  </div>
                  <div className="session-copy">
                    <strong>
                      <span>{privacy ? PROVIDERS[s.provider].name : sessionName(s)}</span>
                      {s.pinned && <Pin size={10} />}
                      {unread > 0 && <em>{unread}</em>}
                    </strong>
                    <span className="session-meta">
                      {privacy ? '내용 숨김' : s.project}
                      <i>·</i>
                      {sort === 'frequent' ? `${s.openCount || 0}번 열어봄` : ago(s.updatedAt)}
                    </span>
                    {!privacy && (
                      <p
                        className="session-progress"
                        title={`${activityLabel(s)} · ${ago(sessionActivity(s).at)}\n${sessionActivity(s).text}`}
                      >
                        {sessionActivity(s).text}
                      </p>
                    )}
                    <small style={{ color: MOODS[s.status].color }}>
                      {live ? '일하는 중' : MOODS[s.status].label}
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
          {sessions.length === 0 && <div className="empty-small">조건에 맞는 동료가 없어요.</div>}
        </div>
      </div>
    </aside>
  );
}
