import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  Folder,
  Info,
  LoaderCircle,
  Plus,
  RotateCw,
  Terminal,
  AlertCircle,
} from 'lucide-react';
import { Modal } from './Modal';
import { api } from '../lib/api';
import { copyText, jumpOrCopy } from '../lib/resume';
import { useI18n } from '../lib/i18n';
import type { OrcaLaunchInfo, Session, TmuxResumeInfo } from '../shared/types';

export function TmuxResume({
  id,
  privacy,
  notify,
  summon = false,
  projects,
}: {
  summon?: boolean;
  projects?: Session[];
  id: string;
  privacy: boolean;
  notify: (message: string) => void;
}) {
  const { t } = useI18n();
  const fieldId = useId();
  const text = summon
    ? {
        ...t.tmux,
        title: t.tmux.summonTitle,
        ready: t.tmux.summonReady,
        running: t.tmux.summonRunning,
        start: t.tmux.summonStart,
        hint: t.tmux.summonHint,
      }
    : t.tmux;
  const [projectId, setProjectId] = useState(id);
  const [agentName, setAgentName] = useState(t.tmux.summonDefault);
  const [initialMessage, setInitialMessage] = useState('');
  const [provider, setProvider] = useState<'claude' | 'codex'>('claude');
  const body = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<TmuxResumeInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** Resuming in a new Orca tab instead (saved conversations only, when Orca answers). */
  const [orca, setOrca] = useState<OrcaLaunchInfo | null>(null);
  const orcaRequest = useRef(0);
  const checkOrca = async () => {
    if (summon || !api.orcaLaunch) return;
    const ticket = ++orcaRequest.current;
    const result = await api.orcaLaunch(id, 'status').catch(() => null);
    if (ticket === orcaRequest.current) setOrca(result);
  };
  const launchOrca = async () => {
    if (busy || summon || !api.orcaLaunch) return;
    const ticket = ++request.current;
    setBusy(true);
    setError('');
    try {
      const result = await api.orcaLaunch(id, 'start');
      if (ticket !== request.current) return;
      if (result.launched) {
        notify(result.message ?? t.tmux.orcaLaunched);
        setOpen(false);
      }
    } catch (e) {
      if (ticket !== request.current) return;
      setError((e as Error).message);
      // A refusal (e.g. it already runs) may change which buttons make sense.
      void checkOrca();
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  };
  /**
   * Whether this conversation already runs or is open elsewhere (main's duplicate-launch check;
   * main checks again before launching, this only shapes the buttons).
   */
  const duplicate = summon ? undefined : (info?.duplicate ?? orca?.duplicate);
  const runningElsewhere = duplicate?.state === 'running';
  const openElsewhere = duplicate?.state === 'open';
  const place =
    duplicate?.state === 'running' || duplicate?.state === 'open'
      ? t.tmux.place[duplicate.where]
      : '';
  const jump = () => void jumpOrCopy(id, notify).catch((e) => setError(e.message));
  const projectIds = projects?.map((p) => p.id).join('\n');
  useEffect(() => {
    const ids = projectIds?.split('\n');
    const next = ids?.length && !ids.includes(projectId) ? ids[0] : null;
    if (next) {
      request.current++;
      setProjectId(next);
      setInfo(null);
      setError('');
      setBusy(false);
    }
  }, [projectIds, projectId]);
  useEffect(() => {
    if (open && !busy && document.activeElement === document.body)
      body.current?.closest<HTMLElement>('[role=dialog]')?.focus();
  }, [open, busy, info]);
  useEffect(() => {
    if (privacy) setOpen(false);
  }, [privacy]);
  const act = async (action: 'status' | 'start' | 'open', selected = provider) => {
    if (busy || (summon ? !api.tmuxSummon : !api.tmuxResume)) return;
    if (projects && !projects.some((p) => p.id === projectId)) return;
    if (action === 'status') void checkOrca();
    const ticket = ++request.current;
    setBusy(true);
    setError('');
    try {
      const result = summon
        ? await api.tmuxSummon!(projectId, action, selected, agentName, initialMessage)
        : await api.tmuxResume!(id, action);
      if (ticket === request.current) setInfo(result);
    } catch (e) {
      if (ticket !== request.current) return;
      if (action !== 'open') setInfo(null);
      setError((e as Error).message);
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  };
  return (
    <>
      <button
        className={summon ? 'project-summon-button' : 'card-action'}
        data-solid
        aria-label={text.title}
        title={text.title}
        disabled={privacy}
        onClick={() => {
          setOpen(true);
          void act('status');
        }}
      >
        {summon ? (
          <Plus size={15} />
        ) : (
          <>
            <Terminal size={13} />
            {text.title}
          </>
        )}
      </button>
      {open &&
        !privacy &&
        createPortal(
          <Modal title={text.title} onClose={() => setOpen(false)}>
            <div className="tmux-resume" ref={body} data-solid>
              <div className="tmux-intro">
                <span className="tmux-intro-icon" aria-hidden="true">
                  <Terminal size={20} />
                </span>
                <p>{summon ? text.summonDescription : text.resumeDescription}</p>
              </div>
              {summon && (
                <section className="summon-form" aria-label={text.agentSettings}>
                  <div className="summon-field">
                    <span id={`${fieldId}-provider`}>{text.agentType}</span>
                    <div
                      role="group"
                      aria-labelledby={`${fieldId}-provider`}
                      className="summon-provider"
                    >
                      {(['claude', 'codex'] as const).map((value) => (
                        <button
                          type="button"
                          key={value}
                          disabled={busy}
                          aria-pressed={provider === value}
                          onClick={() => {
                            setProvider(value);
                            setInfo(null);
                            void act('status', value);
                          }}
                        >
                          {value === 'claude' ? 'Claude' : 'Codex'}
                          {provider === value && <Check size={13} aria-hidden="true" />}
                        </button>
                      ))}
                    </div>
                  </div>
                  {projects && (
                    <label className="summon-field">
                      <span>{text.folder}</span>
                      <select
                        disabled={busy}
                        value={projectId}
                        onChange={(e) => {
                          setProjectId(e.target.value);
                          setInfo(null);
                        }}
                      >
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.cwd}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="summon-field">
                    <span>{text.agentName}</span>
                    <input
                      disabled={busy}
                      aria-label={text.agentName}
                      maxLength={40}
                      value={agentName}
                      aria-describedby={`${fieldId}-name-help`}
                      onChange={(e) => {
                        setAgentName(e.target.value);
                        setInfo(null);
                      }}
                    />
                    <small id={`${fieldId}-name-help`}>{text.nameHint}</small>
                  </label>
                  <label className="summon-field">
                    <span>{text.initialMessage}</span>
                    <textarea
                      aria-label={text.initialMessage}
                      rows={3}
                      maxLength={4000}
                      placeholder={text.messagePlaceholder}
                      disabled={busy || !!info?.running}
                      value={initialMessage}
                      aria-describedby={`${fieldId}-message-help`}
                      onChange={(e) => setInitialMessage(e.target.value)}
                    />
                    <small id={`${fieldId}-message-help`}>{text.messageHint}</small>
                  </label>
                </section>
              )}
              {!!info?.connections?.length && (
                <section className="summon-connections" aria-label={text.existingTitle}>
                  <h3>{text.existingTitle}</h3>
                  <div className="summon-connection-list">
                    {info.connections.map((c) => (
                      <div className="summon-connection" key={c.id ?? c.command}>
                        <span>
                          {c.name} · {c.label}
                        </span>
                        <button
                          className="button"
                          disabled={busy}
                          onClick={() =>
                            void (
                              c.id ? jumpOrCopy(c.id, notify) : copyText(c.command!, notify)
                            ).catch((e) => setError(e.message))
                          }
                        >
                          <ArrowUpRight size={13} aria-hidden="true" />
                          {c.id ? text.existingOpen : text.copy}
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {info && (
                <section className="tmux-session" aria-label={text.sessionDetails}>
                  <div
                    className={`tmux-session-status ${info.running ? 'is-running' : ''}`}
                    role="status"
                  >
                    {info.running ? (
                      <Check size={15} aria-hidden="true" />
                    ) : (
                      <Terminal size={15} aria-hidden="true" />
                    )}
                    <strong>{info.running ? text.running : text.ready}</strong>
                  </div>
                  <dl className="tmux-session-details">
                    <div>
                      <dt>{text.name}</dt>
                      <dd>
                        <code>{info.name}</code>
                      </dd>
                    </div>
                    {!summon && (
                      <div>
                        <dt>{text.folder}</dt>
                        <dd>
                          <Folder size={13} aria-hidden="true" />
                          <span>{info.cwd}</span>
                        </dd>
                      </div>
                    )}
                  </dl>
                  <div className="tmux-command-row">
                    <details className="tmux-command">
                      <summary>
                        <ChevronDown size={13} aria-hidden="true" />
                        {text.command}
                      </summary>
                      <code>{info.command}</code>
                    </details>
                    {info.running && (
                      <button
                        className="button tmux-copy"
                        aria-label={text.copy}
                        title={text.copy}
                        disabled={busy}
                        onClick={() =>
                          void copyText(info.command, notify).catch((e) => setError(e.message))
                        }
                      >
                        <Copy size={14} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {summon && info.running && (
                    <p className="tmux-discovery">
                      <Info size={13} aria-hidden="true" />
                      {text.summonDiscovery}
                    </p>
                  )}
                </section>
              )}
              {busy && !info && (
                <p className="tmux-loading" role="status">
                  <LoaderCircle size={14} className="now-spin" aria-hidden="true" />
                  {text.loading}
                </p>
              )}
              {runningElsewhere && !info?.running && (
                <p className="tmux-caution" role="status">
                  <AlertCircle size={14} aria-hidden="true" />
                  {text.runningNotice(place)}
                </p>
              )}
              {openElsewhere && (
                <p className="tmux-caution" role="status">
                  <AlertCircle size={14} aria-hidden="true" />
                  {text.openNotice(place)} {text.openHint}
                </p>
              )}
              {duplicate?.state === 'unknown' && (
                <p className="tmux-caution" role="status">
                  <Info size={14} aria-hidden="true" />
                  {text.unknownNotice}
                </p>
              )}
              {!summon && orca?.available && !runningElsewhere && (
                <p className="tmux-discovery">
                  <Info size={13} aria-hidden="true" />
                  {text.orcaHint}
                </p>
              )}
              {!summon && info && !info.running && (
                <p className="tmux-caution">
                  <Info size={14} aria-hidden="true" />
                  {text.caution}
                </p>
              )}
              <details className="tmux-help">
                <summary>
                  <Info size={14} aria-hidden="true" />
                  <span>{text.guide}</span>
                  <ChevronDown size={13} aria-hidden="true" />
                </summary>
                <p>{text.hint}</p>
              </details>
              {error && (
                <p className="tmux-error" role="alert">
                  <AlertCircle size={15} aria-hidden="true" />
                  <span>{error}</span>
                </p>
              )}
            </div>
            <div className="tmux-resume-actions" data-solid>
              <button className="button subtle" disabled={busy} onClick={() => void act('status')}>
                {busy ? (
                  <LoaderCircle size={14} className="now-spin" aria-hidden="true" />
                ) : (
                  <RotateCw size={14} aria-hidden="true" />
                )}
                {busy ? text.loading : summon ? text.summonCheck : text.refresh}
              </button>
              {((runningElsewhere && !info?.running) || openElsewhere) && (
                <button className="button primary" disabled={busy} onClick={jump}>
                  <ArrowUpRight size={14} aria-hidden="true" />
                  {openElsewhere ? text.jumpToTab : text.jumpToTerminal}
                </button>
              )}
              {info && !info.running && !runningElsewhere && (
                <button
                  className={openElsewhere ? 'button' : 'button primary'}
                  disabled={busy}
                  onClick={() => void act('start')}
                >
                  {summon ? (
                    <Plus size={14} aria-hidden="true" />
                  ) : (
                    <Terminal size={14} aria-hidden="true" />
                  )}
                  {openElsewhere ? text.forceStart : text.start}
                </button>
              )}
              {!summon && orca?.available && !runningElsewhere && (
                <button className="button" disabled={busy} onClick={() => void launchOrca()}>
                  <ArrowUpRight size={14} aria-hidden="true" />
                  {openElsewhere ? text.forceOrca : text.orcaStart}
                </button>
              )}
              {info?.running && info.canOpen && (
                <button className="button primary" disabled={busy} onClick={() => void act('open')}>
                  <ArrowUpRight size={14} aria-hidden="true" />
                  {text.open}
                </button>
              )}
            </div>
          </Modal>,
          document.body,
        )}
    </>
  );
}
