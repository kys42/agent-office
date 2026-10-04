import { ArrowUpRight, Pin, Search, ChevronRight } from 'lucide-react';
import type { Provider, Session } from '../shared/types';
import { MOODS, PROVIDERS } from '../shared/types';
import { Sprite } from './Sprite';
import { ago } from '../lib/format';
import { sessionActivity, activityLabel } from '../shared/activity';
import { isWorking } from '../shared/presentation';
import { sessionName } from '../shared/office';
export function Roster({
  sessions,
  totalSessions,
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
  sessions: Session[];
  totalSessions: Session[];
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
  const calls = totalSessions.filter((s) => s.status === 'call');
  const working = totalSessions.filter((s) => isWorking(s)).length;
  return (
    <aside className="roster">
      <div className="stats-grid">
        <div className="stat working">
          <span>
            <i />
            일하는 중
          </span>
          <strong>
            {working}
            <small>명</small>
          </strong>
        </div>
        <div className="stat calling">
          <span>
            <i />
            불러요
          </span>
          <strong>
            {calls.length}
            <small>명</small>
          </strong>
        </div>
        <div className="stat resting">
          <span>
            <i />
            함께하는 동료
          </span>
          <strong>
            {totalSessions.length}
            <small>명</small>
          </strong>
        </div>
      </div>
      {calls.length > 0 ? (
        <button className="call-card" onClick={() => onSelect(calls[0].id)}>
          <span className="call-icon">!</span>
          <div>
            <b>{privacy ? '동료가' : sessionName(calls[0])} 부르고 있어요</b>
            <p>질문을 확인하고 다시 이어가요.</p>
          </div>
          <ArrowUpRight size={19} />
        </button>
      ) : (
        <div className="calm-card">
          <span>☕</span>
          <div>
            <b>각자의 속도로, 함께</b>
            <p>동료가 부르면 여기서 알려드릴게요.</p>
          </div>
        </div>
      )}
      <div className="roster-panel">
        <div className="section-title">
          <h2>내 동료 찾기</h2>
          <span>{totalSessions.length}</span>
        </div>
        <div className="provider-filters" role="group" aria-label="도구 필터">
          {(['all', 'claude', 'codex', 'openclaw'] as const).map((p) => (
            <button key={p} className={filter === p ? 'active' : ''} onClick={() => onFilter(p)}>
              {p === 'all' ? '전체' : PROVIDERS[p].short}
            </button>
          ))}
        </div>
        <div className="roster-finder">
          <label>
            <Search size={13} />
            <input
              aria-label="동료 이름 검색"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="이름 · 프로젝트 찾기"
            />
          </label>
          <select
            aria-label="동료 정렬"
            value={sort}
            onChange={(e) => onSort(e.target.value as 'recent' | 'frequent')}
          >
            <option value="recent">최근 사용 순</option>
            <option value="frequent">자주 찾은 순</option>
          </select>
        </div>
        <div className="roster-scroll">
          {sessions
            .filter((s) => filter === 'all' || s.provider === filter)
            .map((s) => (
              <button
                key={s.id}
                className={`session-row ${s.id === selected || s.resident?.sessionIds.includes(selected ?? '') ? 'selected' : ''}`}
                onClick={() => onSelect(s.id)}
              >
                <div className={`avatar avatar-${s.provider}`}>
                  <Sprite provider={s.provider} mood={s.status} size={48} />
                </div>
                <div className="session-copy">
                  <strong>
                    {privacy ? PROVIDERS[s.provider].name : sessionName(s)}
                    {s.pinned && <Pin size={11} />}
                  </strong>
                  <span>
                    {privacy ? '내용 숨김' : s.project} <i>·</i>{' '}
                    {sort === 'frequent' ? `${s.openCount || 0}번 열어봄` : ago(s.updatedAt)}
                  </span>
                  {!privacy && (
                    <p
                      className="session-progress"
                      title={`${activityLabel(s)} · ${ago(sessionActivity(s).at)}\n${sessionActivity(s).text}`}
                    >
                      <span>{activityLabel(s)}</span> {sessionActivity(s).text}
                    </p>
                  )}
                  <small style={{ color: MOODS[s.status].color }}>
                    <i className="status-dot" style={{ background: MOODS[s.status].color }} />
                    {isWorking(s) ? '일하는 중' : MOODS[s.status].label}
                    {s.resident ? ` · 실행 ${s.resident.sessionIds.length}개` : ''}
                    {s.relation?.kind === 'subagent' || s.relation?.kind === 'child'
                      ? ' · 보조 동료'
                      : s.relation?.kind === 'fork'
                        ? ' · 분기한 작업'
                        : ''}
                  </small>
                </div>
                <ChevronRight className="row-arrow" size={16} />
              </button>
            ))}
          {sessions.length === 0 && <div className="empty-small">조건에 맞는 동료가 없어요.</div>}
        </div>
      </div>
      <div className="roster-foot">
        <span className="tiny-square" /> 작은 사무실, 이어지는 업무 기억
      </div>
    </aside>
  );
}
