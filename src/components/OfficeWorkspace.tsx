import { useEffect, useMemo, useState } from 'react';
import { Archive, Armchair, Home, Pin, RotateCw, Search, ArrowUpRight, Clock3 } from 'lucide-react';
import type { OfficeZone, Provider, Session, Snapshot } from '../shared/types';
import { MOODS, PROVIDERS } from '../shared/types';
import { officeZone, sessionName } from '../shared/office';
import { date, ago } from '../lib/format';
import { Office } from './Office';
import { Roster } from './Roster';
import { officeSchedule } from '../shared/lifecycle';
import { officeResidents, sessionScopeLabel } from '../shared/residents';
import { RestLounge } from './RestLounge';
import { Sprite } from './Sprite';
import type { ReceiptHandler } from './News';
function saved<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
export function OfficeWorkspace({
  snapshot,
  onReceipt,
  onNews,
  selected,
  onSelect,
  onReturn,
  onRefresh,
  onSettings,
  refreshing,
  demo,
}: {
  snapshot: Snapshot;
  onReceipt: ReceiptHandler;
  onNews: (id: string) => void;
  selected: string | null;
  onSelect: (id: string) => void;
  onReturn: (id: string) => void;
  onRefresh: () => void;
  onSettings: () => void;
  refreshing: boolean;
  demo: boolean;
}) {
  const key = `office:view:${demo ? 'demo' : 'live'}`;
  const [zone, setZone] = useState<OfficeZone>(
    () => saved(key, { zone: 'office' }).zone as OfficeZone,
  );
  const [filter, setFilter] = useState<Provider | 'all'>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'recent' | 'frequent'>(
    () => saved(key, { sort: 'recent' }).sort as 'recent' | 'frequent',
  );
  const { preferences: prefs } = snapshot;
  const { sessions, hidden } = useMemo(
    () => officeResidents(snapshot.sessions),
    [snapshot.sessions],
  );
  const [historyLimit, setHistoryLimit] = useState(20);
  const zones = useMemo(
    () =>
      Object.fromEntries(
        (['office', 'waiting', 'archive'] as OfficeZone[]).map((z) => [
          z,
          sessions.filter((s) => (s.zone || officeZone(s, prefs)) === z),
        ]),
      ) as Record<OfficeZone, Session[]>,
    [sessions, prefs],
  );
  const office = zones.office;
  useEffect(() => {
    const s = sessions.find(
      (s) => s.id === selected || s.resident?.sessionIds.includes(selected ?? ''),
    );
    if (s) {
      setZone(s.zone || officeZone(s, prefs));
    }
  }, [selected]);
  const rows = zones[zone]
    .filter(
      (s) =>
        (filter === 'all' || s.provider === filter) &&
        [sessionName(s), s.project].join(' ').toLowerCase().includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (sort === 'frequent' ? (b.openCount || 0) - (a.openCount || 0) : 0) ||
        b.updatedAt - a.updatedAt,
    );
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify({ zone, sort }));
  }, [key, zone, sort]);
  const choose = (id: string) => {
    onSelect(id);
  };
  return (
    <>
      <div className="office-heading">
        <div>
          <span className="eyebrow">
            <span className="sun-symbol">✷</span> A LITTLE OFFICE, A LOT OF POSSIBILITIES
          </span>
          <h1>
            같은 일을 하는 동료들, 한자리에<span>.</span>
          </h1>
          <p>
            {date(Date.now())}
            <span>·</span>동료의 이름으로 찾고, 마지막 대화부터 이어가요.
          </p>
        </div>
        <div className="heading-actions">
          <span className={`live-badge ${prefs.paused ? 'paused' : ''}`}>
            <i />
            {demo ? 'DEMO' : prefs.paused ? '수집 쉬는 중' : 'LOCAL LIVE'}
          </span>
          <button
            className={`icon-btn ${refreshing ? 'spin' : ''}`}
            aria-label="세션 새로고침"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RotateCw size={17} />
          </button>
        </div>
      </div>
      <div className="office-zone-bar">
        <div role="tablist" aria-label="사무실 공간">
          {(
            [
              { id: 'office', label: '사무실', icon: Home },
              { id: 'waiting', label: '대기 라운지', icon: Armchair },
              { id: 'archive', label: '보관 공간', icon: Archive },
            ] as const
          ).map((z) => (
            <button
              key={z.id}
              role="tab"
              aria-selected={zone === z.id}
              className={zone === z.id ? 'active' : ''}
              onClick={() => {
                setZone(z.id);
                setQuery('');
              }}
            >
              <z.icon size={16} />
              {z.label}
              <span>{zones[z.id].length}</span>
            </button>
          ))}
        </div>
        <button
          className="office-policy"
          onClick={onSettings}
          aria-label="사무실 설정 열기"
          title="퇴근·보관 기준 바꾸기"
        >
          {officeSchedule(prefs)} <span aria-hidden="true">⚙</span>
        </button>
      </div>
      {zone === 'office' ? (
        <div className="office-layout">
          <div className="office-column">
            <Office
              sessions={office}
              notices={snapshot.notices ?? []}
              bubbleHours={prefs.bubbleHours ?? 3}
              onReceipt={onReceipt}
              onNews={onNews}
              selected={selected}
              onSelect={choose}
              reducedMotion={prefs.reducedMotion}
              privacy={prefs.privacy}
              onShowWaiting={() => setZone('waiting')}
            />
          </div>
          <Roster
            sessions={rows}
            totalSessions={office}
            selected={selected}
            onSelect={choose}
            privacy={prefs.privacy}
            filter={filter}
            onFilter={setFilter}
            query={query}
            onQuery={setQuery}
            sort={sort}
            onSort={setSort}
          />
        </div>
      ) : (
        <section className={`session-room room-${zone}`}>
          <div className="room-intro">
            <div>
              <span className="eyebrow">
                {zone === 'waiting' ? 'TAKE A LITTLE BREAK' : 'GOOD WORK LEAVES A TRACE'}
              </span>
              <h2>{zone === 'waiting' ? '잠시 쉬어가는 동료들.' : '지나간 일도, 언제든 다시.'}</h2>
              <p>
                {zone === 'waiting'
                  ? '새 활동이 생기면 사무실로 돌아와요. 직접 자리를 마련해 줄 수도 있어요.'
                  : '오래된 기록을 모아두었어요. 원본과 메모는 그대로 남아 있어요.'}
              </p>
            </div>
            <div className="room-symbol">
              {zone === 'waiting' ? <Armchair size={46} /> : <Archive size={46} />}
            </div>
          </div>
          <div className="room-search">
            <label>
              <Search size={16} />
              <input
                aria-label="공간의 세션 검색"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="세션 이름이나 프로젝트로 찾기"
              />
            </label>
            <select
              aria-label="공간 정렬"
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
            >
              <option value="recent">최근 사용 순</option>
              <option value="frequent">자주 찾은 순</option>
            </select>
            <select
              aria-label="공간 도구 필터"
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
            >
              <option value="all">모든 도구</option>
              {Object.entries(PROVIDERS).map(([id, p]) => (
                <option value={id} key={id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {zone === 'waiting' ? (
            <RestLounge
              sessions={rows}
              privacy={prefs.privacy}
              reducedMotion={prefs.reducedMotion}
              onSelect={choose}
              onReturn={(id) => {
                onReturn(id);
                setZone('office');
              }}
            />
          ) : (
            <div className="room-sessions">
              {rows.map((s) => (
                <article key={s.id} className="room-session">
                  <button className="room-session-main" onClick={() => choose(s.id)}>
                    <div className={`avatar avatar-${s.provider}`}>
                      <Sprite provider={s.provider} mood="idle" size={52} />
                    </div>
                    <div>
                      <span className="provider-label">{PROVIDERS[s.provider].name}</span>
                      <h3>{prefs.privacy ? '숨긴 세션' : sessionName(s)}</h3>
                      <p>{prefs.privacy ? '프로젝트 숨김' : s.project}</p>
                      <small>
                        <Clock3 size={11} />
                        {ago(s.updatedAt)} 활동 · {s.openCount || 0}번 열어봄
                      </small>
                    </div>
                    <ArrowUpRight size={17} />
                  </button>
                  <div className="room-session-bottom">
                    <span>{s.archived ? '직접 보관함' : '오래된 기록'}</span>
                    <button
                      onClick={() => {
                        onReturn(s.id);
                        setZone('office');
                      }}
                    >
                      사무실로 데려오기 <ArrowUpRight size={13} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
          {!rows.length && (
            <div className="empty-state">
              <Armchair size={32} />
              <h3>이 공간은 비어 있어요</h3>
              <p>동료들의 활동에 맞춰 자연스럽게 채워집니다.</p>
            </div>
          )}
        </section>
      )}
      {hidden.length > 0 && (
        <details className="background-records">
          <summary>
            보조·자동 작업 기록 <b>{hidden.length}</b>
            <span>이전 작업의 보조 동료와 내부 실행은 여기에 보관해요.</span>
          </summary>
          <div>
            {[...hidden]
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, historyLimit)
              .map((s) => (
                <button key={s.id} onClick={() => choose(s.id)}>
                  <span>{privacyName(s, prefs.privacy)}</span>
                  <small>
                    {sessionScopeLabel(s)} · {ago(s.updatedAt)}
                  </small>
                </button>
              ))}
          </div>
          {hidden.length > historyLimit && (
            <button className="button subtle" onClick={() => setHistoryLimit((n) => n + 20)}>
              기록 더 보기
            </button>
          )}
        </details>
      )}
    </>
  );
}

function privacyName(s: Session, privacy: boolean) {
  return privacy ? '숨긴 기록' : sessionName(s);
}
