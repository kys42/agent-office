import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Terminal } from 'lucide-react';
import { Modal } from './Modal';
import { api } from '../lib/api';
import { copyText, jumpOrCopy } from '../lib/resume';
import { useI18n } from '../lib/i18n';
import type { Session, TmuxResumeInfo } from '../shared/types';

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
  const text = summon
    ? {
        ...t.tmux,
        title: t.tmux.summonTitle,
        intro: t.tmux.summonIntro,
        ready: t.tmux.summonReady,
        start: t.tmux.summonStart,
        hint: t.tmux.summonHint,
      }
    : t.tmux;
  const [projectId, setProjectId] = useState(id);
  const [agentName, setAgentName] = useState(t.tmux.summonDefault);
  const [provider, setProvider] = useState<'claude' | 'codex'>('claude');
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<TmuxResumeInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open && !busy && document.activeElement === document.body)
      body.current?.closest<HTMLElement>('[role=dialog]')?.focus();
  }, [open, busy, info]);
  useEffect(() => {
    if (privacy) setOpen(false);
  }, [privacy]);
  const act = async (action: 'status' | 'start' | 'open', selected = provider) => {
    if (busy || (summon ? !api.tmuxSummon : !api.tmuxResume)) return;
    setBusy(true);
    setError('');
    try {
      setInfo(
        summon
          ? await api.tmuxSummon!(projectId, action, selected, agentName)
          : await api.tmuxResume!(id, action),
      );
    } catch (e) {
      if (action !== 'open') setInfo(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
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
              <p>{text.intro}</p>
              {summon && (
                <>
                  {projects && (
                    <label className="summon-field">
                      {text.folder}
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
                    {text.agentName}
                    <input
                      disabled={busy}
                      maxLength={40}
                      value={agentName}
                      onChange={(e) => {
                        setAgentName(e.target.value);
                        setInfo(null);
                      }}
                    />
                  </label>
                  <p>{text.nameHint}</p>
                </>
              )}
              {summon && (
                <div role="group" aria-label="Claude / Codex" className="tmux-resume-actions">
                  {(['claude', 'codex'] as const).map((value) => (
                    <button
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
                    </button>
                  ))}
                </div>
              )}
              {!!info?.connections?.length && (
                <section className="summon-connections">
                  <strong>{text.existingTitle}</strong>
                  {info.connections.map((c) => (
                    <div key={c.id ?? c.command}>
                      <span>
                        {c.name} · {c.label}
                      </span>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void (
                            c.id ? jumpOrCopy(c.id, notify) : copyText(c.command!, notify)
                          ).catch((e) => setError(e.message))
                        }
                      >
                        {c.id ? text.existingOpen : text.copy}
                      </button>
                    </div>
                  ))}
                </section>
              )}
              {info && (
                <>
                  <strong role="status">{info.running ? text.running : text.ready}</strong>
                  <dl>
                    <dt>{text.name}</dt>
                    <dd>
                      <code>{info.name}</code>
                    </dd>
                    <dt>{text.folder}</dt>
                    <dd>{info.cwd}</dd>
                    <dt>{text.command}</dt>
                    <dd>
                      <code>{info.command}</code>
                    </dd>
                  </dl>
                  <p>{text.hint}</p>
                  {!summon && !info.running && <p>{text.caution}</p>}
                </>
              )}
              {error && <p role="alert">{error}</p>}
            </div>
            <div className="tmux-resume-actions" data-solid>
              {info && !info.running && (
                <button disabled={busy} onClick={() => void act('start')}>
                  {text.start}
                </button>
              )}
              {info?.running && info.canOpen && (
                <button disabled={busy} onClick={() => void act('open')}>
                  {text.open}
                </button>
              )}
              {info?.running && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void copyText(info.command, notify).catch((e) => setError(e.message))
                  }
                >
                  {text.copy}
                </button>
              )}
              <button disabled={busy} onClick={() => void act('status')}>
                {busy ? text.loading : summon ? text.summonCheck : text.refresh}
              </button>
            </div>
          </Modal>,
          document.body,
        )}
    </>
  );
}
