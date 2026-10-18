import { focusName } from '../shared/terminal-target';
import { branchInfo } from '../shared/branch';
import { useEffect, useState, useCallback, useRef } from 'react';
import {
  X,
  Pin,
  Folder,
  GitBranch,
  Clock,
  Copy,
  PackageOpen,
  Check,
  ArrowRight,
  Download,
  Terminal,
  LayoutGrid,
  Maximize2,
  ListFilter,
  MapPin,
  PinOff,
} from 'lucide-react';
import type {
  Session,
  SessionPatch,
  Bookmark,
  Handoff,
  OfficeNotice,
  ZoneRule,
  Preferences,
} from '../shared/types';
import { PetCustomizer } from './PetCustomizer';
import { MOODS } from '../shared/types';
import { sessionScopeLabel } from '../shared/residents';
import { Sprite } from './Sprite';
import { Modal } from './Modal';
import { ago, compact, shortPath, time, date } from '../lib/format';
import { api, isDesktop } from '../lib/api';
import { sendFollowUp } from '../lib/useTerminalSend';
import { dismissSend, rememberSend, settlePending, usePendingSends } from '../lib/pendingSends';
import { copyText, jumpOrCopy } from '../lib/resume';
import { Bookmarks } from './Bookmarks';
import { Conversation } from './Conversation';
import type { BookmarkFocus } from '../shared/bookmarks';
import {
  freshConversation,
  mergeLive,
  mergeNewest,
  prependPage,
} from '../shared/conversation-pages';
import { ArtifactCards } from './ArtifactCards';
import { sessionName, parentSession } from '../shared/office';
import { nowState } from '../shared/now-state';
import { unreadNoticeCount } from '../shared/notices';
import { CardMenu } from './CardMenu';
import { NewsFeed, type ReceiptHandler } from './News';
import { presentSession, PHASE_LABELS } from '../shared/presentation';
import { zoneLabel } from '../shared/zones';
import { ZoneEditor } from './ZoneEditor';
import { TerminalSend } from './TerminalSend';
import { RequestCard } from './RequestCard';
import { openRequest } from '../shared/requests';
import { useSendTargets } from '../lib/useSendTargets';
import { useI18n } from '../lib/i18n';
export function Inspector({
  session,
  sessions,
  notices,
  memberIds,
  resident,
  onReceipt,
  onSelect,
  showNews,
  onClose,
  onPatch,
  onPin,
  onReturn,
  notify,
  demo,
  privacy,
  zoneRules,
  onZoneRules,
  terminalSend = false,
  onExpand,
  onPrefs,
  bookmarked,
  onBookmark,
  bookmarkStamp = '',
  bookmarkMarks,
  onOpenBookmark,
  onUnbookmark,
  focus,
  onFocused,
  movable = false,
  cardPinned = false,
  onCardPin,
  positionRemembered = false,
  onPositionRemember,
  windowBusy = false,
}: {
  session: Session;
  sessions: Session[];
  notices: OfficeNotice[];
  /** All runs of the colleague in the room, so its state (asking, a result) matches the roster. */
  memberIds?: string[];
  /**
   * The office colleague this run belongs to (a persona speaks for all of its runs), so the
   * pin shows and changes what the desk shows. Absent for sessions outside the office.
   */
  resident?: Session;
  onReceipt: ReceiptHandler;
  onSelect: (id: string) => void;
  showNews?: string | null;
  onClose: () => void;
  onReturn: (id: string) => void;
  onPatch: (id: string, p: SessionPatch) => Promise<void>;
  /** Pin or unpin a colleague, the same way its desk pin does. */
  onPin: (s: Session) => void;
  notify: (s: string) => void;
  demo: boolean;
  privacy: boolean;
  zoneRules?: ZoneRule[];
  onZoneRules?: (rules: ZoneRule[]) => Promise<void>;
  terminalSend?: boolean;
  /** Shown in the dock card: open this colleague in the big office. */
  onExpand?: () => void;
  onPrefs: (patch: Partial<Preferences>) => Promise<boolean>;
  /** This colleague's bookmarked messages; `onBookmark` (absent in the demo) toggles one. */
  bookmarked?: string[];
  onBookmark?: (sessionId: string, eventId: string, on: boolean) => Promise<void>;
  bookmarkStamp?: string;
  bookmarkMarks?: Record<string, string[]>;
  onOpenBookmark?: (bookmark: Bookmark) => void;
  onUnbookmark?: (id: string) => Promise<void>;
  /** A bookmarked message to open the conversation at (`key` tells two openings apart). */
  focus?: BookmarkFocus | null;
  /** The bookmarked message was brought into view: `focus` is used up. */
  onFocused?: () => void;
  /**
   * The colleague's card reads like a chat — one header line with a menu, the details in a tab,
   * the conversation, and a chat box at the bottom — the same in the dock's pop-up card and in
   * the big office's right column. `movable`: it is the card window, moved by its header.
   */
  movable?: boolean;
  /** Independent native window, separate from keeping a colleague in the office. */
  cardPinned?: boolean;
  onCardPin?: (on: boolean) => void;
  positionRemembered?: boolean;
  onPositionRemember?: (on: boolean) => void;
  windowBusy?: boolean;
}) {
  const { t } = useI18n();
  // The pages of the conversation read so far, with the office's live view of the colleague.
  const [view, setView] = useState(() => freshConversation(session));
  const s = view.session;
  const panelRef = useRef<HTMLElement>(null);
  // The card is being moved by its header (see the card's header handlers).
  const moving = useRef(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = panelRef.current!;
    el.focus({ preventScroll: true });
    // On phones the card follows the room in the page flow; bring it into view.
    if (window.matchMedia('(max-width: 860px)').matches)
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [session.id]);
  const [tab, setTab] = useState<'overview' | 'history' | 'notes' | 'news'>('history');
  useEffect(() => {
    if (tab !== 'history') {
      const scroller = panelRef.current?.querySelector('.inspector-scroll');
      if (scroller) scroller.scrollTop = 0;
    }
  }, [tab, session.id]);
  const [alias, setAlias] = useState(session.alias);
  const [editing, setEditing] = useState(false);
  const [zoneOpen, setZoneOpen] = useState(false);
  const [petOpen, setPetOpen] = useState(false);
  const [notes, setNotes] = useState(session.notes);
  const [notesDirty, setNotesDirty] = useState(false);
  const [packet, setPacket] = useState<Handoff | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  // The card's chat shows progress notes unless the person switched them off (remembered).
  const [showProgress, setShowProgress] = useState(() => {
    try {
      return localStorage.getItem('office:card-progress') !== 'off';
    } catch {
      return true;
    }
  });
  // The office's view of this colleague (status, zone, return, the latest events) follows every
  // snapshot; the newest page of the conversation is read again only when it changed. Pages
  // read further back stay while they still join it; another colleague starts over.
  useEffect(() => {
    setView((previous) => mergeLive(previous, session));
  }, [session]);
  // The few latest events the office carries, by content: a fresh snapshot with the same events
  // (a new array each time) must not read the conversation again.
  const latestEvents = JSON.stringify(session.events);
  useEffect(() => {
    let valid = true;
    setLoadError('');
    if (!demo)
      api
        .detail(session.id)
        .then((page) => {
          if (valid) setView((previous) => mergeNewest(previous, page));
        })
        .catch((e) => {
          if (valid) setLoadError(e.message);
        });
    return () => {
      valid = false;
    };
  }, [
    session.id,
    session.revision,
    latestEvents,
    session.alias,
    session.notes,
    session.pinned,
    session.archived,
    session.completed,
    session.area?.ruleId,
    session.area?.name,
    demo,
  ]);
  useEffect(() => {
    setAlias(session.alias);
    setNotes(session.notes);
    setNotesDirty(false);
    setEditing(false);
    setZoneOpen(false);
    setPetOpen(false);
    setTab('history');
    setPacket(null);
  }, [session.id]);
  useEffect(() => {
    if (showNews) setTab('news');
  }, [showNews]);
  useEffect(() => {
    if (!notesDirty) setNotes(session.notes);
  }, [session.notes, notesDirty]);
  useEffect(() => {
    if (!editing) setAlias(session.alias);
  }, [session.alias, editing]);
  // Where a follow-up can go (live Orca/tmux terminal or Codex CLI queue), shared with the
  // office bubbles. Keyed by session, so a switch never shows the previous colleague's target.
  const locatable =
    !demo && !session.remote && (session.provider === 'claude' || session.provider === 'codex');
  const { targets, markSent } = useSendTargets(locatable ? [session.id] : [], {
    enabled: locatable,
    stamp: session.updatedAt,
  });
  const live = targets[session.id] ?? null;
  const closePacket = useCallback(() => setPacket(null), []);
  // What was just sent, until the record shows it (a busy Claude reads queued input later).
  // Kept per session outside this panel, so reopening the card or switching back still shows it.
  const sentAll = usePendingSends();
  const remember = rememberSend;
  const sent = sentAll.filter((p) => p.sessionId === s.id);
  // Opening a bookmark: the conversation, read back far enough to hold its message.
  const [reached, setReached] = useState<number | null>(null);
  const focusHere = focus && focus.sessionId === session.id && !demo ? focus : null;
  useEffect(() => {
    if (!focusHere) return;
    let valid = true;
    setTab('history');
    setReached(null);
    api
      .detail(session.id, { reach: focusHere.eventId, reachAt: focusHere.at })
      .then((page) => {
        if (!valid) return;
        setView((previous) => mergeNewest(previous, page));
        setReached(focusHere.key);
      })
      .catch((e) => {
        if (!valid) return;
        notify((e as Error).message);
        onFocused?.();
      });
    return () => {
      valid = false;
    };
  }, [focusHere?.key, session.id]);
  const mark =
    (s.remote ? undefined : onBookmark) &&
    ((eventId: string, on: boolean) =>
      void onBookmark!(s.id, eventId, on)
        .then(() => notify(on ? t.conversation.bookmarked : t.conversation.unbookmarked))
        .catch((e) => notify((e as Error).message)));
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** The page before the oldest loaded event (the card keeps it until it closes or switches). */
  const loadOlder = async () => {
    const first = view.session.events[0];
    if (demo || !view.older || !first || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api.detail(view.session.id, { before: first.id, beforeAt: first.at });
      setView((v) => (v.session.events[0]?.id === first.id ? prependPage(v, page) : v));
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  };
  const patch = async (p: SessionPatch) => {
    try {
      await onPatch(s.id, p);
      if (p.notes !== undefined) setNotesDirty(false);
      notify(t.inspector.saved);
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const handoff = async () => {
    setBusy(true);
    try {
      const result = demo
        ? {
            markdown: t.inspector.demoHandoff(s.title, s.notes),
            revision: s.revision,
            createdAt: Date.now(),
          }
        : await api.handoff(s.id, s.revision);
      setPacket(result);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = (text: string) => copyText(text, notify);
  const parent = parentSession(s, sessions);
  const children = sessions.filter((x) => parentSession(x, sessions)?.id === s.id);
  const personaRuns = s.actor
    ? sessions.filter((x) => x.actor?.id === s.actor!.id).sort((a, b) => b.updatedAt - a.updatedAt)
    : [];
  const news = notices.filter((n) => n.sessionId === s.id);
  // Excerpts in the conversation: the carried notices (freshest) and those read with its pages.
  const carried = new Set(news.map((n) => n.id));
  const conversationNotices = [...news, ...view.notices.filter((n) => !carried.has(n.id))];
  useEffect(() => {
    // The transcript may arrive before the send's IPC reply, and a retained request can be
    // visible even after it left the source window. Both settle the temporary receipt.
    settlePending(view.session.id, [
      ...view.session.events,
      ...conversationNotices
        .filter((n) => n.kind === 'request')
        .map((n) => ({
          id: n.eventId,
          kind: 'user',
          text: n.text,
          at: n.at,
        })),
    ]);
  }, [view.session.events, view.session.id, notices, view.notices, sentAll]);
  const members = new Set(memberIds ?? [s.id]);
  const colleagueNews = notices.filter((n) => members.has(n.sessionId) || n.sessionId === s.id);
  const state = nowState(s, colleagueNews);
  const codexApp = s.provider === 'codex' && isDesktop;
  const resumeLabel = codexApp
    ? t.inspector.openInCodex
    : live?.canFocus
      ? t.terminal.jumpTo(focusName(live))
      : t.inspector.copyResume;
  const resume = async () => {
    try {
      if (codexApp) {
        notify(await api.resume(s.id));
        return;
      }
      if (api.jump) {
        await jumpOrCopy(s.id, notify);
        return;
      }
      const value = await api.resume(s.id);
      if (s.provider !== 'codex' || !isDesktop) await copy(value);
      else notify(value);
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const presentation = presentSession(s);
  // The details: grouped rows, like the system settings.
  const cardOverview = (
    <div className="card-info">
      <section className="info-group">
        <h3>{t.inspector.card.statusTitle}</h3>
        <div className="info-row">
          <span>{t.inspector.overview.currentStatus}</span>
          <b>{s.statusReason || MOODS[s.status].label}</b>
        </div>
        <div className="info-row">
          <span>{t.inspector.overview.lastRun}</span>
          <b>
            {PHASE_LABELS[presentation.runtime.phase]} · {ago(presentation.runtime.at)}
            {presentation.stale ? t.inspector.overview.staleRun : ''}
          </b>
        </div>
        {s.alias && s.alias !== s.title && (
          <div className="info-row">
            <span>{t.inspector.originalName}</span>
            <b title={s.title}>{s.title}</b>
          </div>
        )}
        {s.relation?.role && (
          <div className="info-row">
            <span>{t.inspector.overview.role}</span>
            <b>{s.relation.role}</b>
          </div>
        )}
        {parent && (
          <button className="info-row info-link" onClick={() => onSelect(parent.id)}>
            <span>
              {s.relation?.kind === 'fork' ? t.inspector.forkSource : t.inspector.parentTask}
            </span>
            <b>{sessionName(parent)}</b>
            <ArrowRight size={13} />
          </button>
        )}
      </section>
      <section className="info-group">
        <h3>{t.inspector.overview.whereTitle}</h3>
        <div className="info-row">
          <span>
            <Folder size={13} />
            {t.inspector.overview.project}
          </span>
          <b>{s.project}</b>
        </div>
        <div className="info-row">
          <span>
            <LayoutGrid size={13} />
            {t.inspector.overview.zone}
          </span>
          <b>
            {s.area
              ? t.inspector.overview.zoneCustom(zoneLabel(s))
              : t.inspector.overview.zoneByProject(s.project)}
          </b>
        </div>
        <div className="info-row">
          <span>
            <GitBranch size={13} />
            {t.inspector.overview.branch}
          </span>
          <b title={branchInfo(s).detail}>{branchInfo(s).label}</b>
        </div>
        <div className="info-row">
          <span>
            <Clock size={13} />
            {t.inspector.overview.lastActive}
          </span>
          <b>
            {date(s.updatedAt)} {time(s.updatedAt)}
          </b>
        </div>
        <button
          className="info-row info-link"
          onClick={() => copy(s.cwd ?? '')}
          disabled={!s.cwd}
          title={s.cwd ?? ''}
        >
          <span>{t.inspector.card.startPath}</span>
          <code>{shortPath(s.cwd)}</code>
          <Copy size={12} />
        </button>
        {s.workingLocation && (
          <div className="info-row">
            <span>{t.inspector.overview.workingTitle}</span>
            <code title={s.workingLocation.path}>{shortPath(s.workingLocation.path)}</code>
          </div>
        )}
      </section>
      {children.length > 0 && (
        <section className="info-group">
          <h3>{t.inspector.linkedRuns(children.length)}</h3>
          {children.map((child) => (
            <button
              key={child.id}
              className="info-row info-link"
              onClick={() => onSelect(child.id)}
            >
              <span>
                {child.relation?.kind === 'fork' ? t.inspector.fork : sessionScopeLabel(child)}
              </span>
              <b>{sessionName(child)}</b>
              <ArrowRight size={13} />
            </button>
          ))}
        </section>
      )}
      <section className="info-group">
        <h3>{t.inspector.usage.title}</h3>
        <div className="info-row">
          <span>{t.inspector.card.model}</span>
          <b>{s.model || t.inspector.usage.modelMissing}</b>
        </div>
        <div className="info-row">
          <span>{t.inspector.usage.costLabel}</span>
          <b>
            {s.cost?.usd != null
              ? `$${s.cost.usd.toLocaleString('en-US', { minimumFractionDigits: s.cost.usd < 0.01 ? 4 : 2, maximumFractionDigits: s.cost.usd < 0.01 ? 4 : 2 })}`
              : t.inspector.usage.costUnknown}
          </b>
        </div>
        <div className="info-tokens">
          <div>
            <span>{t.inspector.usage.inputTokens}</span>
            <b>{compact(s.usage.input)}</b>
          </div>
          <div>
            <span>{t.inspector.usage.outputTokens}</span>
            <b>{compact(s.usage.output)}</b>
          </div>
          <div>
            <span>{t.inspector.usage.totalTokens}</span>
            <b>{compact(s.usage.total)}</b>
          </div>
        </div>
        {s.usage.contextUsed !== null &&
          s.usage.contextWindow !== null &&
          s.usage.contextWindow > 0 && (
            <div className="info-context">
              <div>
                <span>{t.inspector.usage.contextTitle}</span>
                <b>
                  {Math.min(100, Math.round((s.usage.contextUsed / s.usage.contextWindow) * 100))}%
                </b>
              </div>
              <progress value={s.usage.contextUsed} max={s.usage.contextWindow} />
            </div>
          )}
        <p className="info-note">{t.inspector.usage.costBasis}</p>
      </section>
      <p className="info-note">
        {s.sourceKind === 'sqlite'
          ? t.inspector.source.sqlite
          : s.sourceKind === 'demo'
            ? t.inspector.source.demo
            : t.inspector.source.log}{' '}
        · {s.partial ? t.inspector.source.partial : t.inspector.source.full}
      </p>
    </div>
  );
  // Pinning belongs to the colleague: a persona is pinned when any of its runs is.
  const colleague = resident ?? s;
  const petEditor = (
    <>
      {petOpen && (
        <PetCustomizer
          key={session.id}
          provider={session.provider}
          session={session}
          onPrefs={onPrefs}
          onClose={() => setPetOpen(false)}
        />
      )}
    </>
  );
  const zoneEditor = (
    <>
      {zoneOpen && !privacy && onZoneRules && (
        <ZoneEditor
          key={s.id}
          session={s}
          sessions={sessions}
          rules={zoneRules ?? []}
          onRules={onZoneRules}
          onClose={() => setZoneOpen(false)}
        />
      )}
    </>
  );
  const personaPicker = (
    <>
      {personaRuns.length > 0 && (
        <label className="persona-run-picker">
          <span>
            {privacy ? t.inspector.persona : s.actor?.name} ·{' '}
            {t.inspector.personaRuns(personaRuns.length)}
          </span>
          <select
            aria-label={t.inspector.personaRunsLabel}
            value={s.id}
            onChange={(e) => onSelect(e.target.value)}
          >
            {personaRuns.map((run) => (
              <option value={run.id} key={run.id}>
                {sessionScopeLabel(run)} · {privacy ? t.inspector.hiddenRecord : sessionName(run)} ·{' '}
                {ago(run.updatedAt)}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
  const tabBar = (
    <>
      <div className="inspector-tabs" role="tablist" aria-label={t.inspector.tabsLabel}>
        {(['history', 'news', 'overview', 'notes'] as const)
          .filter((key) => !s.remote || key === 'history' || key === 'overview')
          .map((key) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              className={tab === key ? 'active' : ''}
              onClick={() => setTab(key)}
            >
              {key === 'news'
                ? t.inspector.tabs.news(unreadNoticeCount(news))
                : t.inspector.tabs[key]}
              {key === 'notes' &&
                (s.notes || [...members].some((id) => bookmarkMarks?.[id]?.length)) && <i />}
            </button>
          ))}
      </div>
    </>
  );
  const scrollArea = (
    <>
      <div className={`inspector-scroll ${tab === 'news' ? 'news-tab-scroll' : ''}`}>
        {loadError && <div className="inline-error">{loadError}</div>}

        {privacy ? (
          <div className="privacy-placeholder">
            <Folder size={28} />
            <h3>{t.inspector.privacy.title}</h3>
            <p>{t.inspector.privacy.body}</p>
          </div>
        ) : tab === 'news' ? (
          <NewsFeed
            key={s.id + (showNews ?? '')}
            includeBackground
            initialFilter={showNews ? 'all' : 'final'}
            notices={news}
            sessionIds={[s.id]}
            sessions={sessions}
            privacy={privacy}
            onReceipt={onReceipt}
          />
        ) : tab === 'overview' ? (
          cardOverview
        ) : tab === 'history' ? (
          <Conversation
            key={s.id}
            session={s}
            notices={conversationNotices}
            older={view.older}
            loadingOlder={loadingOlder}
            onOlder={loadOlder}
            notify={notify}
            compact
            hideProgress={!showProgress}
            onShowProgress={() => setShowProgress(true)}
            name={privacy ? undefined : sessionName(s)}
            filtersOpen={filtersOpen}
            sent={sent}
            onDismissSent={dismissSend}
            bookmarked={bookmarked}
            onBookmark={demo ? undefined : mark}
            focus={focusHere && { ...focusHere, ready: reached === focusHere.key }}
            onFocused={onFocused}
          />
        ) : (
          <div className="inspector-memory">
            <section className="notes-editor">
              <span className="eyebrow">{t.inspector.notes.eyebrow}</span>
              <h3>{t.inspector.notes.manualTitle}</h3>
              <p>{t.inspector.notes.body}</p>
              <label className="sr-only" htmlFor="notes">
                {t.inspector.notes.label}
              </label>
              <textarea
                id="notes"
                readOnly={!!s.remote}
                value={notes}
                onChange={(e) => {
                  setNotes(e.target.value);
                  setNotesDirty(true);
                }}
                maxLength={12000}
                placeholder={t.inspector.notes.placeholder}
              />
              <button
                className="button primary"
                disabled={!!s.remote}
                onClick={() => patch({ notes })}
              >
                <Check size={16} />
                {t.inspector.notes.save}
              </button>
            </section>
            {onOpenBookmark && onUnbookmark && (
              <section
                className="inspector-bookmarks"
                aria-label={t.inspector.notes.bookmarksTitle}
              >
                <h3>{t.inspector.notes.bookmarksTitle}</h3>
                <p>{t.inspector.notes.bookmarksBody}</p>
                <Bookmarks
                  key={JSON.stringify([...members].sort())}
                  query=""
                  sessions={sessions}
                  sessionIds={[...members]}
                  privacy={privacy}
                  demo={demo}
                  stamp={bookmarkStamp}
                  onOpen={onOpenBookmark}
                  onRemove={onUnbookmark}
                  notify={notify}
                />
              </section>
            )}
            <button
              className={`completion-button ${s.completed ? 'checked' : ''}`}
              disabled={!!s.remote}
              onClick={() => patch({ completed: !s.completed })}
            >
              <span>{s.completed && <Check size={14} />}</span>
              <div>
                <b>{t.inspector.notes.completedTitle}</b>
                <small>{t.inspector.notes.completedBody}</small>
              </div>
            </button>
          </div>
        )}
      </div>
    </>
  );
  const handoffModal = (
    <>
      {packet && (
        <Modal title={t.inspector.handoff.title} onClose={closePacket} wide>
          <div className="handoff-intro">
            <PackageOpen size={24} />
            <div>
              <b>{t.inspector.handoff.introTitle}</b>
              <p>{t.inspector.handoff.introBody}</p>
            </div>
          </div>
          <textarea
            className="handoff-text"
            aria-label={t.inspector.handoff.textLabel}
            value={packet.markdown}
            onChange={(e) => setPacket({ ...packet, markdown: e.target.value })}
          />
          <div className="modal-footer">
            <span>{t.inspector.handoff.notSent}</span>
            <button
              className="button subtle"
              onClick={async () => {
                try {
                  if (await api.exportFile('agent-office-handoff.md', packet.markdown))
                    notify(t.inspector.handoff.savedFile);
                } catch (e) {
                  notify((e as Error).message);
                }
              }}
            >
              <Download size={15} />
              {t.inspector.handoff.saveFile}
            </button>
            <button className="button primary" onClick={() => copy(packet.markdown)}>
              <Copy size={15} />
              {t.inspector.handoff.copy}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
  const endMove = () => {
    if (!moving.current) return;
    moving.current = false;
    void api.card?.('drag-end');
  };
  const item = (label: string, run: () => void, close: () => void, disabled = false) => (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        close();
        run();
      }}
    >
      {label}
    </button>
  );
  const calling = state === 'attention';
  return (
    <>
      <aside
        className="inspector inspector-card"
        aria-label={t.inspector.label}
        ref={panelRef}
        tabIndex={-1}
      >
        <div
          className="card-head"
          // In the card window, pressing the header's empty space moves it (the desktop follows
          // the cursor). In the big office the header is the window's own drag region (CSS).
          onPointerDown={(e) => {
            if (e.button !== 0 || !movable || !api.card) return;
            if ((e.target as Element).closest('button, input, form, a, .card-menu')) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            moving.current = true;
            void api.card('drag-start');
          }}
          onPointerUp={endMove}
          onPointerCancel={endMove}
          onLostPointerCapture={endMove}
        >
          <div className={`card-avatar face-${s.provider} status-${s.status}`}>
            <Sprite session={s} provider={s.provider} mood={s.status} size={36} />
          </div>
          <div className="card-title">
            {editing ? (
              <form
                className="name-editor"
                onSubmit={async (e) => {
                  e.preventDefault();
                  await patch({ alias });
                  setEditing(false);
                }}
              >
                <label className="sr-only" htmlFor="nickname">
                  {t.inspector.nicknameLabel}
                </label>
                <input
                  autoFocus
                  id="nickname"
                  value={alias}
                  maxLength={60}
                  onChange={(e) => setAlias(e.target.value)}
                  placeholder={t.inspector.nicknamePlaceholder}
                />
                <button className="icon-btn" type="submit" aria-label={t.inspector.saveNickname}>
                  <Check size={15} />
                </button>
              </form>
            ) : (
              <h2 title={privacy ? undefined : sessionName(s)}>
                {privacy ? t.inspector.hiddenTeammate : sessionName(s)}
                {!privacy && <small> · {s.area ? s.area.name : s.project}</small>}
              </h2>
            )}
            <span className={`card-status ${calling ? 'is-calling' : ''}`}>
              <i style={{ background: MOODS[s.status].color }} />
              {MOODS[s.status].label} · {ago(s.updatedAt)}
              {colleague.pinned && <Pin size={10} />}
            </span>
          </div>
          <div className="card-head-tools">
            {!movable && !s.remote && (
              <>
                <button
                  className="icon-btn"
                  aria-label={busy ? t.inspector.gathering : t.inspector.packHandoff}
                  data-tip={t.inspector.packHandoff}
                  disabled={busy || privacy}
                  onClick={handoff}
                >
                  <PackageOpen size={15} />
                </button>
                <button
                  className={`icon-btn ${colleague.pinned ? 'gold' : ''}`}
                  aria-label={colleague.pinned ? t.inspector.unpin : t.inspector.pin}
                  aria-pressed={colleague.pinned}
                  data-tip={colleague.pinned ? t.inspector.unpin : t.inspector.pinTitle}
                  onClick={() => onPin(colleague)}
                >
                  <Pin size={15} />
                </button>
              </>
            )}
            {onPositionRemember && (
              <button
                className={`icon-btn ${positionRemembered ? 'is-on' : ''}`}
                aria-label={t.inspector.card.rememberPosition}
                aria-pressed={positionRemembered}
                data-tip={
                  positionRemembered ? t.inspector.card.positionOn : t.inspector.card.positionOff
                }
                disabled={windowBusy}
                onClick={() => onPositionRemember(!positionRemembered)}
              >
                <MapPin size={15} />
              </button>
            )}
            {onCardPin && (
              <button
                className={`icon-btn ${cardPinned ? 'is-on' : ''}`}
                aria-label={t.inspector.card.pinCard}
                aria-pressed={cardPinned}
                data-tip={cardPinned ? t.inspector.card.pinOn : t.inspector.card.pinOff}
                disabled={windowBusy}
                onClick={() => onCardPin(!cardPinned)}
              >
                {cardPinned ? <PinOff size={15} /> : <Pin size={15} />}
              </button>
            )}
            {onExpand && (
              <button
                className="icon-btn"
                aria-label={t.inspector.expand}
                data-tip={t.inspector.expandTitle}
                onClick={onExpand}
              >
                <Maximize2 size={15} />
              </button>
            )}
            {!s.remote && (
              <CardMenu label={t.inspector.card.more}>
                {(close) => (
                  <>
                    {movable &&
                      item(
                        colleague.pinned ? t.inspector.unpin : t.inspector.pin,
                        () => onPin(colleague),
                        close,
                      )}
                    {s.zone &&
                      s.zone !== 'office' &&
                      item(t.inspector.returnToOffice, () => onReturn(s.id), close)}
                    {item(t.inspector.rename, () => setEditing(true), close)}
                    {item(t.pets.individualTitle, () => setPetOpen(true), close)}
                    {!privacy &&
                      onZoneRules &&
                      item(t.inspector.zone, () => setZoneOpen(true), close)}
                    {item(
                      t.inspector.revealSource,
                      () => void api.reveal(s.id).catch((e) => notify(e.message)),
                      close,
                      demo || !isDesktop || privacy,
                    )}
                    {item(
                      s.archived ? t.inspector.unarchive : t.inspector.archive,
                      () => void patch({ archived: !s.archived }),
                      close,
                    )}
                  </>
                )}
              </CardMenu>
            )}
            <button
              className="icon-btn"
              aria-label={t.inspector.close}
              title={t.inspector.closeTitle}
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </div>
        {s.remote && (
          <p className="remote-source" role="status">
            {t.federation.readOnly} · {privacy ? t.inspector.hiddenTeammate : s.remote.label}
            {s.remote.stale && (
              <>
                {' '}
                · {t.federation.stale} ({ago(s.remote.receivedAt)})
              </>
            )}
            {!privacy && s.remote.tags.length > 0 && <> · {s.remote.tags.join(' · ')}</>}
            <br />
            {t.federation.recentOnly}
          </p>
        )}
        {petEditor}
        {zoneEditor}
        {personaPicker}
        {!privacy && (
          <div className="card-recent">
            <ArtifactCards
              id={s.id}
              urls={s.artifacts}
              demo={demo}
              privacy={privacy}
              notify={notify}
              variant="list"
            />
          </div>
        )}
        <div className="card-tabs-row">
          {tabBar}
          {tab === 'history' && (
            <button
              className={`card-filter-button ${filtersOpen ? 'active' : ''}`}
              aria-label={t.inspector.card.filters}
              aria-expanded={filtersOpen}
              data-tip={t.inspector.card.filters}
              onClick={() => setFiltersOpen((v) => !v)}
            >
              <ListFilter size={14} />
            </button>
          )}
          {tab === 'history' && (
            <label className="card-progress-switch">
              <span>{t.inspector.card.progress}</span>
              <input
                type="checkbox"
                role="switch"
                aria-label={t.inspector.card.progressLabel}
                checked={showProgress}
                onChange={(e) => {
                  setShowProgress(e.target.checked);
                  try {
                    localStorage.setItem('office:card-progress', e.target.checked ? 'on' : 'off');
                  } catch {
                    // Remembering is a convenience.
                  }
                }}
              />
            </label>
          )}
        </div>
        {scrollArea}
        <div className="card-composer">
          {/* What a calling colleague asks, answerable here where the desktop app sees it. */}
          {calling && !privacy && !s.remote && (
            <div className="card-request">
              <RequestCard session={s} target={live} notify={notify} demo={demo} />
            </div>
          )}
          <div className="card-actions">
            <button
              className={`card-action ${calling ? 'primary' : ''}`}
              disabled={demo || !!s.remote}
              onClick={resume}
            >
              <Terminal size={13} />
              {resumeLabel}
            </button>
            {codexApp && live?.canFocus && (
              <button
                className="card-action"
                disabled={demo}
                onClick={() => void jumpOrCopy(s.id, notify).catch((e) => notify(e.message))}
              >
                <Terminal size={13} />
                {t.terminal.jumpTo(focusName(live))}
              </button>
            )}
            {/* Nothing to answer here (no question, plan or prompt read): it happens where it runs. */}
            {calling && !openRequest(s) && (
              <span className="card-calling-note">{t.inspector.card.callingNote}</span>
            )}
          </div>
          {/* Always open to writing where a terminal can exist; the send checks again. */}
          {locatable && api.send ? (
            <TerminalSend
              key={s.id}
              draftKey={`${demo ? 'demo' : 'live'}:${s.id}`}
              chat
              target={live}
              enabled={terminalSend}
              privacy={privacy}
              onJump={api.jump ? () => void resume() : undefined}
              onSend={async (text, replaceDraft) => {
                const id = s.id;
                const startedAt = Date.now();
                const result = await sendFollowUp(id, text, replaceDraft, notify);
                if (result.status === 'sent') {
                  markSent(id);
                  remember(id, text, startedAt);
                }
                return result;
              }}
            />
          ) : (
            // In a browser nothing is typed into terminals: no note about it either.
            api.send && (
              <p className="terminal-send-hint">
                <Terminal size={12} />
                {t.inspector.card.noTarget}
              </p>
            )
          )}
        </div>
      </aside>
      {handoffModal}
    </>
  );
}
