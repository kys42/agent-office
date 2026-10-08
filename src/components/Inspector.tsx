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
import { ArtifactCards } from './ArtifactCards';
import { sessionName, parentSession } from '../shared/office';
import { NowCard, nowState } from './NowCard';
import { unreadNoticeCount } from '../shared/notices';
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
}) {
  const { t } = useI18n();
  const [s, setS] = useState(session);
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
  // The office's view of this colleague (status, zone, return, the latest events) follows every
  // snapshot; the whole conversation is fetched again only when the conversation changed.
  useEffect(() => {
    setS((previous) =>
      previous.id === session.id
        ? {
            ...previous,
            ...session,
            events: [
              ...new Map([...previous.events, ...session.events].map((e) => [e.id, e])).values(),
            ]
              .sort((a, b) => a.at - b.at)
              .slice(-180),
          }
        : session,
    );
  }, [session]);
  // The few latest events the office carries, by content: a fresh snapshot with the same events
  // (a new array each time) must not fetch the whole conversation again.
  const latestEvents = JSON.stringify(session.events);
  useEffect(() => {
    let valid = true;
    setLoadError('');
    if (!demo)
      api
        .detail(session.id)
        .then((s) => {
          if (valid) setS(s);
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
  // Pinning belongs to the colleague: a persona is pinned when any of its runs is.
  const colleague = resident ?? s;
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
        {petOpen && (
          <PetCustomizer
            key={session.id}
            provider={session.provider}
            session={session}
            onPrefs={onPrefs}
            onClose={() => setPetOpen(false)}
          />
        )}
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
                  {sessionScopeLabel(run)} · {privacy ? t.inspector.hiddenRecord : sessionName(run)}{' '}
                  · {ago(run.updatedAt)}
                </option>
              ))}
            </select>
          </label>
        )}
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
        <div className="inspector-tabs" role="tablist" aria-label={t.inspector.tabsLabel}>
          {(['history', 'news', 'overview', 'notes'] as const).map((key) => (
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
              sessions={sessions}
              privacy={privacy}
              onReceipt={onReceipt}
            />
          ) : tab === 'overview' ? (
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
                      ? t.inspector.usage.costDetail(
                          s.cost.priced,
                          s.cost.unpriced,
                          compact(s.cost.tokens),
                        )
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
                        {Math.min(
                          100,
                          Math.round((s.usage.contextUsed / s.usage.contextWindow) * 100),
                        )}
                        %
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
          ) : tab === 'history' ? (
            <Conversation key={s.id} session={s} notices={news} notify={notify} />
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
      </aside>
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
}
