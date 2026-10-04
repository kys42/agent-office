import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Armchair,
  Building2,
  RotateCw,
  ArrowUpRight,
  Clock3,
  Layers,
  ChevronUp,
  SlidersHorizontal,
} from 'lucide-react';
import type { OfficeZone, Provider, Session, Snapshot } from '../shared/types';
import { PROVIDERS } from '../shared/types';
import { officeZone, sessionName } from '../shared/office';
import { ago } from '../lib/format';
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
const ZONES = [
  { id: 'office', label: '사무실', icon: Building2 },
  { id: 'waiting', label: '대기 라운지', icon: Armchair },
  { id: 'archive', label: '보관 공간', icon: Archive },
] as const;
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
  const bring = (id: string) => {
    onReturn(id);
    setZone('office');
  };
  return (
    <div className="office-layout">
      <div className="office-column">
        <div className="stage-toolbar">
          <div className="zone-tabs" role="tablist" aria-label="사무실 공간">
            {ZONES.map((z) => (
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
                <z.icon size={15} strokeWidth={1.9} />
                {z.label}
                <span>{zones[z.id].length}</span>
              </button>
            ))}
          </div>
          <div className="stage-toolbar-end">
            <span
              className={`live-badge ${demo ? 'demo' : prefs.paused ? 'paused' : ''}`}
              title={
                demo
                  ? '예시 데이터'
                  : prefs.paused
                    ? '수집을 쉬고 있어요'
                    : '5초마다 로컬 기록을 확인해요'
              }
            >
              <i />
              {demo ? 'Demo' : prefs.paused ? 'Paused' : 'Live'}
            </span>
            <button
              className="office-policy"
              onClick={onSettings}
              aria-label="사무실 설정 열기"
              title="퇴근·보관 기준 바꾸기"
            >
              <SlidersHorizontal size={13} />
              {officeSchedule(prefs)}
            </button>
            <button
              className={`icon-btn ${refreshing ? 'spin' : ''}`}
              aria-label="세션 새로고침"
              title="지금 다시 확인"
              onClick={onRefresh}
              disabled={refreshing}
            >
              <RotateCw size={15} />
            </button>
          </div>
        </div>
        {zone === 'office' ? (
          <Office
            sessions={office}
            notices={snapshot.notices ?? []}
            bubbleHours={prefs.bubbleHours ?? 3}
            onReceipt={onReceipt}
            onNews={onNews}
            selected={selected}
            onSelect={onSelect}
            reducedMotion={prefs.reducedMotion}
            privacy={prefs.privacy}
            onShowWaiting={() => setZone('waiting')}
            footer={
              hidden.length > 0 && (
                <details className="background-records">
                  <summary>
                    <Layers size={13} />
                    보조·자동 작업 기록 <b>{hidden.length}</b>
                    <ChevronUp size={13} className="chev" />
                  </summary>
                  <div className="background-pop">
                    <p>이전 작업의 보조 동료와 내부 실행은 여기에 접어 둬요.</p>
                    <div>
                      {[...hidden]
                        .sort((a, b) => b.updatedAt - a.updatedAt)
                        .slice(0, historyLimit)
                        .map((s) => (
                          <button key={s.id} onClick={() => onSelect(s.id)}>
                            <span className={`face face-${s.provider}`}>
                              <Sprite provider={s.provider} mood="idle" size={22} />
                            </span>
                            <span>{prefs.privacy ? '숨긴 기록' : sessionName(s)}</span>
                            <small>
                              {sessionScopeLabel(s)} · {ago(s.updatedAt)}
                            </small>
                          </button>
                        ))}
                    </div>
                    {hidden.length > historyLimit && (
                      <button
                        className="button subtle"
                        onClick={() => setHistoryLimit((n) => n + 20)}
                      >
                        기록 더 보기
                      </button>
                    )}
                  </div>
                </details>
              )
            }
          />
        ) : (
          <section className={`session-room room-${zone}`}>
            {zone === 'waiting' ? (
              <RestLounge
                sessions={rows}
                privacy={prefs.privacy}
                reducedMotion={prefs.reducedMotion}
                onSelect={onSelect}
                onReturn={bring}
              />
            ) : (
              <div className="archive-room">
                <div className="room-intro">
                  <Archive size={18} />
                  <div>
                    <h2>보관 공간</h2>
                    <p>오래된 기록을 모아두었어요. 원본과 메모는 그대로 남아 있어요.</p>
                  </div>
                </div>
                <div className="room-sessions">
                  {rows.map((s) => (
                    <article key={s.id} className="room-session">
                      <button className="room-session-main" onClick={() => onSelect(s.id)}>
                        <div className={`face face-lg face-${s.provider}`}>
                          <Sprite provider={s.provider} mood="leave" size={48} />
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
                      </button>
                      <div className="room-session-bottom">
                        <span>{s.archived ? '직접 보관함' : '오래된 기록'}</span>
                        <button onClick={() => bring(s.id)}>
                          사무실로 데려오기 <ArrowUpRight size={13} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            )}
            {!rows.length && (
              <div className="empty-state room-empty">
                {zone === 'waiting' ? <Armchair size={30} /> : <Archive size={30} />}
                <h3>이 공간은 비어 있어요</h3>
                <p>동료들의 활동에 맞춰 자연스럽게 채워집니다.</p>
              </div>
            )}
          </section>
        )}
      </div>
      <Roster
        zone={zone}
        sessions={rows}
        totalSessions={office}
        zoneCount={zones[zone].length}
        notices={snapshot.notices ?? []}
        selected={selected}
        onSelect={onSelect}
        privacy={prefs.privacy}
        filter={filter}
        onFilter={setFilter}
        query={query}
        onQuery={setQuery}
        sort={sort}
        onSort={setSort}
      />
    </div>
  );
}
