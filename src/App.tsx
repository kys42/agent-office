import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Home,
  BookOpen,
  Clock3,
  Settings2,
  Search,
  ChevronLeft,
  ChevronRight,
  Monitor,
  Eye,
  EyeOff,
  RefreshCw,
  Wifi,
  ShieldCheck,
  ArrowUpRight,
  Play,
  X,
  Archive,
  AlertCircle,
  ChevronsUpDown,
  Sparkles,
  Pause,
} from 'lucide-react';
import { api } from './lib/api';
import {
  MOODS,
  PROVIDERS,
  type Preferences,
  type Provider,
  type Session,
  type SessionPatch,
  type Snapshot,
} from './shared/types';
import { demoSnapshot, reconcileDemo } from './lib/demo';
import { date, time, ago } from './lib/format';
import { Sprite } from './components/Sprite';
import { OfficeWorkspace } from './components/OfficeWorkspace';
import { officeZone, allocateSeats, seatKey } from './shared/office';
import { officeResidents } from './shared/residents';
import { Roster } from './components/Roster';
import { Inspector } from './components/Inspector';
import { Memory } from './components/Memory';
import { Settings } from './components/Settings';
import { MiniOffice } from './components/MiniOffice';
import { NewsInbox } from './components/News';
import { applyNoticeReceipt, unreadNoticeCount } from './shared/notices';
import type { NoticeReceipt } from './shared/types';
const tabs = [
  { id: 'office', title: '우리 사무실', icon: Home },
  { id: 'memory', title: '기억 서랍', icon: BookOpen },
  { id: 'activity', title: '활동 기록', icon: Clock3 },
  { id: 'settings', title: '연결과 설정', icon: Settings2 },
] as const;
export default function App() {
  const [demo, setDemo] = useState(new URLSearchParams(location.search).has('demo'));
  const [snapshot, setSnapshot] = useState<Snapshot | null>(demo ? demoSnapshot() : null);
  const [inbox, setInbox] = useState(false);
  const [showNews, setShowNews] = useState<string | null>(null);
  const [view, setView] = useState<(typeof tabs)[number]['id']>('office');
  const [selected, setSelected] = useState<string | null>(
    location.hash.startsWith('#session=')
      ? decodeURIComponent(location.hash.slice(9))
      : !demo
        ? localStorage.getItem('office:last-session')
        : null,
  );
  useEffect(() => {
    if (!demo) {
      if (selected) localStorage.setItem('office:last-session', selected);
      else localStorage.removeItem('office:last-session');
    }
  }, [selected, demo]);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mini = location.hash === '#mini';
  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4200);
  }, []);
  useEffect(() => {
    if (demo) {
      setSnapshot(demoSnapshot());
      setError('');
      return;
    }
    let active = true;
    setSnapshot(null);
    api
      .snapshot()
      .then((s) => {
        if (active) {
          setSnapshot(s);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    const unsubscribe = api.subscribe((s) => {
      if (active) {
        setSnapshot(s);
        setError('');
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [demo]);
  useEffect(
    () =>
      api.onSelect?.((id) => {
        setView('office');
        setSelected(id);
      }),
    [],
  );
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setView('memory');
        setTimeout(
          () => document.querySelector<HTMLInputElement>('[aria-label="기록 검색"]')?.focus(),
          100,
        );
      }
      if (e.key === 'Escape') {
        setSelected(null);
        setInbox(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    document.body.classList.toggle('mini-mode', mini);
    return () => document.body.classList.remove('mini-mode');
  }, [mini]);
  const sessions = snapshot?.sessions ?? [];
  const ordered = officeResidents(sessions)
    .sessions.filter((s) => (s.zone || officeZone(s, snapshot?.preferences || {})) === 'office')
    .sort((a, b) => (a.officeSeat ?? 0) - (b.officeSeat ?? 0));
  const current = sessions.find((s) => s.id === selected);
  const prefs = snapshot?.preferences;
  const refresh = async () => {
    if (demo) {
      notify('데모 화면이에요. 실제 연결을 보려면 데모를 종료해 주세요.');
      return;
    }
    setRefreshing(true);
    try {
      const s = await api.refresh();
      setSnapshot(s);
      setError('');
      notify('동료들의 최신 기록을 확인했어요');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  const onPrefs = async (p: Partial<Preferences>) => {
    if (demo) {
      setSnapshot((s) =>
        s ? reconcileDemo({ ...s, preferences: { ...s.preferences, ...p } }) : s,
      );
      return;
    }
    try {
      setSnapshot(await api.preferences(p));
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const onPatch = async (id: string, p: SessionPatch) => {
    if (demo) {
      setSnapshot((s) =>
        s
          ? reconcileDemo({
              ...s,
              sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...p } : x)),
            })
          : s,
      );
      return;
    }
    setSnapshot(await api.patch(id, p));
  };
  const onReceipt = async (
    receipts: NoticeReceipt[],
    action: 'read' | 'dismiss' | 'unread' | 'view',
  ) => {
    if (demo) {
      setSnapshot((s) =>
        s ? { ...s, notices: applyNoticeReceipt(s.notices ?? [], receipts, action) } : s,
      );
      return;
    }
    try {
      for (let i = 0; i < receipts.length; i += 1000)
        setSnapshot(await api.notices(receipts.slice(i, i + 1000), action));
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const choose = (id: string) => {
    setInbox(false);
    setShowNews(null);
    setSelected(id);
    if (!demo)
      void api
        .visit(id)
        .then(setSnapshot)
        .catch((e) => notify(e.message));
    else
      setSnapshot((s) =>
        s
          ? {
              ...s,
              sessions: s.sessions.map((x) =>
                x.id === id
                  ? { ...x, openCount: (x.openCount || 0) + 1, lastViewedAt: Date.now() }
                  : x,
              ),
            }
          : s,
      );
  };
  const returnToOffice = async (id: string) => {
    if (!demo) {
      try {
        setSnapshot(await api.returnToOffice(id));
        notify('사무실에 자리를 마련했어요');
      } catch (e) {
        notify((e as Error).message);
      }
      return;
    }
    setSnapshot((s) => {
      if (!s) return s;
      const sessions = s.sessions.map((x) =>
        x.id === id
          ? { ...x, archived: false, returnedAt: Date.now(), zone: 'office' as const }
          : x,
      );
      const active = officeResidents(sessions).sessions.filter(
        (x) => officeZone(x, s.preferences) === 'office',
      );
      const seats = allocateSeats(
        active,
        Object.fromEntries(
          active.filter((x) => x.officeSeat !== undefined).map((x) => [seatKey(x), x.officeSeat!]),
        ),
      );
      return {
        ...s,
        sessions: sessions.map((x) => ({
          ...x,
          officeSeat: seats[seatKey(x)],
          zone: officeZone(x, s.preferences),
        })),
      };
    });
  };
  if (mini)
    return (
      <MiniOffice
        sessions={ordered}
        notices={snapshot?.notices ?? []}
        privacy={prefs?.privacy ?? false}
        reducedMotion={prefs?.reducedMotion ?? false}
      />
    );
  return (
    <div
      className={`app ${prefs?.reducedMotion ? 'reduce-motion' : ''} ${current || inbox ? 'has-dock' : ''}`}
    >
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">
            <span />
            <span />
            <span />
            <span />
          </div>
          <b>
            agent office<span>작은 동료들의 큰 하루</span>
          </b>
        </div>
        <div className="header-spacer" />
        <button
          className="global-search"
          onClick={() => {
            setView('memory');
            setTimeout(
              () => document.querySelector<HTMLInputElement>('[aria-label="기록 검색"]')?.focus(),
              100,
            );
          }}
        >
          <Search size={15} />
          <span>기억 찾기</span>
          <kbd>⌘ K</kbd>
        </button>
        <button
          className={`button inbox-button ${inbox ? 'active' : ''}`}
          aria-label="소식함 열기"
          onClick={() => {
            setInbox((v) => !v);
            setSelected(null);
          }}
        >
          <span>소식함</span>
          <b>{unreadNoticeCount(snapshot?.notices ?? [])}</b>
        </button>
        <div className="header-divider" />
        <button
          className="icon-btn"
          aria-label={prefs?.privacy ? '내용 다시 보기' : '화면 내용 숨기기'}
          title="화면 내용 숨기기"
          onClick={() => onPrefs({ privacy: !prefs?.privacy })}
        >
          {prefs?.privacy ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
        <button className="button mini-button" onClick={() => api.window('mini')}>
          <Monitor size={15} />
          미니 오피스
        </button>
      </header>
      <div className="app-body">
        <nav className="side-nav" aria-label="주 메뉴">
          <div>
            {tabs.slice(0, 3).map((t) => (
              <button
                key={t.id}
                className={view === t.id ? 'active' : ''}
                aria-label={t.title}
                title={t.title}
                onClick={() => {
                  setView(t.id);
                  setSelected(null);
                }}
              >
                <t.icon size={21} />
                <span>{t.title.replace('우리 ', '')}</span>
              </button>
            ))}
          </div>
          <div className="nav-bottom">
            <button
              className={view === 'settings' ? 'active' : ''}
              aria-label="연결과 설정"
              title="연결과 설정"
              onClick={() => {
                setView('settings');
                setSelected(null);
              }}
            >
              <Settings2 size={21} />
              <span>설정</span>
            </button>
            <div className="user-token">Y</div>
          </div>
        </nav>
        <main className={`main-content view-${view}`}>
          {demo && (
            <div className="demo-banner">
              <Sparkles size={15} />
              <span>구경하는 사무실 · 모든 기록은 예시 데이터예요</span>
              <button
                onClick={() => {
                  setDemo(false);
                  setSelected(null);
                  history.replaceState(null, '', location.pathname);
                }}
              >
                실제 동료 만나기 <ArrowUpRight size={14} />
              </button>
            </div>
          )}
          {error && (
            <div className="error-banner">
              <AlertCircle size={17} />
              <span>{error}</span>
              <button onClick={refresh}>다시 연결</button>
            </div>
          )}
          {!snapshot && !error ? (
            <div className="loading-state">
              <Sprite provider="claude" mood="work" size={96} />
              <h2>사무실 문을 열고 있어요</h2>
              <p>이 컴퓨터의 동료들을 만나러 가는 중…</p>
            </div>
          ) : !snapshot ? (
            <div className="empty-state">
              <Sprite provider="codex" size={96} />
              <h2>잠깐, 연결을 확인해 볼까요</h2>
              <p>데스크탑 앱을 실행하거나 로컬 수집기를 시작해 주세요.</p>
              <button className="button primary" onClick={refresh}>
                다시 연결
              </button>
              <button className="button subtle" onClick={() => setDemo(true)}>
                예시 사무실 구경하기
              </button>
            </div>
          ) : view === 'office' ? (
            <OfficeWorkspace
              key={demo ? 'demo' : 'live'}
              snapshot={snapshot}
              onSettings={() => setView('settings')}
              selected={selected}
              onSelect={choose}
              onReturn={returnToOffice}
              onReceipt={onReceipt}
              onNews={(id) => {
                choose(id);
                setShowNews(id + Date.now());
              }}
              onRefresh={refresh}
              refreshing={refreshing}
              demo={demo}
            />
          ) : view === 'memory' ? (
            <Memory
              sessions={sessions}
              onSelect={choose}
              demo={demo}
              privacy={prefs?.privacy ?? false}
            />
          ) : view === 'settings' ? (
            <Settings snapshot={snapshot} onPrefs={onPrefs} onRefresh={refresh} notify={notify} />
          ) : (
            <Activity sessions={sessions} onSelect={choose} privacy={prefs?.privacy ?? false} />
          )}
        </main>
        {current && (
          <Inspector
            session={current}
            sessions={sessions}
            notices={snapshot?.notices ?? []}
            onReceipt={onReceipt}
            onSelect={choose}
            showNews={showNews}
            onClose={() => setSelected(null)}
            onPatch={onPatch}
            onReturn={returnToOffice}
            notify={notify}
            demo={demo}
            privacy={prefs?.privacy ?? false}
          />
        )}
        {inbox && (
          <NewsInbox
            notices={snapshot?.notices ?? []}
            sessions={sessions}
            privacy={prefs?.privacy ?? false}
            onReceipt={onReceipt}
            onClose={() => setInbox(false)}
            onSelect={(id) => {
              choose(id);
              setShowNews(id + Date.now());
            }}
          />
        )}
      </div>
      <footer className="app-footer">
        <div>
          <ShieldCheck size={13} />
          <span>내 컴퓨터 안에서만</span>
          <i />{' '}
          {snapshot?.connectors.map((c) => (
            <button key={c.provider} onClick={() => setView('settings')} title={c.message}>
              <span className={`connector-dot ${c.state}`} />
              {PROVIDERS[c.provider].short}
            </button>
          ))}
        </div>
        <div>
          <span>
            {snapshot?.lastSync ? `${time(snapshot.lastSync)} 마지막 확인` : '연결 확인 중'}
          </span>
          <span className="version">v0.1</span>
          <button
            onClick={() => {
              setDemo(!demo);
              setSelected(null);
            }}
          >
            {demo ? '실제 연결로' : '데모 둘러보기'}
          </button>
        </div>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <span className="live-dot" />
          {toast}
          <button className="icon-btn" aria-label="알림 닫기" onClick={() => setToast('')}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
function Activity({
  sessions,
  onSelect,
  privacy,
}: {
  sessions: Session[];
  onSelect: (id: string) => void;
  privacy: boolean;
}) {
  const events = sessions
    .flatMap((s) => s.events.map((event) => ({ s, event })))
    .sort((a, b) => b.event.at - a.event.at)
    .slice(0, 70);
  return (
    <div className="activity-page">
      <div className="page-intro">
        <span className="eyebrow">THE LITTLE THINGS ADD UP</span>
        <h1>오늘도, 한 걸음씩.</h1>
        <p>동료들이 남긴 최근 발자국이에요. 완료 여부는 업무 카드에서 직접 확인할 수 있어요.</p>
      </div>
      <div className="activity-summary">
        <div>
          <strong>
            {
              sessions.filter(
                (s) => new Date(s.updatedAt).toDateString() === new Date().toDateString(),
              ).length
            }
          </strong>
          <span>오늘 기록이 있는 세션</span>
        </div>
        <div>
          <strong>{sessions.filter((s) => s.notes).length}</strong>
          <span>기억을 남긴 업무</span>
        </div>
        <div>
          <strong>{sessions.filter((s) => s.completed).length}</strong>
          <span>직접 확인한 결과</span>
        </div>
      </div>
      <div className="activity-list">
        {events.map(({ s, event }, i) => (
          <button key={`${s.id}:${event.id}:${i}`} onClick={() => onSelect(s.id)}>
            <time>
              {date(event.at)}
              <b>{time(event.at)}</b>
            </time>
            <div className={`avatar avatar-${s.provider}`}>
              <Sprite provider={s.provider} mood={s.status} size={44} />
            </div>
            <div>
              <span>
                {privacy ? PROVIDERS[s.provider].name : s.alias || s.project}
                <i>·</i>
                {event.kind === 'tool'
                  ? '도구 사용'
                  : event.kind === 'assistant'
                    ? '응답 기록'
                    : event.kind === 'user'
                      ? '요청 기록'
                      : event.kind === 'result'
                        ? '도구 결과'
                        : '작업 흐름'}
              </span>
              <p>{privacy ? '기록 내용 숨김' : event.text}</p>
            </div>
            <ArrowUpRight size={17} />
          </button>
        ))}
      </div>
      {events.length === 0 && (
        <div className="empty-state">
          <Clock3 size={30} />
          <h3>첫 발자국을 기다려요</h3>
        </div>
      )}
    </div>
  );
}
