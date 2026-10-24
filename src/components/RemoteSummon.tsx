import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Terminal } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Modal } from './Modal';
import type { Session } from '../shared/types';
import type { RemoteLaunchInfo, RemoteLaunchSpec } from '../shared/remote-launch';

export function RemoteSummon({
  projects,
  privacy,
  notify,
}: {
  projects: Session[];
  privacy: boolean;
  notify: (message: string) => void;
}) {
  const {
    t: { tmux: t },
  } = useI18n();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState(projects[0].id);
  const [spec, setSpec] = useState<RemoteLaunchSpec>({
    provider: 'claude',
    host: 'tmux',
    name: t.summonDefault,
    initialMessage: '',
  });
  const [info, setInfo] = useState<RemoteLaunchInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ticket = useRef(0);
  const current = projects.find((p) => p.id === id);
  const ids = projects.map((p) => p.id).join('\n');
  useEffect(() => {
    if (!current || privacy) {
      ticket.current++;
      setOpen(false);
      setInfo(null);
      setBusy(false);
      if (!current) setId(projects[0].id);
    }
  }, [ids, privacy, current, projects]);
  const change = (patch: Partial<RemoteLaunchSpec>) => {
    setSpec({ ...spec, ...patch });
    setInfo(null);
    setError('');
  };
  const act = async (phase: 'status' | 'start') => {
    if (busy || !current || !api.remoteLaunch) return;
    const n = ++ticket.current;
    setBusy(true);
    setError('');
    try {
      const result = await api.remoteLaunch(id, phase, spec);
      if (n !== ticket.current) return;
      setInfo(result);
      if (result.status === 'uncertain') setError(t.remoteUncertain);
      if (result.status === 'started' || result.status === 'running')
        notify(result.status === 'started' ? t.remoteStarted : t.remoteExisting);
    } catch (e) {
      if (n === ticket.current) {
        setError((e as Error).message);
        // A timed-out start may have succeeded; require closing and checking the host.
        setInfo(phase === 'start' && info ? { ...info, status: 'uncertain' } : null);
      }
    } finally {
      if (n === ticket.current) setBusy(false);
    }
  };
  const done = !!info && ['started', 'running', 'uncertain'].includes(info.status);
  const close = () => {
    if (!busy) {
      ticket.current++;
      setOpen(false);
    }
  };
  return (
    <>
      <button
        className="project-summon-button"
        data-solid
        aria-label={t.remoteTitle}
        title={t.remoteTitle}
        disabled={privacy || !current?.remote?.send || current.remote.stale}
        onClick={() => {
          setOpen(true);
          setInfo(null);
          setError('');
        }}
      >
        <Plus size={15} />
      </button>
      {open &&
        !privacy &&
        createPortal(
          <Modal title={t.remoteTitle} onClose={close}>
            <div className="tmux-resume" data-solid>
              <div className="tmux-intro">
                <span className="tmux-intro-icon">
                  <Terminal size={20} />
                </span>
                <p>
                  {current?.remote?.label} · {t.summonDescription}
                </p>
              </div>
              <section className="summon-form" aria-label={t.agentSettings}>
                <label className="summon-field">
                  <span>{t.folder}</span>
                  <select
                    aria-label={t.folder}
                    disabled={busy}
                    value={id}
                    onChange={(e) => {
                      setId(e.target.value);
                      setInfo(null);
                      setError('');
                    }}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.remote?.label} · {p.project}
                        {p.branch ? ` · ${p.branch}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="summon-field">
                  <span>{t.agentType}</span>
                  <select
                    aria-label={t.agentType}
                    disabled={busy}
                    value={spec.provider}
                    onChange={(e) =>
                      change({ provider: e.target.value as RemoteLaunchSpec['provider'] })
                    }
                  >
                    <option value="claude">Claude</option>
                    <option value="codex">Codex</option>
                  </select>
                </label>
                <label className="summon-field">
                  <span>{t.remoteHost}</span>
                  <select
                    aria-label={t.remoteHost}
                    disabled={busy}
                    value={spec.host}
                    onChange={(e) => change({ host: e.target.value as RemoteLaunchSpec['host'] })}
                  >
                    {(['tmux', 'orca'] as const).map((host) => (
                      <option key={host} value={host}>
                        {host === 'orca' ? 'Orca' : 'tmux'}
                        {info && !info.hosts[host] ? ` · ${t.remoteMissing}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="summon-field">
                  <span>{t.agentName}</span>
                  <input
                    disabled={busy}
                    maxLength={40}
                    value={spec.name}
                    onChange={(e) => change({ name: e.target.value })}
                  />
                </label>
                <label className="summon-field">
                  <span>{t.initialMessage}</span>
                  <textarea
                    disabled={busy}
                    rows={3}
                    maxLength={4000}
                    value={spec.initialMessage}
                    placeholder={t.messagePlaceholder}
                    onChange={(e) => change({ initialMessage: e.target.value })}
                  />
                </label>
              </section>
              <p>{t.remoteHint}</p>
              {info && (
                <div className="summon-connections">
                  <p>
                    {info.office} · {info.cwd}
                  </p>
                  <p>
                    {info.status === 'started'
                      ? t.remoteStarted
                      : info.status === 'running'
                        ? t.remoteExisting
                        : info.hosts[spec.host]
                          ? t.summonReady
                          : t.remoteMissing}
                  </p>
                </div>
              )}
              {error && (
                <p className="tmux-error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="tmux-resume-actions" data-solid>
              <button className="button" disabled={busy} onClick={close}>
                {t.cancel}
              </button>
              {!done && (
                <button
                  className="button"
                  disabled={busy || !spec.name.trim()}
                  onClick={() => void act('status')}
                >
                  {busy ? t.loading : t.summonCheck}
                </button>
              )}
              {!done && (
                <button
                  className="button primary"
                  disabled={busy || !info?.hosts[spec.host]}
                  onClick={() => void act('start')}
                >
                  {t.remoteStart}
                </button>
              )}
            </div>
          </Modal>,
          document.body,
        )}
    </>
  );
}
