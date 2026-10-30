import { MiniShellDemoRelease } from './components/MiniShell';
import { OfficeGuide, type GuideAction } from './components/OfficeGuide';
import { hasSeenOnboarding, rememberOnboarding } from './lib/onboarding';
import { PetAppearanceContext } from './components/PetAppearanceContext';
import { UsagePanel } from './components/UsagePanel';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { PanelResizer } from './components/PanelResizer';
import {
  PANEL,
  PANEL_WIDTHS_KEY,
  fitPanels,
  readWidths,
  readWidthsAt,
  type PanelWidths,
} from './shared/panel-widths';
import {
  Gauge,
  Home,
  BookOpen,
  Clock3,
  Settings2,
  AppWindow,
  Search,
  PictureInPicture2,
  Eye,
  EyeOff,
  ShieldCheck,
  ArrowUpRight,
  X,
  AlertCircle,
  Sparkles,
  Armchair,
  Archive,
  Keyboard,
  RotateCw,
  Wind,
  Building2,
  Coffee,
  HelpCircle,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { api, isDesktop } from './lib/api';
import { isWindows, modifierKey, platformKeys } from './lib/platform';
import { PROVIDERS, type Session, type ZoneRule } from './shared/types';
import { useOffice } from './lib/useOffice';
import { useTerminalSend } from './lib/useTerminalSend';
import { useAnswerSettings } from './lib/useAnswerSettings';
import { date, time, ago } from './lib/format';
import { Sprite } from './components/Sprite';
import { OfficeRooms } from './components/OfficeRooms';
import { LOCAL_ROOM, sessionRoom, roomModel } from './shared/rooms';
import { OfficeWorkspace } from './components/OfficeWorkspace';
import { projectKey, sessionName } from './shared/office';
import { projectColor } from './shared/office-layout';
import { messageExcerpt } from './shared/activity';
import { Inspector } from './components/Inspector';
import { ZoneEditor } from './components/ZoneEditor';
import { Memory } from './components/Memory';
import type { BookmarkFocus } from './shared/bookmarks';
import { Settings, type SettingsSection } from './components/Settings';
import { isAttentionNotice } from './shared/notices';
import type { OfficeZone } from './shared/types';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { Modal } from './components/Modal';
import { awayDigest, triage, unreadInbox } from './shared/triage';
import { useI18n } from './lib/i18n';
import { cardReadSettings } from './shared/card-reads';
import { resetDue } from './shared/view-prefs';
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
  // The left menu folded away for room (remembered on this computer).
  const [sidebarHidden, setSidebarHiddenState] = useState(() => {
    try {
      return localStorage.getItem('office:sidebar') === 'hidden';
    } catch {
      return false;
    }
  });
  const setSidebarHidden = (hidden: boolean) => {
    setSidebarHiddenState(hidden);
    try {
      localStorage.setItem('office:sidebar', hidden ? 'hidden' : 'shown');
    } catch {
      // Remembering is a convenience.
    }
  };
  // Widths the person dragged the left menu and the right column to (remembered here), fitted to
  // the window as it is now.
  // `widthsAt`: when the person last dragged them, so a later reset (from any window) wins.
  const widthsAt = useRef(0);
  const [widths, setWidthsState] = useState<PanelWidths>(() => {
    try {
      const raw = localStorage.getItem(PANEL_WIDTHS_KEY);
      widthsAt.current = readWidthsAt(raw);
      return readWidths(raw);
    } catch {
      return {};
    }
  });
  const setWidths = (patch: PanelWidths) => {
    widthsAt.current = Date.now();
    setWidthsState((was) => ({ ...was, ...patch }));
  };
  useEffect(() => {
    // Saved once the edge rests, not on every step of a drag (and on leaving, if sooner).
    const save = () => {
      try {
        localStorage.setItem(
          PANEL_WIDTHS_KEY,
          JSON.stringify({ ...widths, at: widthsAt.current || undefined }),
        );
      } catch {
        // Remembering is a convenience.
      }
    };
    const timer = setTimeout(save, 300);
    window.addEventListener('pagehide', save);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pagehide', save);
    };
  }, [widths]);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const resized = () => setViewport(window.innerWidth);
    window.addEventListener('resize', resized);
    return () => window.removeEventListener('resize', resized);
  }, []);
  const [showUsage, setShowUsage] = useState(false);
  // Bumped when a bubble opens a card: the card shows the conversation, whatever tab it was on.
  const [conversationAt, setConversationAt] = useState(0);
  const [view, setView] = useState<(typeof tabs)[number]['id']>('office');
  const [selected, setSelected] = useState<string | null>(
    location.hash.startsWith('#session=')
      ? decodeURIComponent(location.hash.slice(9))
      : !demo
        ? localStorage.getItem('office:last-session')
        : null,
  );
  // A card restored on startup (last session or `#session=`) reads nothing until the person
  // touches the office: any press or key, or choosing a colleague.
  const [engaged, setEngaged] = useState(() => !selected);
  useEffect(() => {
    if (engaged) return;
    const engage = () => setEngaged(true);
    window.addEventListener('pointerdown', engage, true);
    window.addEventListener('keydown', engage, true);
    return () => {
      window.removeEventListener('pointerdown', engage, true);
      window.removeEventListener('keydown', engage, true);
    };
  }, [engaged]);
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
    model: allModel,
    refresh,
    setPrefs: onPrefs,
    patch: onPatch,
    pin,
    receipt: onReceipt,
    visit,
    veil,
    reorderSeats,
    returnToOffice,
    bookmark,
    unbookmark,
  } = useOffice(demo, notify);
  const [room, setRoom] = useState(() => localStorage.getItem('office:beta-room') || LOCAL_ROOM);
  const roomsEnabled = !demo && !!snapshot?.federation?.enabled;
  const activeRoom =
    roomsEnabled &&
    (room === LOCAL_ROOM || snapshot?.federation?.peers.some((p) => p.officeId === room))
      ? room
      : LOCAL_ROOM;
  const model = useMemo(
    () => (roomsEnabled ? roomModel(allModel, activeRoom) : allModel),
    [allModel, roomsEnabled, activeRoom],
  );
  useEffect(() => {
    if (roomsEnabled) localStorage.setItem('office:beta-room', activeRoom);
  }, [roomsEnabled, activeRoom]);
  const chosenSession = snapshot?.sessions.find((s) => s.id === selected);
  const chosenRoom = chosenSession ? sessionRoom(chosenSession) : undefined;
  useEffect(() => {
    if (chosenRoom && roomsEnabled) setRoom(chosenRoom);
  }, [chosenRoom, roomsEnabled]);
  // A bookmark being opened: its colleague's card, at its message.
  const [bookmarkFocus, setBookmarkFocus] = useState<BookmarkFocus | null>(null);
  useEffect(
    () =>
      api.onSelect?.((id, bookmark) => {
        setView('office');
        setEngaged(true);
        setSelected(id);
        // From a reader window: the conversation at the bookmarked message.
        if (bookmark)
          setBookmarkFocus({
            sessionId: id,
            eventId: bookmark.eventId,
            at: bookmark.at,
            key: Date.now(),
          });
      }),
    [],
  );
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [memoryQuery, setMemoryQuery] = useState('');
  const [settingsFocus, setSettingsFocus] = useState<{ section: SettingsSection; at: number }>();
  const clearSettingsFocus = useCallback(() => setSettingsFocus(undefined), []);
  // The settings page at one category/section (guide links, the office's gear, rooms).
  const openSettings = (section: SettingsSection) => {
    setSettingsFocus({ section, at: Date.now() });
    setView('settings');
  };
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
    // Only macOS windows get the translucent sidebar material (see desktop/main.ts).
    document.body.classList.toggle('is-mac', isDesktop && /Mac/i.test(navigator.userAgent));
    document.body.classList.toggle('is-windows', isDesktop && isWindows);
  }, []);
  const sessions = snapshot?.sessions ?? [];
  // J/K walks what the office shows: hidden colleagues stay out until they talk again.
  const ordered = model.scene;
  const current = sessions.find((s) => s.id === selected);
  // The desktop skips notifications about the colleague whose card is open here (#229).
  const currentId = current?.id ?? null;
  useEffect(() => {
    if (!demo) api.selected?.(currentId);
  }, [demo, currentId]);
  const prefs = snapshot?.preferences;
  // '패널 폭 초기화' in settings (maybe the settings window, another renderer): a stamp newer
  // than the last drag puts both columns back to their defaults.
  const widthsResetAt = prefs?.panelWidthsResetAt;
  useEffect(() => {
    if (!resetDue(widthsResetAt, widthsAt.current)) return;
    widthsAt.current = widthsResetAt!;
    setWidthsState({});
  }, [widthsResetAt]);
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
  // The office remembers its zone per data source; the sidebar and title mirror it from the start.
  const [officeZoneNow, setOfficeZoneNow] = useState<OfficeZone>(() => {
    try {
      const zone = JSON.parse(
        localStorage.getItem(`office:view:${demo ? 'demo' : 'live'}`) || '{}',
      ).zone;
      return zone === 'waiting' || zone === 'archive' ? zone : 'office';
    } catch {
      return 'office';
    }
  });
  const [projectRequest, setProjectRequest] = useState<{
    key: string;
    name: string;
    at: number;
  } | null>(null);
  // Desktop-only Send to terminal setting and the quick-reply send, shared with the dock card.
  const {
    enabled: terminalSend,
    available: terminalSendAvailable,
    toggle: toggleTerminalSend,
    sendReply,
  } = useTerminalSend(demo, notify);
  // Desktop-only answering of questions, plans and permission prompts (both off by default).
  const answers = useAnswerSettings(demo, notify);
  // The desk pin and the card pin are one switch on the colleague.
  const onPin = (s: Session) =>
    void pin(s)
      .then((on) => notify(on ? t.app.toast.pinned : t.app.toast.unpinned))
      .catch((e) => notify((e as Error).message));
  const saveZoneRules = async (zoneRules: ZoneRule[]) => {
    if (await onPrefs({ zoneRules })) notify(t.app.toast.zonesSaved);
  };
  const choose = (id: string) => {
    setEngaged(true);
    setBookmarkFocus(null);
    setShowUsage(false);
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
    notify(t.app.toast.markedRead);
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
      else setSelected(null);
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
    setShowUsage(false);
    if (action === 'usage') setShowUsage(true);
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
              ? action
              : 'connections';
      openSettings(section);
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
      id: 'sidebar',
      label: sidebarHidden ? t.app.showSidebar : t.app.hideSidebar,
      icon: sidebarHidden ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />,
      keywords: t.palette.actions.sidebarKeywords,
      run: () => setSidebarHidden(!sidebarHidden),
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
    // Desktop: a separate settings window that stays open beside work (#87).
    ...(api.settings && !demo
      ? [
          {
            id: 'settings-window',
            label: t.palette.actions.settingsWindow,
            hint: t.palette.actions.settingsWindowHint,
            icon: <AppWindow size={15} />,
            keywords: t.palette.actions.settingsKeywords,
            run: () => void api.settings?.open(),
          },
        ]
      : []),
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
  const docked = !!current || showUsage;
  // The right column: the office's list, or a card or usage beside any view.
  const rightColumn = (view === 'office' && !!snapshot) || docked;
  const panels = fitPanels(widths, viewport, { sidebar: !sidebarHidden, dock: rightColumn });
  const sidebarToggle = (
    <button
      className="icon-btn sidebar-toggle"
      aria-label={t.app.sidebarToggle}
      aria-expanded={!sidebarHidden}
      aria-controls="main-menu"
      title={sidebarHidden ? t.app.showSidebar : t.app.hideSidebar}
      onClick={() => setSidebarHidden(!sidebarHidden)}
    >
      {sidebarHidden ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
    </button>
  );
  const content = (
    <div
      className={`app ${prefs?.reducedMotion ? 'reduce-motion' : ''} ${docked ? 'has-dock' : ''} ${prefs?.privacy ? 'is-private' : ''} ${sidebarHidden ? 'sidebar-hidden' : ''}`}
      style={
        {
          ...(panels.css.side ? { '--side-w': `${panels.css.side}px` } : {}),
          ...(panels.css.dock ? { '--dock-w': `${panels.css.dock}px` } : {}),
        } as CSSProperties
      }
    >
      {isDesktop && isWindows && (
        <div className="windows-titlebar">
          <img src="./icon.png" alt="" width="18" height="18" />
          <span>Agent Office</span>
        </div>
      )}
      <aside className="sidebar" id="main-menu" aria-label={t.app.mainMenu}>
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
        {roomsEnabled && snapshot && (
          <OfficeRooms
            snapshot={snapshot}
            selected={activeRoom}
            onSelect={(id) => {
              setRoom(id);
              setSelected(null);
              setProjectRequest(null);
              setShowUsage(false);
              setView('office');
            }}
            onSettings={() => openSettings('federation')}
          />
        )}
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
                // Named even when a narrow window shows only the icon.
                aria-label={tab ? t.app.tabs.office.title : t.office.zones[zone]}
                title={tab ? t.app.tabs.office.title : t.office.zones[zone]}
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
                  // These colleagues sit in the office: show it, not the lounge or archive.
                  goZone('office');
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
                    // The filtered roster shows where the usage panel would cover it.
                    setShowUsage(false);
                    setView('office');
                    setProjectRequest({ key: p.key, name: p.name, at: Date.now() });
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
            <button
              className="icon-btn"
              title={t.app.help.title}
              aria-label={t.app.help.title}
              onClick={() => setHelp(true)}
            >
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
        <PanelResizer
          edge="left"
          width={panels.side}
          min={PANEL.sideMin}
          max={panels.sideMax}
          label={t.app.resizeSidebar}
          hint={t.app.resizeHint}
          controls="main-menu"
          onWidth={(side) => setWidths({ side })}
          onReset={() => setWidths({ side: undefined })}
        />
      </aside>
      <div className="app-body">
        {rightColumn && (
          <PanelResizer
            edge="right"
            width={panels.dock}
            min={PANEL.dockMin}
            max={panels.dockMax}
            label={t.app.resizeDock}
            hint={t.app.resizeHint}
            onWidth={(dock) => setWidths({ dock })}
            onReset={() => setWidths({ dock: undefined })}
          />
        )}
        <main className={`main-content view-${view}`}>
          <header className="toolbar app-header">
            {sidebarToggle}
            <div className="toolbar-title">
              <h1>
                {view === 'office' && roomsEnabled
                  ? activeRoom === LOCAL_ROOM
                    ? t.federation.localOffice
                    : prefs?.privacy
                      ? t.federation.remoteOffice
                      : snapshot?.federation?.peers.find((p) => p.officeId === activeRoom)?.label
                  : view === 'office'
                    ? t.office.zones[officeZoneNow]
                    : t.app.tabs[view].title}
              </h1>
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
              title={`${t.palette.search} · ${platformKeys('⌘K')}`}
            >
              <Search size={13} />
              <span>{t.palette.search}</span>
              <kbd>{platformKeys('⌘K')}</kbd>
            </button>
            <div className="header-actions">
              <button
                className={`icon-btn usage-button ${showUsage ? 'is-on' : ''}`}
                aria-label={t.app.header.openUsage}
                title={t.app.header.usageTitle}
                onClick={() => {
                  setShowUsage((v) => !v);
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
                className="mini-button"
                aria-label={t.app.header.mini}
                title={t.app.header.miniTitle}
                onClick={() => api.window('mini')}
              >
                <PictureInPicture2 size={15} />
                <span>{t.app.header.mini}</span>
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
            <div className="error-banner" role="status">
              <AlertCircle size={16} />
              <span>{error}</span>
              <button onClick={refresh} disabled={refreshing}>
                {t.app.reconnect}
              </button>
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
                  // One colleague opens on its card; several are marked in the office's list.
                  if (digest.sessionIds.length === 1) {
                    setView('office');
                    choose(digest.sessionIds[0]);
                  } else {
                    setSelected(null);
                    goZone('office');
                  }
                }}
              >
                {digest.sessionIds.length === 1 ? t.app.away.viewOne : t.app.away.viewOffice}
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
                <button className="button primary" onClick={refresh} disabled={refreshing}>
                  {t.app.reconnect}
                </button>
                <button className="button subtle" onClick={() => setDemo(true)}>
                  {t.app.offline.tour}
                </button>
              </div>
            </div>
          ) : view === 'office' ? (
            <OfficeWorkspace
              key={demo ? 'demo' : `live:${activeRoom}`}
              snapshot={snapshot}
              model={model}
              onVeil={(ids, on) => {
                void veil(ids, on);
                notify(on ? t.app.toast.hidden : t.app.toast.shown);
              }}
              onPin={onPin}
              onSettings={() => openSettings('office')}
              selected={selected}
              onSelect={choose}
              onConversation={(id) => {
                choose(id);
                setConversationAt((n) => n + 1);
              }}
              onReturn={returnToOffice}
              onReceipt={onReceipt}
              onRefresh={refresh}
              refreshing={refreshing}
              demo={demo}
              zoneRequest={zoneRequest}
              onZoneHandled={() => setZoneRequest(null)}
              onZoneChange={setOfficeZoneNow}
              projectRequest={projectRequest}
              onProjectHandled={() => setProjectRequest(null)}
              onReply={sendReply}
              notify={notify}
              onZoneDrop={(id, zone) => {
                if (!sessions.find((s) => s.id === id)?.remote) setAreaDrop({ id, zone });
              }}
              onReorder={(ids) => void reorderSeats(ids)}
            />
          ) : view === 'memory' ? (
            <Memory
              key={memoryQuery}
              initialQuery={memoryQuery}
              sessions={sessions}
              onSelect={choose}
              demo={demo}
              privacy={prefs?.privacy ?? false}
              // Any bookmark write, and whatever decides which are shown: a colleague leaving
              // the office or moving projects changes its marks, the settings the rest.
              bookmarkStamp={JSON.stringify([
                snapshot?.bookmarkStamp,
                snapshot?.bookmarked,
                prefs?.excludedProjects,
                prefs?.enabledProviders,
              ])}
              onOpenBookmark={(b) => {
                choose(b.sessionId);
                setBookmarkFocus({
                  sessionId: b.sessionId,
                  eventId: b.eventId,
                  at: b.at,
                  key: Date.now(),
                });
              }}
              onUnbookmark={unbookmark}
              notify={notify}
            />
          ) : view === 'settings' ? (
            <Settings
              demo={demo}
              snapshot={snapshot}
              onPrefs={onPrefs}
              onRefresh={refresh}
              notify={notify}
              terminalSend={terminalSendAvailable ? terminalSend : undefined}
              onTerminalSend={toggleTerminalSend}
              answers={answers.available ? answers.settings : undefined}
              onAnswers={(key) => void answers.toggle(key)}
              layout="page"
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
            showConversation={conversationAt}
            readOnOpen={engaged}
            reading={cardReadSettings(prefs)}
            onClose={() => setSelected(null)}
            // In the office the card takes the list's place; elsewhere it just closes.
            onBack={view === 'office' ? () => setSelected(null) : undefined}
            onPatch={onPatch}
            onPin={onPin}
            onReturn={returnToOffice}
            notify={notify}
            demo={demo}
            privacy={prefs?.privacy ?? false}
            zoneRules={prefs?.zoneRules ?? []}
            onZoneRules={saveZoneRules}
            terminalSend={terminalSend}
            bookmarked={snapshot?.bookmarked?.[current.id]}
            onBookmark={bookmark}
            bookmarkMarks={snapshot?.bookmarked}
            bookmarkStamp={JSON.stringify([
              snapshot?.bookmarkStamp,
              snapshot?.bookmarked,
              prefs?.excludedProjects,
              prefs?.enabledProviders,
            ])}
            onUnbookmark={unbookmark}
            onOpenBookmark={(b) => {
              choose(b.sessionId);
              setBookmarkFocus({
                sessionId: b.sessionId,
                eventId: b.eventId,
                at: b.at,
                key: Date.now(),
              });
            }}
            focus={bookmarkFocus}
            onFocused={() => setBookmarkFocus(null)}
          />
        )}
        {showUsage && (
          <UsagePanel
            demo={demo}
            privacy={prefs?.privacy ?? false}
            onClose={() => setShowUsage(false)}
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
          return moving && !moving.remote ? (
            <Modal title={t.app.moveZone} onClose={() => setAreaDrop(null)}>
              <ZoneEditor
                session={moving}
                sessions={sessions.filter((session) => !session.remote)}
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
                ['find', [[modifierKey, 'K'], ['/']]],
                ['next', [['J']]],
                ['previous', [['K']]],
                ['markRead', [['R']]],
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
      <MiniShellDemoRelease demo={demo} />
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
      {content}
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
