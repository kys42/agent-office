import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Home,
  BookOpen,
  Clock3,
  Settings2,
  Search,
  PictureInPicture2,
  Eye,
  EyeOff,
  ShieldCheck,
  ArrowUpRight,
  X,
  AlertCircle,
  Sparkles,
  Inbox,
  Armchair,
  Archive,
  Keyboard,
  RotateCw,
  Wind,
  Building2,
  Coffee,
} from 'lucide-react';
import { api, isDesktop } from './lib/api';
import {
  PROVIDERS,
  type Preferences,
  type Session,
  type SessionPatch,
  type ZoneRule,
  type Snapshot,
} from './shared/types';
import { demoSnapshot, reconcileDemo } from './lib/demo';
import { date, time, ago } from './lib/format';
import { Sprite } from './components/Sprite';
import { OfficeWorkspace } from './components/OfficeWorkspace';
import { officeZone, allocateSeats, seatKey, sessionName } from './shared/office';
import { messageExcerpt } from './shared/activity';
import { officeResidents } from './shared/residents';
import { Inspector } from './components/Inspector';
import { ZoneEditor } from './components/ZoneEditor';
import { Memory } from './components/Memory';
import { Settings } from './components/Settings';
import { MiniOffice } from './components/MiniOffice';
import { NewsInbox } from './components/News';
import { applyNoticeReceipt, isAttentionNotice, unreadNoticeCount } from './shared/notices';
import type { NoticeReceipt, OfficeZone } from './shared/types';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { Modal } from './components/Modal';
import { awayDigest, triage, unreadInbox } from './shared/triage';
const tabs = [
  { id: 'office', title: '우리 사무실', short: '사무실', icon: Home },
  { id: 'memory', title: '기억 서랍', short: '기억', icon: BookOpen },
  { id: 'activity', title: '활동 기록', short: '활동', icon: Clock3 },
  { id: 'settings', title: '연결과 설정', short: '설정', icon: Settings2 },
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
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [memoryQuery, setMemoryQuery] = useState('');
  const [zoneRequest, setZoneRequest] = useState<{ zone: OfficeZone; at: number } | null>(null);
  const [areaDrop, setAreaDrop] = useState<{ id: string; zone: string | null } | null>(null);
  const openSearch = () => setPalette(true);
  const closeHelp = useCallback(() => setHelp(false), []);
  const goZone = (zone: OfficeZone) => {
    setView('office');
    setZoneRequest({ zone, at: Date.now() });
  };
  const officeCommand = (what: 'fit' | 'zoom-in' | 'zoom-out') =>
    window.dispatchEvent(new CustomEvent('office:command', { detail: what }));
  // Global keys read the latest render through a ref so the listener is registered once.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  // Remember when the person stepped away; on return, summarise only what arrived since.
  const [away, setAway] = useState<{ from: number; back: number } | null>(null);
  const awayStart = useRef<number | null>(null);
  useEffect(() => {
    const leave = () => {
      if (awayStart.current === null) awayStart.current = Date.now();
    };
    const back = () => {
      const from = awayStart.current;
      awayStart.current = null;
      if (from !== null && Date.now() - from >= 2 * 60_000) setAway({ from, back: Date.now() });
    };
    const visibility = () => (document.hidden ? leave() : back());
    window.addEventListener('blur', leave);
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', leave);
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  useEffect(() => {
    document.body.classList.toggle('mini-mode', mini);
    document.body.classList.toggle('is-desktop', isDesktop);
    return () => document.body.classList.remove('mini-mode');
  }, [mini]);
  const sessions = snapshot?.sessions ?? [];
  const ordered = officeResidents(sessions)
    .sessions.filter((s) => (s.zone || officeZone(s, snapshot?.preferences || {})) === 'office')
    .sort((a, b) => (a.officeSeat ?? 0) - (b.officeSeat ?? 0));
  const current = sessions.find((s) => s.id === selected);
  const prefs = snapshot?.preferences;
  const notices = snapshot?.notices ?? [];
  const unread = unreadNoticeCount(notices);
  useEffect(() => {
    document.title = unread ? `(${unread}) Agent Office` : 'Agent Office · 우리 사무실';
  }, [unread]);
  // Snapshots poll every 5s, so allow a short grace after returning; later news is not "away".
  const digest = away ? awayDigest(notices, away.from, away.back + 15_000) : null;
  const digestEmpty = !digest || digest.results + digest.attention === 0;
  useEffect(() => {
    if (!away || !digestEmpty) return;
    const t = setTimeout(() => setAway(null), Math.max(0, away.back + 15_000 - Date.now()));
    return () => clearTimeout(t);
  }, [away, digestEmpty]);
  const residents = officeResidents(sessions).sessions;
  const ownerOf = (id: string | null) =>
    id ? residents.find((r) => r.id === id || r.resident?.sessionIds.includes(id)) : undefined;
  // Same in-group order as the roster: pinned first, then the saved sort preference.
  const rosterSort = (() => {
    try {
      return JSON.parse(localStorage.getItem(`office:view:${demo ? 'demo' : 'live'}`) || '{}').sort;
    } catch {
      return 'recent';
    }
  })();
  const queue = triage(
    [...ordered].sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (rosterSort === 'frequent' ? (b.openCount || 0) - (a.openCount || 0) : 0) ||
        b.updatedAt - a.updatedAt,
    ),
    notices,
  ).flatMap((g) => g.sessions);
  const openInbox = () => {
    setInbox(true);
    setSelected(null);
  };
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
      return true;
    }
    try {
      setSnapshot(await api.preferences(p));
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    }
  };
  const saveZoneRules = async (zoneRules: ZoneRule[]) => {
    if (await onPrefs({ zoneRules })) notify('사무실 구역을 다시 나눴어요');
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
  const markRead = (id: string) => {
    const s = ownerOf(id);
    const all = s ? unreadInbox(s, notices) : [];
    // Questions stay until explicitly acknowledged ('확인했어요'); R only reads results.
    const list = all.filter((n) => !isAttentionNotice(n));
    if (!list.length)
      return notify(
        all.length
          ? '확인 요청은 업무 카드의 ‘확인했어요’로 처리해 주세요'
          : '이 동료에게 읽지 않은 결과가 없어요',
      );
    void onReceipt(
      list.map(({ id, version }) => ({ id, version })),
      'read',
    );
    notify(`소식 ${list.length}건을 읽음으로 표시했어요`);
  };
  // Keep the order stable during a burst of J/K so reading an item doesn't reshuffle the cursor.
  const navOrder = useRef<{ ids: string[]; at: number }>({ ids: [], at: 0 });
  const step = (delta: number) => {
    if (!queue.length) return;
    const fresh = Date.now() - navOrder.current.at < 90_000;
    const live = new Set(queue.map((s) => s.id));
    const ids = fresh
      ? [
          ...navOrder.current.ids.filter((id) => live.has(id)),
          ...queue.map((s) => s.id).filter((id) => !navOrder.current.ids.includes(id)),
        ]
      : queue.map((s) => s.id);
    const owner = ids.findIndex(
      (id) =>
        id === selected ||
        queue.find((s) => s.id === id)?.resident?.sessionIds.includes(selected ?? ''),
    );
    const next = owner < 0 ? (delta > 0 ? 0 : ids.length - 1) : owner + delta;
    navOrder.current = { ids, at: Date.now() };
    setView('office');
    choose(ids[(next + ids.length) % ids.length]);
  };
  keyHandler.current = (e) => {
    if (mini || !snapshot || e.isComposing) return;
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyK') {
      e.preventDefault();
      setPalette((v) => !v);
      return;
    }
    const field =
      e.target instanceof Element
        ? e.target.closest<HTMLElement>('input, textarea, select, [contenteditable="true"]')
        : null;
    if (e.key === 'Escape') {
      // In a field, Esc leaves the field first; the panels close on the next press.
      if (field) field.blur();
      else {
        setSelected(null);
        setInbox(false);
      }
      return;
    }
    if (field || document.querySelector('[role="dialog"]') || e.metaKey || e.ctrlKey || e.altKey)
      return;
    // Physical keys, so shortcuts also work while the Korean input source is active (J → ㅓ).
    const run = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    const code = e.code;
    // Punctuation keeps its character under the Korean layout; letters do not.
    if (e.key === '?' || (code === 'Slash' && e.shiftKey)) run(() => setHelp(true));
    else if (e.key === '/' || code === 'Slash') run(() => setPalette(true));
    else if (code === 'KeyJ') run(() => step(1));
    else if (code === 'KeyK') run(() => step(-1));
    else if (code === 'KeyI') run(() => (inbox ? setInbox(false) : openInbox()));
    else if (code === 'KeyR' && selected) run(() => markRead(selected));
    else if (view === 'office' && code === 'KeyF') run(() => officeCommand('fit'));
    else if (view === 'office' && (code === 'Equal' || code === 'NumpadAdd'))
      run(() => officeCommand('zoom-in'));
    else if (view === 'office' && (code === 'Minus' || code === 'NumpadSubtract'))
      run(() => officeCommand('zoom-out'));
    else if (['Digit1', 'Digit2', 'Digit3'].includes(code))
      run(() => goZone((['office', 'waiting', 'archive'] as const)[Number(code.slice(-1)) - 1]));
  };
  const actions: PaletteAction[] = [
    {
      id: 'inbox',
      label: '소식함 열기',
      hint: `확인할 소식 ${unread}건`,
      keys: 'I',
      icon: <Inbox size={15} />,
      keywords: '알림 결과 응답',
      run: openInbox,
    },
    {
      id: 'office',
      label: '사무실 보기',
      keys: '1',
      icon: <Building2 size={15} />,
      run: () => goZone('office'),
    },
    {
      id: 'waiting',
      label: '대기 라운지 보기',
      keys: '2',
      icon: <Armchair size={15} />,
      keywords: '쉬는 퇴근',
      run: () => goZone('waiting'),
    },
    {
      id: 'archive',
      label: '보관 공간 보기',
      keys: '3',
      icon: <Archive size={15} />,
      keywords: '오래된',
      run: () => goZone('archive'),
    },
    {
      id: 'memory',
      label: '기억 서랍',
      hint: '모든 도구의 기록 검색',
      icon: <BookOpen size={15} />,
      run: () => setView('memory'),
    },
    {
      id: 'activity',
      label: '활동 기록',
      icon: <Clock3 size={15} />,
      keywords: '타임라인',
      run: () => setView('activity'),
    },
    {
      id: 'settings',
      label: '연결과 설정',
      icon: <Settings2 size={15} />,
      keywords: '퇴근 보관 수집 연결',
      run: () => setView('settings'),
    },
    {
      id: 'privacy',
      label: prefs?.privacy ? '화면 내용 다시 보기' : '화면 내용 숨기기',
      hint: '화면 공유할 때',
      icon: prefs?.privacy ? <Eye size={15} /> : <EyeOff size={15} />,
      keywords: '개인정보 프라이버시',
      run: () => onPrefs({ privacy: !prefs?.privacy }),
    },
    {
      id: 'motion',
      label: prefs?.reducedMotion ? '움직임 다시 켜기' : '움직임 줄이기',
      icon: <Wind size={15} />,
      keywords: '애니메이션',
      run: () => onPrefs({ reducedMotion: !prefs?.reducedMotion }),
    },
    {
      id: 'refresh',
      label: '지금 다시 확인',
      hint: '로컬 기록을 바로 읽어요',
      icon: <RotateCw size={15} />,
      keywords: '새로고침',
      run: refresh,
    },
    {
      id: 'mini',
      label: '미니 오피스로 전환',
      icon: <PictureInPicture2 size={15} />,
      run: () => api.window('mini'),
    },
    {
      id: 'keys',
      label: '키보드 단축키',
      keys: '?',
      icon: <Keyboard size={15} />,
      run: () => setHelp(true),
    },
  ];
  if (mini)
    return (
      <MiniOffice
        sessions={ordered}
        notices={snapshot?.notices ?? []}
        privacy={prefs?.privacy ?? false}
        reducedMotion={prefs?.reducedMotion ?? false}
      />
    );
  const docked = !!current || inbox;
  return (
    <div
      className={`app ${prefs?.reducedMotion ? 'reduce-motion' : ''} ${docked ? 'has-dock' : ''} ${prefs?.privacy ? 'is-private' : ''}`}
    >
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
          <b>Agent Office</b>
          {demo && <span className="brand-tag">DEMO</span>}
        </div>
        <button className="global-search" onClick={openSearch}>
          <Search size={15} />
          <span>동료, 기록, 명령 찾기</span>
          <kbd>⌘K</kbd>
        </button>
        <div className="header-actions">
          <button
            className={`inbox-button ${inbox ? 'active' : ''} ${unread ? 'has-unread' : ''}`}
            aria-label="소식함 열기"
            title="동료가 남긴 최종 응답과 확인 요청"
            onClick={() => {
              setInbox((v) => !v);
              setSelected(null);
            }}
          >
            <Inbox size={16} />
            <span>소식함</span>
            <b>{unread}</b>
          </button>
          <button
            className={`icon-btn ${prefs?.privacy ? 'is-on' : ''}`}
            aria-label={prefs?.privacy ? '내용 다시 보기' : '화면 내용 숨기기'}
            title={prefs?.privacy ? '내용 다시 보기' : '화면 내용 숨기기 · 화면 공유할 때'}
            onClick={() => onPrefs({ privacy: !prefs?.privacy })}
          >
            {prefs?.privacy ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
          <button
            className="icon-btn mini-button"
            aria-label="미니 오피스"
            title="미니 오피스 · 화면 아래에 작게 띄우기"
            onClick={() => api.window('mini')}
          >
            <PictureInPicture2 size={17} />
          </button>
        </div>
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
                  if (t.id === 'memory') setMemoryQuery('');
                }}
              >
                <t.icon size={19} strokeWidth={1.8} />
                <span>{t.short}</span>
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
              <Settings2 size={19} strokeWidth={1.8} />
              <span>설정</span>
            </button>
          </div>
        </nav>
        <main className={`main-content view-${view}`}>
          {demo && (
            <div className="demo-banner">
              <Sparkles size={14} />
              <span>구경하는 사무실 · 모든 기록은 예시 데이터예요</span>
              <button
                onClick={() => {
                  setDemo(false);
                  setSelected(null);
                  history.replaceState(null, '', location.pathname);
                }}
              >
                실제 동료 만나기 <ArrowUpRight size={13} />
              </button>
            </div>
          )}
          {error && (
            <div className="error-banner">
              <AlertCircle size={16} />
              <span>{error}</span>
              <button onClick={refresh}>다시 연결</button>
            </div>
          )}
          {digest && digest.results + digest.attention > 0 && (
            <div className="away-banner" role="status">
              <Coffee size={15} />
              <span>
                <b>
                  자리 비운 {Math.max(1, Math.round((away!.back - away!.from) / 60_000))}분 동안
                </b>
                {digest.attention > 0 && (
                  <em className="tone-attention">확인 필요 {digest.attention}건</em>
                )}
                {digest.results > 0 && <em className="tone-result">새 결과 {digest.results}건</em>}
              </span>
              <button
                onClick={() => {
                  setAway(null);
                  if (digest.sessionIds.length === 1) {
                    setView('office');
                    choose(digest.sessionIds[0]);
                  } else openInbox();
                }}
              >
                {digest.sessionIds.length === 1 ? '바로 보기' : '소식함에서 보기'}
              </button>
              <button className="icon-btn" aria-label="요약 닫기" onClick={() => setAway(null)}>
                <X size={14} />
              </button>
            </div>
          )}
          {!snapshot && !error ? (
            <div className="loading-state">
              <div className="loading-pet">
                <Sprite provider="claude" mood="work" size={96} />
              </div>
              <h2>사무실 문을 열고 있어요</h2>
              <p>이 컴퓨터의 동료들을 만나러 가는 중…</p>
            </div>
          ) : !snapshot ? (
            <div className="empty-state">
              <Sprite provider="codex" mood="error" size={96} />
              <h2>잠깐, 연결을 확인해 볼까요</h2>
              <p>데스크탑 앱을 실행하거나 로컬 수집기를 시작해 주세요.</p>
              <div className="empty-actions">
                <button className="button primary" onClick={refresh}>
                  다시 연결
                </button>
                <button className="button subtle" onClick={() => setDemo(true)}>
                  예시 사무실 구경하기
                </button>
              </div>
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
              unread={unread}
              onInbox={openInbox}
              zoneRequest={zoneRequest}
              onZoneHandled={() => setZoneRequest(null)}
              onZoneDrop={(id, zone) => setAreaDrop({ id, zone })}
            />
          ) : view === 'memory' ? (
            <Memory
              key={memoryQuery}
              initialQuery={memoryQuery}
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
            memberIds={ownerOf(current.id)?.resident?.sessionIds ?? [current.id]}
            onReceipt={onReceipt}
            onSelect={choose}
            showNews={showNews}
            onClose={() => setSelected(null)}
            onPatch={onPatch}
            onReturn={returnToOffice}
            notify={notify}
            demo={demo}
            privacy={prefs?.privacy ?? false}
            zoneRules={prefs?.zoneRules ?? []}
            onZoneRules={saveZoneRules}
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
          <span className="footer-local">
            <ShieldCheck size={12} />이 컴퓨터 안에서만
          </span>
          {snapshot?.connectors.map((c) => (
            <button
              key={c.provider}
              onClick={() => setView('settings')}
              title={`${PROVIDERS[c.provider].name} · ${c.message}`}
            >
              <span className={`connector-dot ${c.state}`} />
              {PROVIDERS[c.provider].short}
              <em>{c.state === 'connected' ? c.count : '—'}</em>
            </button>
          ))}
        </div>
        <div>
          <span className={`sync-state ${prefs?.paused ? 'paused' : ''}`}>
            <i />
            {prefs?.paused
              ? '수집 쉬는 중'
              : snapshot?.lastSync
                ? `${time(snapshot.lastSync)} 확인 · 5초마다`
                : '연결 확인 중'}
          </span>
          <button className="footer-keys" onClick={() => setHelp(true)} title="키보드 단축키">
            <kbd>⌘K</kbd> 찾기 <kbd>?</kbd> 단축키
          </button>
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
      {palette && snapshot && (
        <CommandPalette
          sessions={officeResidents(sessions).sessions}
          notices={notices}
          actions={actions}
          demo={demo}
          privacy={prefs?.privacy ?? false}
          onClose={() => setPalette(false)}
          onSelect={(id) => {
            setView('office');
            choose(id);
          }}
          onDeepSearch={(q) => {
            setMemoryQuery(q);
            setView('memory');
          }}
        />
      )}
      {areaDrop &&
        (() => {
          const moving = sessions.find((s) => s.id === areaDrop.id);
          return moving ? (
            <Modal title="사무실 구역 옮기기" onClose={() => setAreaDrop(null)}>
              <ZoneEditor
                session={moving}
                sessions={sessions}
                rules={prefs?.zoneRules ?? []}
                onRules={saveZoneRules}
                onClose={() => setAreaDrop(null)}
                initialZone={areaDrop.zone}
              />
            </Modal>
          ) : null;
        })()}
      {help && (
        <Modal title="키보드 단축키" onClose={closeHelp}>
          <div className="shortcut-grid">
            {[
              ['찾기', [['⌘', 'K'], ['/']], '동료·기록·명령을 한곳에서'],
              ['다음 할 일', [['J']], '기다리는 동료 → 새 결과 → 작업 중 순서'],
              ['이전 할 일', [['K']], ''],
              ['읽음으로 표시', [['R']], '선택한 동료의 미확인 소식'],
              ['소식함', [['I']], '열기 / 닫기'],
              ['사무실 · 라운지 · 보관', [['1'], ['2'], ['3']], ''],
              ['전체 보기 · 확대 · 축소', [['F'], ['+'], ['−']], '사무실에서'],
              ['닫기', [['Esc']], '업무 카드 · 소식함 · 창'],
            ].map(([label, combos, hint]) => (
              <div key={label as string}>
                <span>
                  <b>{label as string}</b>
                  {hint && <small>{hint as string}</small>}
                </span>
                <span className="shortcut-keys">
                  {(combos as string[][]).map((combo, i) => (
                    <span key={i}>
                      {combo.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
          <p className="shortcut-note">입력 중에는 한 글자 단축키가 동작하지 않아요.</p>
        </Modal>
      )}
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
const KIND_LABEL: Record<string, string> = {
  tool: '도구 사용',
  assistant: '응답',
  user: '요청',
  result: '도구 결과',
  lifecycle: '작업 흐름',
};
function Activity({
  sessions,
  onSelect,
  privacy,
}: {
  sessions: Session[];
  onSelect: (id: string) => void;
  privacy: boolean;
}) {
  const [kind, setKind] = useState<'talk' | 'all'>('talk');
  const events = sessions
    .flatMap((s) => s.events.map((event) => ({ s, event })))
    .filter(({ event }) => kind === 'all' || ['user', 'assistant'].includes(event.kind))
    .sort((a, b) => b.event.at - a.event.at)
    .slice(0, 90);
  const days = new Map<string, typeof events>();
  for (const item of events) {
    const key = date(item.event.at);
    days.set(key, [...(days.get(key) ?? []), item]);
  }
  const today = new Date().toDateString();
  const touched = sessions.filter((s) => new Date(s.updatedAt).toDateString() === today);
  return (
    <div className="activity-page page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Activity</span>
          <h1>활동 기록</h1>
          <p>동료들이 남긴 최근 발자국. 완료 여부는 업무 카드에서 직접 확인해요.</p>
        </div>
        <div className="segmented" role="group" aria-label="기록 종류">
          <button aria-pressed={kind === 'talk'} onClick={() => setKind('talk')}>
            대화만
          </button>
          <button aria-pressed={kind === 'all'} onClick={() => setKind('all')}>
            도구 포함
          </button>
        </div>
      </header>
      <div className="activity-summary">
        <div>
          <span>오늘 움직인 세션</span>
          <strong>{touched.length}</strong>
          <div className="activity-faces">
            {touched.slice(0, 6).map((s) => (
              <span key={s.id} className={`face face-${s.provider}`}>
                <Sprite provider={s.provider} mood="idle" size={26} />
              </span>
            ))}
          </div>
        </div>
        <div>
          <span>기억을 남긴 업무</span>
          <strong>{sessions.filter((s) => s.notes).length}</strong>
          <small>메모는 인수인계에 함께 담겨요</small>
        </div>
        <div>
          <span>직접 확인한 결과</span>
          <strong>{sessions.filter((s) => s.completed).length}</strong>
          <small>응답 완료와 별개로 내가 남긴 확인</small>
        </div>
      </div>
      <div className="activity-list">
        {[...days].map(([day, items]) => (
          <section key={day} className="activity-day">
            <h2>
              {day}
              <span>{items.length}개</span>
            </h2>
            <ol>
              {items.map(({ s, event }, i) => (
                <li key={`${s.id}:${event.id}:${i}`}>
                  <button
                    onClick={() => onSelect(s.id)}
                    className={`activity-row kind-${event.kind}`}
                  >
                    <time>{time(event.at)}</time>
                    <span className={`face face-${s.provider}`}>
                      <Sprite provider={s.provider} mood={s.status} size={32} />
                    </span>
                    <div>
                      <span className="activity-meta">
                        <b>{privacy ? PROVIDERS[s.provider].name : sessionName(s)}</b>
                        <i className={`kind-chip kind-${event.kind}`}>
                          {event.kind === 'assistant' && event.phase === 'final'
                            ? '최종 응답'
                            : KIND_LABEL[event.kind]}
                        </i>
                        {!privacy && <small>{s.project}</small>}
                      </span>
                      <p>{privacy ? '기록 내용 숨김' : messageExcerpt(event.text, 280)}</p>
                    </div>
                    <span className="activity-ago">{ago(event.at)}</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
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
