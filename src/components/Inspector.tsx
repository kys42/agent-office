import { branchInfo } from '../shared/branch';
import { useEffect, useState, useCallback, useRef } from 'react';
import {
  X,
  Pin,
  ExternalLink,
  Folder,
  GitBranch,
  Clock,
  Copy,
  PackageOpen,
  Check,
  Pencil,
  Archive,
  RefreshCw,
  ArrowRight,
  FileText,
  Download,
  Terminal,
  LayoutGrid,
  Maximize2,
  Sparkles,
} from 'lucide-react';
import type {
  Session,
  SessionPatch,
  Handoff,
  OfficeNotice,
  ZoneRule,
  Preferences,
} from '../shared/types';
import { PetCustomizer } from './PetCustomizer';
import { MOODS, PROVIDERS } from '../shared/types';
import { sessionScopeLabel } from '../shared/residents';
import { Sprite } from './Sprite';
import { Modal } from './Modal';
import { ago, compact, shortPath, time, date } from '../lib/format';
import { api, isDesktop } from '../lib/api';
import { copyText, jumpOrCopy } from '../lib/resume';
import { Conversation } from './Conversation';
import {
  freshConversation,
  mergeLive,
  mergeNewest,
  prependPage,
} from '../shared/conversation-pages';
import { ArtifactCards } from './ArtifactCards';
import { sessionName, parentSession } from '../shared/office';
import { NowCard, nowState } from './NowCard';
import { isInboxNotice, unreadNoticeCount } from '../shared/notices';
import { CardMenu } from './CardMenu';
import { NewsFeed, type ReceiptHandler } from './News';
import { presentSession, PHASE_LABELS } from '../shared/presentation';
import { zoneLabel } from '../shared/zones';
import { ZoneEditor } from './ZoneEditor';
import { TerminalSend } from './TerminalSend';
import { useSendTargets } from '../lib/useSendTargets';
import { useI18n } from '../lib/i18n';
import { intlLocale } from '../shared/i18n';
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
  variant = 'panel',
}: {
  session: Session;
  sessions: Session[];
  notices: OfficeNotice[];
  /** All runs of the colleague in the room, so the now card matches the roster. */
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
  /**
   * `card`: the dock's pop-up card reads like a chat — one header line with a menu, the details
   * folded at the top, the conversation, and a chat box at the bottom. The office panel is `panel`.
   */
  variant?: 'panel' | 'card';
}) {
  const card = variant === 'card';
  const { t } = useI18n();
  // The pages of the conversation read so far, with the office's live view of the colleague.
  const [view, setView] = useState(() => freshConversation(session));
  const s = view.session;
  const panelRef = useRef<HTMLElement>(null);
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
  // The card's details fold, remembered across cards.
  const [infoOpen, setInfoOpen] = useState(() => {
    try {
      return localStorage.getItem('office:card-info') === 'open';
    } catch {
      return false;
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
  const locatable = !demo && (session.provider === 'claude' || session.provider === 'codex');
  const { targets, markSent } = useSendTargets(locatable ? [session.id] : [], {
    enabled: locatable,
    stamp: session.updatedAt,
  });
  const live = targets[session.id] ?? null;
  const closePacket = useCallback(() => setPacket(null), []);
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
  const members = new Set(memberIds ?? [s.id]);
  const colleagueNews = notices.filter((n) => members.has(n.sessionId) || n.sessionId === s.id);
  const state = nowState(s, colleagueNews);
  const resumeLabel = live?.canFocus
    ? t.terminal.jumpTo(live.kind === 'orca' ? 'Orca' : 'tmux')
    : live?.kind === 'codex'
      ? t.inspector.copyResume
      : s.provider === 'codex' && isDesktop
        ? t.inspector.openInCodex
        : t.inspector.copyResume;
  const resume = async () => {
    try {
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
  // What and where it works, its usage and its source: a tab in the office, a fold in the card.
  const overview = (
    <>
      <p className="activity-evidence">
        {t.inspector.overview.currentStatus} · {s.statusReason}
      </p>
      <p className="activity-evidence">
        {t.inspector.overview.lastRun} · {PHASE_LABELS[presentation.runtime.phase]} ·{' '}
        {ago(presentation.runtime.at)}
        {presentation.stale ? t.inspector.overview.staleRun : ''}
        <br />
        {presentation.runtime.reason}
      </p>
      {s.relation?.role && (
        <p className="activity-evidence">
          {t.inspector.overview.role} · {s.relation.role}
        </p>
      )}
      <section className="detail-section">
        <h3>{t.inspector.overview.whereTitle}</h3>
        <dl>
          <div>
            <dt>
              <Folder size={14} />
              {t.inspector.overview.project}
            </dt>
            <dd>{s.project}</dd>
          </div>
          <div>
            <dt>
              <LayoutGrid size={14} />
              {t.inspector.overview.zone}
            </dt>
            <dd>
              {s.area
                ? t.inspector.overview.zoneCustom(zoneLabel(s))
                : t.inspector.overview.zoneByProject(s.project)}
            </dd>
          </div>
          <div>
            <dt>
              <GitBranch size={14} />
              {t.inspector.overview.branch}
            </dt>
            <dd title={branchInfo(s).detail}>{branchInfo(s).label}</dd>
          </div>
          <div>
            <dt>
              <Clock size={14} />
              {t.inspector.overview.lastActive}
            </dt>
            <dd>
              {date(s.updatedAt)} {time(s.updatedAt)}
            </dd>
          </div>
        </dl>
        <button
          className="path-copy"
          onClick={() => copy(s.cwd ?? '')}
          disabled={!s.cwd}
          title={s.cwd ?? ''}
        >
          <code>{shortPath(s.cwd)}</code>
          <Copy size={13} />
        </button>
        <p className="fine-print">{t.inspector.overview.startPathNote}</p>
      </section>
      {s.workingLocation && (
        <section className="detail-section working-location">
          <h3>{t.inspector.overview.workingTitle}</h3>
          <code>{s.workingLocation.path}</code>
          <p>
            {
              {
                'file-edit': t.inspector.overview.fileEdit,
                'git-write': t.inspector.overview.gitWrite,
                'tool-workdir': t.inspector.overview.toolWorkdir,
                'shell-cd': t.inspector.overview.explicitCd,
              }[s.workingLocation.source]
            }{' '}
            · {new Date(s.workingLocation.at).toLocaleString(intlLocale())}
          </p>
          <small>
            {s.workspace?.locationSource
              ? t.inspector.overview.repoFound
              : t.inspector.overview.repoMissing}{' '}
            {t.inspector.overview.noMoveHint}
          </small>
        </section>
      )}
      <section className="detail-section">
        <div className="section-title">
          <h3>{t.inspector.usage.title}</h3>
          <span className="small-badge">
            {s.usage.scope === 'sample'
              ? t.inspector.usage.scopeSample
              : t.inspector.usage.scopeSession}
          </span>
        </div>
        <div className="model-line">
          <span className="model-symbol">✳</span>
          <div>
            <b>{s.model || t.inspector.usage.modelMissing}</b>
            <small>{s.usage.source}</small>
          </div>
        </div>
        <div className="cost-card">
          <span>{t.inspector.usage.costLabel}</span>
          <strong>
            {s.cost?.usd != null
              ? `$${s.cost.usd.toLocaleString('en-US', { minimumFractionDigits: s.cost.usd < 0.01 ? 4 : 2, maximumFractionDigits: s.cost.usd < 0.01 ? 4 : 2 })}`
              : t.inspector.usage.costUnknown}
          </strong>
          <b>{t.inspector.usage.costBasis}</b>
          <small>
            {s.cost
              ? t.inspector.usage.costDetail(s.cost.priced, s.cost.unpriced, compact(s.cost.tokens))
              : t.inspector.usage.costPending}
          </small>
          <p>{t.inspector.usage.costDisclaimer}</p>
          <details>
            <summary>{t.inspector.usage.costHowTitle}</summary>
            <p>{t.inspector.usage.costHowBody}</p>
            <small>{s.cost?.rateVersion}</small>
            <p>
              <a
                href="https://developers.openai.com/api/docs/pricing"
                target="_blank"
                rel="noreferrer"
              >
                {t.inspector.usage.openaiPricing}
              </a>{' '}
              ·{' '}
              <a
                href="https://platform.claude.com/docs/en/about-claude/pricing"
                target="_blank"
                rel="noreferrer"
              >
                {t.inspector.usage.claudePricing}
              </a>
            </p>
          </details>
        </div>
        <div className="usage-grid">
          <div>
            <span>{t.inspector.usage.inputTokens}</span>
            <strong>{compact(s.usage.input)}</strong>
          </div>
          <div>
            <span>{t.inspector.usage.outputTokens}</span>
            <strong>{compact(s.usage.output)}</strong>
          </div>
          <div>
            <span>{t.inspector.usage.totalTokens}</span>
            <strong>{compact(s.usage.total)}</strong>
          </div>
        </div>
        {s.usage.contextUsed !== null &&
        s.usage.contextWindow !== null &&
        s.usage.contextWindow > 0 ? (
          <div className="context">
            <div>
              <span>{t.inspector.usage.contextTitle}</span>
              <b>
                {Math.min(100, Math.round((s.usage.contextUsed / s.usage.contextWindow) * 100))}%
              </b>
            </div>
            <progress value={s.usage.contextUsed} max={s.usage.contextWindow} />
            <small>{t.inspector.usage.contextNote}</small>
          </div>
        ) : (
          <p className="fine-print">{t.inspector.usage.contextMissing}</p>
        )}
      </section>
      <section className="source-note">
        <span className="live-dot" />
        <div>
          <b>
            {s.sourceKind === 'sqlite'
              ? t.inspector.source.sqlite
              : s.sourceKind === 'demo'
                ? t.inspector.source.demo
                : t.inspector.source.log}
          </b>
          <p>{s.partial ? t.inspector.source.partial : t.inspector.source.full}</p>
          <p>{t.inspector.source.readOnly}</p>
        </div>
      </section>
    </>
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
  const relationStrip = (
    <>
      {!privacy && (
        <div className="relation-strip">
          <span title={branchInfo(s).detail}>
            <GitBranch size={12} />
            {branchInfo(s).label}
          </span>
          {parent && (
            <button onClick={() => onSelect(parent.id)}>
              {s.relation?.kind === 'fork' ? t.inspector.forkSource : t.inspector.parentTask} ·{' '}
              {sessionName(parent)}
            </button>
          )}
          {!parent && s.relation?.parentNativeId && <span>{t.inspector.parentMissing}</span>}
        </div>
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
  const nowArea = (
    <>
      <div className="inspector-now">
        <NowCard
          key={s.id}
          session={s}
          notices={colleagueNews}
          privacy={privacy}
          onReceipt={onReceipt}
          onResume={resume}
          resumeLabel={resumeLabel}
          canResume={!demo}
          canType={!!live && terminalSend}
          typeQueues={!!live?.queues}
          onShowNews={() => setTab('news')}
        />
        {live && (
          <TerminalSend
            key={s.id}
            target={live}
            enabled={terminalSend}
            privacy={privacy}
            onSend={async (text) => {
              const id = s.id;
              notify(await api.send!(id, text));
              markSent(id);
            }}
          />
        )}
      </div>
    </>
  );
  const tabBar = (
    <>
      <div className="inspector-tabs" role="tablist" aria-label={t.inspector.tabsLabel}>
        {(card
          ? (['history', 'news', 'notes'] as const)
          : (['history', 'news', 'overview', 'notes'] as const)
        ).map((key) => (
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
            {key === 'notes' && s.notes && <i />}
          </button>
        ))}
      </div>
    </>
  );
  const scrollArea = (
    <>
      <div className={`inspector-scroll ${tab === 'news' ? 'news-tab-scroll' : ''}`}>
        {!privacy && children.length > 0 && (
          <details className="related-runs">
            <summary>{t.inspector.linkedRuns(children.length)}</summary>
            {children.map((child) => (
              <button key={child.id} onClick={() => onSelect(child.id)}>
                {child.relation?.kind === 'fork' ? t.inspector.fork : sessionScopeLabel(child)} ·{' '}
                {sessionName(child)}
              </button>
            ))}
          </details>
        )}
        {loadError && <div className="inline-error">{loadError}</div>}

        {(tab === 'history' || tab === 'overview') && (
          <ArtifactCards
            id={s.id}
            urls={s.artifacts}
            demo={demo}
            privacy={privacy}
            notify={notify}
          />
        )}

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
          overview
        ) : tab === 'history' ? (
          <Conversation
            key={s.id}
            session={s}
            notices={conversationNotices}
            older={view.older}
            loadingOlder={loadingOlder}
            onOlder={loadOlder}
            notify={notify}
            compact={card}
          />
        ) : (
          <div className="notes-editor">
            <span className="eyebrow">{t.inspector.notes.eyebrow}</span>
            <h3>{t.inspector.notes.title}</h3>
            <p>{t.inspector.notes.body}</p>
            <label className="sr-only" htmlFor="notes">
              {t.inspector.notes.label}
            </label>
            <textarea
              id="notes"
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                setNotesDirty(true);
              }}
              maxLength={12000}
              placeholder={t.inspector.notes.placeholder}
            />
            <button className="button primary" onClick={() => patch({ notes })}>
              <Check size={16} />
              {t.inspector.notes.save}
            </button>
            <button
              className={`completion-button ${s.completed ? 'checked' : ''}`}
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
  const actionBar = (
    <>
      <div className="inspector-actions">
        {s.zone && s.zone !== 'office' && (
          <button className="return-office" onClick={() => onReturn(s.id)}>
            {t.inspector.returnToOffice} <ArrowRight size={14} />
          </button>
        )}
        {state === 'attention' ? (
          <button className="button primary" onClick={resume} disabled={demo}>
            <Terminal size={16} />
            {resumeLabel}
            <ArrowRight size={16} />
          </button>
        ) : (
          <button className="button primary" onClick={handoff} disabled={busy || privacy}>
            <PackageOpen size={17} />
            {busy ? t.inspector.gathering : t.inspector.packHandoff}
            <ArrowRight size={16} />
          </button>
        )}
        <div>
          {state === 'attention' ? (
            <button className="button subtle" onClick={handoff} disabled={busy || privacy}>
              <PackageOpen size={14} />
              {busy ? t.inspector.gathering : t.inspector.packHandoff}
            </button>
          ) : (
            <button className="button subtle" disabled={demo} onClick={resume}>
              <Terminal size={14} />
              {resumeLabel}
            </button>
          )}
          <button
            className="icon-btn"
            aria-label={t.inspector.revealSource}
            disabled={demo || !isDesktop}
            onClick={() => api.reveal(s.id).catch((e) => notify(e.message))}
          >
            <Folder size={16} />
          </button>
          <button
            className="icon-btn"
            aria-label={s.archived ? t.inspector.unarchive : t.inspector.archive}
            onClick={() => patch({ archived: !s.archived })}
          >
            <Archive size={16} />
          </button>
        </div>
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
  if (card) {
    const unread = colleagueNews.filter((n) => !n.seenAt && isInboxNotice(n));
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
    return (
      <>
        <aside
          className="inspector inspector-card"
          aria-label={t.inspector.label}
          ref={panelRef}
          tabIndex={-1}
        >
          <div className="card-head">
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
                </h2>
              )}
              <span className="card-status">
                <i style={{ background: MOODS[s.status].color }} />
                {MOODS[s.status].label} · {ago(s.updatedAt)}
                {colleague.pinned && <Pin size={10} />}
              </span>
            </div>
            {state === 'attention' && (
              // Waiting for the person (e.g. a permission prompt the chat box cannot answer):
              // straight to its terminal.
              <button
                className="card-chip tone-attention"
                aria-label={`${t.inspector.card.calling} · ${resumeLabel}`}
                title={resumeLabel}
                disabled={demo}
                onClick={resume}
              >
                {t.inspector.card.calling}
              </button>
            )}
            {unread.length > 0 && (
              <button
                className="card-chip tone-news"
                aria-label={`${t.inspector.card.unread(unread.length)} · ${t.inspector.card.markRead}`}
                title={t.inspector.card.markRead}
                onClick={() =>
                  onReceipt(
                    unread.map(({ id, version }) => ({ id, version })),
                    'read',
                  )
                }
              >
                {t.inspector.card.unread(unread.length)}
              </button>
            )}
            <div className="card-head-tools">
              {onExpand && (
                <button
                  className="icon-btn"
                  aria-label={t.inspector.expand}
                  title={t.inspector.expandTitle}
                  onClick={onExpand}
                >
                  <Maximize2 size={14} />
                </button>
              )}
              <CardMenu label={t.inspector.card.more}>
                {(close) => (
                  <>
                    {item(
                      busy ? t.inspector.gathering : t.inspector.packHandoff,
                      handoff,
                      close,
                      busy || privacy,
                    )}
                    {item(resumeLabel, resume, close, demo)}
                    {s.zone &&
                      s.zone !== 'office' &&
                      item(t.inspector.returnToOffice, () => onReturn(s.id), close)}
                    {item(
                      colleague.pinned ? t.inspector.unpin : t.inspector.pin,
                      () => onPin(colleague),
                      close,
                    )}
                    {item(t.inspector.rename, () => setEditing(true), close)}
                    {item(t.pets.individualTitle, () => setPetOpen(true), close)}
                    {!privacy &&
                      onZoneRules &&
                      item(t.inspector.zone, () => setZoneOpen(true), close)}
                    {item(
                      t.inspector.revealSource,
                      () => void api.reveal(s.id).catch((e) => notify(e.message)),
                      close,
                      demo || !isDesktop,
                    )}
                    {item(
                      s.archived ? t.inspector.unarchive : t.inspector.archive,
                      () => void patch({ archived: !s.archived }),
                      close,
                    )}
                  </>
                )}
              </CardMenu>
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
          {petEditor}
          {zoneEditor}
          {/* While sharing the screen the details stay hidden; the run picker (names masked) stays. */}
          {privacy && personaPicker}
          {!privacy && (
            <details
              className="card-workinfo"
              open={infoOpen}
              onToggle={(e) => {
                const open = (e.currentTarget as HTMLDetailsElement).open;
                setInfoOpen(open);
                try {
                  localStorage.setItem('office:card-info', open ? 'open' : 'closed');
                } catch {
                  // Remembering is a convenience.
                }
              }}
            >
              <summary>
                {t.inspector.card.workInfo}
                <small>
                  {s.area ? `${s.area.name} · ${s.project}` : s.project} · {branchInfo(s).label}
                </small>
              </summary>
              <div className="card-workinfo-body">
                {relationStrip}
                {personaPicker}
                {overview}
              </div>
            </details>
          )}
          {tabBar}
          {scrollArea}
          <div className="card-composer">
            {live ? (
              <TerminalSend
                key={s.id}
                chat
                target={live}
                enabled={terminalSend}
                privacy={privacy}
                onSend={async (text) => {
                  const id = s.id;
                  notify(await api.send!(id, text));
                  markSent(id);
                }}
              />
            ) : (
              <p className="terminal-send-hint">
                <Terminal size={12} />
                {t.inspector.card.noTarget}
                <button className="button subtle" disabled={demo} onClick={resume}>
                  {resumeLabel}
                </button>
              </p>
            )}
          </div>
        </aside>
        {handoffModal}
      </>
    );
  }
  return (
    <>
      <aside className="inspector" aria-label={t.inspector.label} ref={panelRef} tabIndex={-1}>
        <div className="inspector-top">
          <span className="inspector-crumb">
            <i style={{ background: PROVIDERS[s.provider].color }} />
            {PROVIDERS[s.provider].name}
            {s.agentName && !privacy ? <em> · {s.agentName}</em> : ''}
          </span>
          <div>
            <button
              className="icon-btn pet-edit-button"
              aria-label={t.pets.individualTitle}
              title={t.pets.editTitle}
              onClick={() => setPetOpen(true)}
            >
              <Sparkles size={15} />
            </button>
            <button
              className={`icon-btn ${colleague.pinned ? 'gold' : ''}`}
              aria-label={colleague.pinned ? t.inspector.unpin : t.inspector.pin}
              title={colleague.pinned ? t.inspector.unpin : t.inspector.pinTitle}
              onClick={() => onPin(colleague)}
            >
              <Pin size={15} />
            </button>
            {onExpand && (
              <button
                className="icon-btn"
                aria-label={t.inspector.expand}
                title={t.inspector.expandTitle}
                onClick={onExpand}
              >
                <Maximize2 size={15} />
              </button>
            )}
            <button
              className="icon-btn"
              aria-label={t.inspector.close}
              title={t.inspector.closeTitle}
              onClick={onClose}
            >
              <X size={17} />
            </button>
          </div>
        </div>
        <div className="inspector-heading">
          <div className={`profile-avatar face-${s.provider} status-${s.status}`}>
            <Sprite session={s} provider={s.provider} mood={s.status} size={64} />
          </div>
          <div className="inspector-title">
            {editing ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await patch({ alias });
                  setEditing(false);
                }}
                className="name-editor"
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
                  <Check size={17} />
                </button>
              </form>
            ) : (
              <h2>
                {privacy ? t.inspector.hiddenTeammate : sessionName(s)}
                <button
                  className="icon-btn"
                  aria-label={t.inspector.rename}
                  title={t.inspector.renameTitle}
                  onClick={() => setEditing(true)}
                >
                  <Pencil size={12} />
                </button>
              </h2>
            )}
            <p className="inspector-project">
              <Folder size={12} />
              <span>
                {privacy
                  ? t.inspector.projectHidden
                  : s.area
                    ? `${s.area.name} · ${s.project}`
                    : s.project}
              </span>
              {!privacy && onZoneRules && (
                <button
                  className={`zone-trigger ${zoneOpen ? 'active' : ''}`}
                  aria-expanded={zoneOpen}
                  title={t.inspector.zoneTitle}
                  onClick={() => setZoneOpen((v) => !v)}
                >
                  <LayoutGrid size={11} />
                  {t.inspector.zone}
                </button>
              )}
              {s.alias && !privacy && (
                <span title={s.title}>
                  {t.inspector.originalName} · {s.title}
                </span>
              )}
            </p>
            <div className="status-line">
              <span className={`status-pill pill-${s.status}`}>
                <i style={{ background: MOODS[s.status].color }} />
                {MOODS[s.status].label}
              </span>
              <span>
                {ago(s.updatedAt)} ·{' '}
                {s.statusEvidence === 'derived'
                  ? t.inspector.evidenceDerived
                  : t.inspector.evidenceObserved}
              </span>
            </div>
          </div>
        </div>
        {petEditor}
        {zoneEditor}
        {relationStrip}
        {personaPicker}
        {nowArea}
        {tabBar}
        {scrollArea}
        {actionBar}
      </aside>
      {handoffModal}
    </>
  );
}
