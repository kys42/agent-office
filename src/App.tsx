import { OfficeGuide, type GuideAction } from './components/OfficeGuide';
import { hasSeenOnboarding, rememberOnboarding } from './lib/onboarding';
import { PetAppearanceContext } from './components/PetAppearanceContext';
import { UsagePanel } from './components/UsagePanel';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Gauge,
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
  HelpCircle,
} from 'lucide-react';
import { api, isDesktop } from './lib/api';
import { PROVIDERS, type Session, type ZoneRule } from './shared/types';
import { useOffice } from './lib/useOffice';
import { useTerminalSend } from './lib/useTerminalSend';
import { date, time, ago } from './lib/format';
import { Sprite } from './components/Sprite';
import { OfficeWorkspace } from './components/OfficeWorkspace';
import { projectKey, sessionName } from './shared/office';
import { projectColor } from './shared/office-layout';
import { messageExcerpt } from './shared/activity';
import { Inspector } from './components/Inspector';
import { ZoneEditor } from './components/ZoneEditor';
import { Memory } from './components/Memory';
import { Settings, type SettingsSection } from './components/Settings';
import { NewsInbox } from './components/News';
import { isAttentionNotice } from './shared/notices';
import type { OfficeZone } from './shared/types';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { Modal } from './components/Modal';
import { awayDigest, triage, unreadInbox } from './shared/triage';
import { useI18n } from './lib/i18n';
import { NoticePagingContext } from './lib/notice-paging';
// Labels live in the `app.tabs` catalog so they follow a language switch.
const tabs = [
  { id: 'office', icon: Home },
  { id: 'memory', icon: BookOpen },
  { id: 'activity', icon: Clock3 },
  { id: 'settings', icon: Settings2 },
] as const;
export default function App() {
  const { locale, t } = useI18n();
  const [demo, setDemo] = useState(new URLSearchParams(location.search).has('demo'));
  const [guide, setGuide] = useState<'tour' | 'features' | null>(() =>
    new URLSearchParams(location.search).has('onboarding') || (!demo && !hasSeenOnboarding(false))
      ? 'tour'
      : null,
  );
  const closeGuide = useCallback(() => {
    rememberOnboarding(demo);
    setGuide(null);
  }, [demo]);
  useEffect(() => {
    // A sample-office visit never consumes the first tour of the live office.
    if (!demo && !hasSeenOnboarding(false)) setGuide('tour');
  }, [demo]);
  const [inbox, setInbox] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
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
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4200);
  }, []);
  const {
    snapshot,
    error,
    refreshing,
    model,
    refresh,
    setPrefs: onPrefs,
    patch: onPatch,
    pin,
    receipt: onReceipt,
    readAll,
    visit,
    veil,
    returnToOffice,
  } = useOffice(demo, notify);
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
  const [settingsFocus, setSettingsFocus] = useState<{ section: SettingsSection; at: number }>();
  const clearSettingsFocus = useCallback(() => setSettingsFocus(undefined), []);
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
    document.body.classList.toggle('is-desktop', isDesktop);
  }, []);
  const sessions = snapshot?.sessions ?? [];
  // J/K walks what the office shows: hidden colleagues stay out until they talk again.
  const ordered = model.scene;
  const current = sessions.find((s) => s.id === selected);
  const prefs = snapshot?.preferences;
  const notices = snapshot?.notices ?? [];
  const unread = model.unread;
  useEffect(() => {
    document.title = unread ? t.app.docTitleUnread(unread) : t.app.docTitle;
  }, [unread, locale]);
  // Snapshots poll every 5s, so allow a short grace after returning; later news is not "away".
  const digest = away ? awayDigest(notices, away.from, away.back + 15_000) : null;
  const digestEmpty = !digest || digest.results + digest.attention === 0;
  useEffect(() => {
    if (!away || !digestEmpty) return;
    const timer = setTimeout(() => setAway(null), Math.max(0, away.back + 15_000 - Date.now()));
    return () => clearTimeout(timer);
  }, [away, digestEmpty]);
  const ownerOf = (id: string | null) => (id ? model.ownerOf(id) : undefined);
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
  const todo = triage(ordered, notices).filter(
    (g): g is typeof g & { group: 'attention' | 'results' | 'working' } =>
      g.group === 'attention' || g.group === 'results' || g.group === 'working',
  );
  const projectList = [
    ...ordered
      .filter((s) => !s.attachedTo)
      .reduce((map, s) => {
        const key = projectKey(s);
        const item = map.get(key) ?? { key, name: s.area?.name ?? s.project, count: 0 };
        item.count += 1;
        return map.set(key, item);
      }, new Map<string, { key: string; name: string; count: number }>())
      .values(),
  ];
  // The office remembers its zone per data source; the sidebar mirrors it.
  const [officeZoneNow, setOfficeZoneNow] = useState<OfficeZone>('office');
  useEffect(() => {
    const onZone = (e: Event) => setOfficeZoneNow((e as CustomEvent<OfficeZone>).detail);
    window.addEventListener('office:zone', onZone);
    return () => window.removeEventListener('office:zone', onZone);
  }, []);
  const openInbox = () => {
    setShowUsage(false);
    setInbox(true);
    setSelected(null);
  };
  // Desktop-only Send to terminal setting and the quick-reply send, shared with the dock card.
  const {
    enabled: terminalSend,
    available: terminalSendAvailable,
    toggle: toggleTerminalSend,
    sendReply,
  } = useTerminalSend(demo, notify);
  // The desk pin and the card pin are one switch on the colleague.
  const onPin = (s: Session) =>
    void pin(s)
      .then((on) => notify(on ? t.app.toast.pinned : t.app.toast.unpinned))
      .catch((e) => notify((e as Error).message));
  const saveZoneRules = async (zoneRules: ZoneRule[]) => {
    if (await onPrefs({ zoneRules })) notify(t.app.toast.zonesSaved);
  };
  const choose = (id: string) => {
    setShowUsage(false);
    setInbox(false);
    setShowNews(null);
    setSelected(id);
    visit(id);
  };
  const markRead = (id: string) => {
    const s = ownerOf(id);
    const all = s ? unreadInbox(s, notices) : [];
    // Questions stay until explicitly acknowledged ('확인했어요'); R only reads results.
    const list = all.filter((n) => !isAttentionNotice(n));
    if (!list.length) return notify(all.length ? t.app.toast.attentionOnly : t.app.toast.noUnread);
    void onReceipt(
      list.map(({ id, version }) => ({ id, version })),
      'read',
    );
    notify(t.app.toast.markedRead(list.length));
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
    if (!snapshot || guide || e.isComposing || e.defaultPrevented) return;
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
  const guideAction = (action: GuideAction) => {
    closeGuide();
    setSelected(null);
    setInbox(false);
    setShowUsage(false);
    if (action === 'inbox') openInbox();
    else if (action === 'usage') setShowUsage(true);
    else if (action === 'card') {
      setView('office');
      if (model.scene[0]) choose(model.scene[0].id);
    } else if (action === 'pet') void api.window('mini');
    else if (action === 'memory' || action === 'activity') {
      if (action === 'memory') setMemoryQuery('');
      setView(action);
    } else if (action === 'keys') setHelp(true);
    else if (action === 'office' || action === 'demo') {
      setView('office');
      if (action === 'demo') setDemo(true);
    } else {
      const section: SettingsSection =
        action === 'appearance'
          ? 'appearance'
          : action === 'space'
            ? 'office'
            : action === 'privacy' || action === 'terminal'
              ? 'rhythm'
              : 'connections';
      setSettingsFocus({ section, at: Date.now() });
      setView('settings');
    }
  };
  const actions: PaletteAction[] = [
    {
      id: 'guide',
      label: t.guide.title,
      keywords: `${t.guide.tour} ${t.guide.features} onboarding help`,
      icon: <BookOpen size={15} />,
      run: () => setGuide('features'),
    },
    {
      id: 'inbox',
      label: t.palette.actions.inbox,
      hint: t.palette.actions.inboxHint(unread),
      keys: 'I',
      icon: <Inbox size={15} />,
      keywords: t.palette.actions.inboxKeywords,
      run: openInbox,
    },
    {
      id: 'office',
      label: t.palette.actions.office,
      keys: '1',
      icon: <Building2 size={15} />,
      run: () => goZone('office'),
    },
    {
      id: 'waiting',
      label: t.palette.actions.lounge,
      keys: '2',
      icon: <Armchair size={15} />,
      keywords: t.palette.actions.loungeKeywords,
      run: () => goZone('waiting'),
    },
    {
      id: 'archive',
      label: t.palette.actions.archive,
      keys: '3',
      icon: <Archive size={15} />,
      keywords: t.palette.actions.archiveKeywords,
      run: () => goZone('archive'),
    },
    {
      id: 'memory',
      label: t.palette.actions.memory,
      hint: t.palette.actions.memoryHint,
      icon: <BookOpen size={15} />,
      run: () => setView('memory'),
    },
    {
      id: 'activity',
      label: t.palette.actions.activity,
      icon: <Clock3 size={15} />,
      keywords: t.palette.actions.activityKeywords,
      run: () => setView('activity'),
    },
    {
      id: 'settings',
      label: t.palette.actions.settings,
      icon: <Settings2 size={15} />,
      keywords: t.palette.actions.settingsKeywords,
      run: () => setView('settings'),
    },
    {
      id: 'privacy',
      label: prefs?.privacy ? t.palette.actions.showContent : t.palette.actions.hideContent,
      hint: t.palette.actions.privacyHint,
      icon: prefs?.privacy ? <Eye size={15} /> : <EyeOff size={15} />,
      keywords: t.palette.actions.privacyKeywords,
      run: () => onPrefs({ privacy: !prefs?.privacy }),
    },
    {
      id: 'motion',
      label: prefs?.reducedMotion ? t.palette.actions.motionOn : t.palette.actions.motionOff,
      icon: <Wind size={15} />,
      keywords: t.palette.actions.motionKeywords,
      run: () => onPrefs({ reducedMotion: !prefs?.reducedMotion }),
    },
    {
      id: 'refresh',
      label: t.palette.actions.refresh,
      hint: t.palette.actions.refreshHint,
      icon: <RotateCw size={15} />,
      keywords: t.palette.actions.refreshKeywords,
      run: refresh,
    },
    {
      id: 'mini',
      label: t.palette.actions.mini,
      hint: t.palette.actions.miniHint,
      keywords: t.palette.actions.miniKeywords,
      icon: <PictureInPicture2 size={15} />,
      run: () => api.window('mini'),
    },
    {
      id: 'keys',
      label: t.palette.actions.keys,
      keys: '?',
      icon: <Keyboard size={15} />,
      run: () => setHelp(true),
    },
  ];
  const docked = !!current || inbox || showUsage;
  const content = (
    <div
      className={`app ${prefs?.reducedMotion ? 'reduce-motion' : ''} ${docked ? 'has-dock' : ''} ${prefs?.privacy ? 'is-private' : ''}`}
    >
      <aside className="sidebar" aria-label={t.app.mainMenu}>
        <div className="sidebar-top">
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
        </div>
        <nav className="source-list">
          <div className="source-group">
            <h6>{t.app.sidebar.spaces}</h6>
            {(
              [
                ['office', Building2, 'office'],
                ['waiting', Armchair, null],
                ['archive', Archive, null],
              ] as const
            ).map(([zone, Icon, tab]) => (
              <button
                key={zone}
                className={`source-item ${view === 'office' && officeZoneNow === zone ? 'active' : ''}`}
                aria-label={tab ? t.app.tabs.office.title : undefined}
                title={tab ? t.app.tabs.office.title : undefined}
                onClick={() => {
                  setSelected(null);
                  goZone(zone);
                }}
              >
                <span className={`source-icon icon-${zone}`}>
                  <Icon size={13} strokeWidth={2.2} />
                </span>
                <span className="source-label">{t.office.zones[zone]}</span>
                <em>{model.zones[zone].length}</em>
              </button>
            ))}
          </div>
          <div className="source-group">
            <h6>{t.app.sidebar.todo}</h6>
            {todo.map(({ group, sessions: members }) => (
              <button
                key={group}
                className="source-item"
                disabled={!members.length}
                onClick={() => {
                  setView('office');
                  if (members[0]) choose(members[0].id);
                }}
              >
                <span className={`source-dot dot-${group}`} />
                <span className="source-label">{t.roster.tiles[group]}</span>
                <em className={group === 'attention' && members.length ? 'hot' : ''}>
                  {members.length}
                </em>
              </button>
            ))}
          </div>
          {projectList.length > 0 && (
            <div className="source-group">
              <h6>{t.app.sidebar.projects}</h6>
              {projectList.map((p) => (
                <button
                  key={p.key}
                  className="source-item"
                  title={prefs?.privacy ? undefined : p.name}
                  onClick={() => {
                    setSelected(null);
                    goZone('office');
                    window.dispatchEvent(
                      new CustomEvent('office:filter', { detail: prefs?.privacy ? '' : p.name }),
                    );
                  }}
                >
                  <span className="source-dot" style={{ background: projectColor(p.key) }} />
                  <span className="source-label">
                    {prefs?.privacy ? t.app.sidebar.hiddenProject : p.name}
                  </span>
                  <em>{p.count}</em>
                </button>
              ))}
            </div>
          )}
          <div className="source-group">
            <h6>{t.app.sidebar.records}</h6>
            {(['memory', 'activity'] as const).map((id) => {
              const tab = tabs.find((x) => x.id === id)!;
              return (
                <button
                  key={id}
                  className={`source-item ${view === id ? 'active' : ''}`}
                  aria-label={t.app.tabs[id].title}
                  title={t.app.tabs[id].title}
                  onClick={() => {
                    setView(id);
                    setSelected(null);
                    if (id === 'memory') setMemoryQuery('');
                  }}
                >
                  <span className={`source-icon icon-${id}`}>
                    <tab.icon size={13} strokeWidth={2.2} />
                  </span>
                  <span className="source-label">{t.app.tabs[id].title}</span>
                </button>
              );
            })}
          </div>
        </nav>
        <div className="sidebar-foot app-footer">
          <div className="foot-connectors">
            {snapshot?.connectors.map((c) => (
              <button
                key={c.provider}
                onClick={() => setView('settings')}
                title={`${PROVIDERS[c.provider].name} · ${c.message}`}
              >
                <span className={`connector-dot ${c.state}`} />
                {PROVIDERS[c.provider].short}
              </button>
            ))}
          </div>
          <span className={`sync-state ${prefs?.paused ? 'paused' : ''}`}>
            <ShieldCheck size={11} />
            {prefs?.paused
              ? t.app.footer.paused
              : snapshot?.lastSync
                ? t.app.footer.synced(time(snapshot.lastSync))
                : t.app.footer.connecting}
          </span>
          <div className="foot-actions">
            <button
              className={`source-item ${view === 'settings' ? 'active' : ''}`}
              aria-label={t.app.tabs.settings.title}
              title={t.app.tabs.settings.title}
              onClick={() => {
                setView('settings');
                setSelected(null);
              }}
            >
              <span className="source-icon icon-settings">
                <Settings2 size={13} strokeWidth={2.2} />
              </span>
              <span className="source-label">{t.app.tabs.settings.short}</span>
            </button>
            <button
              className="icon-btn"
              aria-label={t.guide.title}
              title={t.guide.title}
              onClick={() => setGuide('features')}
            >
              <HelpCircle size={15} />
            </button>
            <button className="icon-btn" title={t.app.help.title} onClick={() => setHelp(true)}>
              <Keyboard size={15} />
            </button>
          </div>
          <button
            className="foot-demo"
            onClick={() => {
              setDemo(!demo);
              setSelected(null);
            }}
          >
            {demo ? t.app.footer.toLive : t.app.footer.toDemo}
          </button>
        </div>
      </aside>
      <div className="app-body">
        <main className={`main-content view-${view}`}>
          <header className="toolbar app-header">
            <div className="toolbar-title">
              <h1>{view === 'office' ? t.office.zones[officeZoneNow] : t.app.tabs[view].title}</h1>
              <small>
                {view === 'office' && officeZoneNow !== 'office'
                  ? t.app.toolbar.zoneCount(model.zones[officeZoneNow].length)
                  : view === 'office'
                    ? t.app.toolbar.officeSubtitle(
                        projectList.length,
                        model.scene.filter((s) => !s.attachedTo).length,
                      )
                    : snapshot?.lastSync
                      ? t.app.footer.synced(time(snapshot.lastSync))
                      : t.app.footer.connecting}
              </small>
            </div>
            <div className="toolbar-slot" id="toolbar-slot" />
            <div className="toolbar-spacer" />
            <button
              className="global-search"
              onClick={openSearch}
              aria-label={t.palette.search}
              title={`${t.palette.search} · ⌘K`}
            >
              <Search size={13} />
              <span>{t.palette.search}</span>
              <kbd>⌘K</kbd>
            </button>
            <div className="header-actions">
              <button
                className={`icon-btn inbox-button ${inbox ? 'active is-on' : ''} ${unread ? 'has-unread' : ''}`}
                aria-label={t.app.header.openInbox}
                title={t.app.header.inboxTitle}
                onClick={() => {
                  setShowUsage(false);
                  setInbox((v) => !v);
                  setSelected(null);
                }}
              >
                <Inbox size={16} />
                <b>{unread}</b>
              </button>
              <button
                className={`icon-btn usage-button ${showUsage ? 'is-on' : ''}`}
                aria-label={t.app.header.openUsage}
                title={t.app.header.usageTitle}
                onClick={() => {
                  setShowUsage((v) => !v);
                  setInbox(false);
                  setSelected(null);
                }}
              >
                <Gauge size={16} />
              </button>
              <button
                className={`icon-btn ${prefs?.privacy ? 'is-on' : ''}`}
                aria-label={prefs?.privacy ? t.app.header.showContent : t.app.header.hideContent}
                title={prefs?.privacy ? t.app.header.showContent : t.app.header.hideContentTitle}
                onClick={() => onPrefs({ privacy: !prefs?.privacy })}
              >
                {prefs?.privacy ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
              <button
                className="icon-btn mini-button"
                aria-label={t.app.header.mini}
                title={t.app.header.miniTitle}
                onClick={() => api.window('mini')}
              >
                <PictureInPicture2 size={16} />
              </button>
            </div>
          </header>
          {demo && (
            <div className="demo-banner">
              <Sparkles size={14} />
              <span>{t.app.demoBanner.text}</span>
              <button
                onClick={() => {
                  setDemo(false);
                  setSelected(null);
                  history.replaceState(null, '', location.pathname);
                }}
              >
                {t.app.demoBanner.exit} <ArrowUpRight size={13} />
              </button>
            </div>
          )}
          {error && (
            <div className="error-banner">
              <AlertCircle size={16} />
              <span>{error}</span>
              <button onClick={refresh}>{t.app.reconnect}</button>
            </div>
          )}
          {digest && digest.results + digest.attention > 0 && (
            <div className="away-banner" role="status">
              <Coffee size={15} />
              <span>
                <b>
                  {t.app.away.title(Math.max(1, Math.round((away!.back - away!.from) / 60_000)))}
                </b>
                {digest.attention > 0 && (
                  <em className="tone-attention">{t.app.away.attention(digest.attention)}</em>
                )}
                {digest.results > 0 && (
                  <em className="tone-result">{t.app.away.results(digest.results)}</em>
                )}
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
                {digest.sessionIds.length === 1 ? t.app.away.viewOne : t.app.away.viewInbox}
              </button>
              <button
                className="icon-btn"
                aria-label={t.app.away.close}
                onClick={() => setAway(null)}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {!snapshot && !error ? (
            <div className="loading-state">
              <div className="loading-pet">
                <Sprite provider="claude" mood="work" size={96} />
              </div>
              <h2>{t.app.loading.title}</h2>
              <p>{t.app.loading.body}</p>
            </div>
          ) : !snapshot ? (
            <div className="empty-state">
              <Sprite provider="codex" mood="error" size={96} />
              <h2>{t.app.offline.title}</h2>
              <p>{t.app.offline.body}</p>
              <div className="empty-actions">
                <button className="button primary" onClick={refresh}>
                  {t.app.reconnect}
                </button>
                <button className="button subtle" onClick={() => setDemo(true)}>
                  {t.app.offline.tour}
                </button>
              </div>
            </div>
          ) : view === 'office' ? (
            <OfficeWorkspace
              key={demo ? 'demo' : 'live'}
              snapshot={snapshot}
              model={model}
              onVeil={(ids, on) => {
                void veil(ids, on);
                notify(on ? t.app.toast.hidden : t.app.toast.shown);
              }}
              onPin={onPin}
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
              onReply={sendReply}
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
            <Settings
              snapshot={snapshot}
              onPrefs={onPrefs}
              onRefresh={refresh}
              notify={notify}
              terminalSend={terminalSendAvailable ? terminalSend : undefined}
              onTerminalSend={toggleTerminalSend}
              focusSection={settingsFocus}
              onSectionFocused={clearSettingsFocus}
            />
          ) : (
            <Activity sessions={sessions} onSelect={choose} privacy={prefs?.privacy ?? false} />
          )}
        </main>
        {current && (
          <Inspector
            onPrefs={onPrefs}
            session={current}
            sessions={sessions}
            notices={snapshot?.notices ?? []}
            memberIds={ownerOf(current.id)?.resident?.sessionIds ?? [current.id]}
            resident={ownerOf(current.id)}
            onReceipt={onReceipt}
            onSelect={choose}
            showNews={showNews}
            onClose={() => setSelected(null)}
            onPatch={onPatch}
            onPin={onPin}
            onReturn={returnToOffice}
            notify={notify}
            demo={demo}
            privacy={prefs?.privacy ?? false}
            zoneRules={prefs?.zoneRules ?? []}
            onZoneRules={saveZoneRules}
            terminalSend={terminalSend}
          />
        )}
        {showUsage && (
          <UsagePanel
            demo={demo}
            privacy={prefs?.privacy ?? false}
            onClose={() => setShowUsage(false)}
          />
        )}
        {inbox && (
          <NewsInbox
            notices={snapshot?.notices ?? []}
            unread={unread}
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
      {palette && snapshot && (
        <CommandPalette
          sessions={model.residents}
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
            <Modal title={t.app.moveZone} onClose={() => setAreaDrop(null)}>
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
      {guide && (
        <OfficeGuide
          initialMode={guide}
          snapshot={snapshot}
          demo={demo}
          desktop={isDesktop}
          hasColleague={model.scene.length > 0}
          onAction={guideAction}
          onClose={closeGuide}
        />
      )}
      {help && (
        <Modal title={t.app.help.title} onClose={closeHelp}>
          <div className="shortcut-grid">
            {(
              [
                ['find', [['⌘', 'K'], ['/']]],
                ['next', [['J']]],
                ['previous', [['K']]],
                ['markRead', [['R']]],
                ['inbox', [['I']]],
                ['zones', [['1'], ['2'], ['3']]],
                ['zoom', [['F'], ['+'], ['−']]],
                ['close', [['Esc']]],
              ] as const
            ).map(([id, combos]) => (
              <div key={id}>
                <span>
                  <b>{t.app.help[id].label}</b>
                  {t.app.help[id].hint && <small>{t.app.help[id].hint}</small>}
                </span>
                <span className="shortcut-keys">
                  {combos.map((combo, i) => (
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
          <p className="shortcut-note">{t.app.help.note}</p>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <span className="live-dot" />
          {toast}
          <button
            className="icon-btn"
            aria-label={t.app.toast.dismiss}
            onClick={() => setToast('')}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <PetAppearanceContext.Provider value={prefs?.petAppearance}>
      <NoticePagingContext.Provider
        value={{
          paged: model.noticesPaged,
          stats: JSON.stringify(snapshot?.noticeStats ?? null),
          readAll,
        }}
      >
        {content}
      </NoticePagingContext.Provider>
    </PetAppearanceContext.Provider>
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
  const { t } = useI18n();
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
          <span className="eyebrow">{t.app.activity.eyebrow}</span>
          <h1>{t.app.activity.title}</h1>
          <p>{t.app.activity.intro}</p>
        </div>
        <div className="segmented" role="group" aria-label={t.app.activity.kindLabel}>
          <button aria-pressed={kind === 'talk'} onClick={() => setKind('talk')}>
            {t.app.activity.talkOnly}
          </button>
          <button aria-pressed={kind === 'all'} onClick={() => setKind('all')}>
            {t.app.activity.withTools}
          </button>
        </div>
      </header>
      <div className="activity-summary">
        <div>
          <span>{t.app.activity.touchedToday}</span>
          <strong>{touched.length}</strong>
          <div className="activity-faces">
            {touched.slice(0, 6).map((s) => (
              <span key={s.id} className={`face face-${s.provider}`}>
                <Sprite session={s} provider={s.provider} mood="idle" size={26} />
              </span>
            ))}
          </div>
        </div>
        <div>
          <span>{t.app.activity.withNotes}</span>
          <strong>{sessions.filter((s) => s.notes).length}</strong>
          <small>{t.app.activity.withNotesHint}</small>
        </div>
        <div>
          <span>{t.app.activity.checked}</span>
          <strong>{sessions.filter((s) => s.completed).length}</strong>
          <small>{t.app.activity.checkedHint}</small>
        </div>
      </div>
      <div className="activity-list">
        {[...days].map(([day, items]) => (
          <section key={day} className="activity-day">
            <h2>
              {day}
              <span>{t.app.activity.dayCount(items.length)}</span>
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
                      <Sprite session={s} provider={s.provider} mood={s.status} size={32} />
                    </span>
                    <div>
                      <span className="activity-meta">
                        <b>{privacy ? PROVIDERS[s.provider].name : sessionName(s)}</b>
                        <i className={`kind-chip kind-${event.kind}`}>
                          {event.kind === 'assistant' && event.phase === 'final'
                            ? t.app.activity.finalReply
                            : t.app.activity.kinds[event.kind]}
                        </i>
                        {!privacy && <small>{s.project}</small>}
                      </span>
                      <p>{privacy ? t.app.activity.hidden : messageExcerpt(event.text, 280)}</p>
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
          <h3>{t.app.activity.empty}</h3>
        </div>
      )}
    </div>
  );
}
