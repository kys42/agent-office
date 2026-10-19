import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from 'lucide-react';
import { Modal } from './Modal';
import { api } from '../lib/api';
import { copyText } from '../lib/resume';
import { useI18n } from '../lib/i18n';
import type { TmuxResumeInfo } from '../shared/types';

export function TmuxResume({
  id,
  privacy,
  notify,
}: {
  id: string;
  privacy: boolean;
  notify: (message: string) => void;
}) {
  const { t } = useI18n();
  const text = t.tmux;
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<TmuxResumeInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (privacy) setOpen(false);
  }, [privacy]);
  const act = async (action: 'status' | 'start' | 'open') => {
    if (!api.tmuxResume || busy) return;
    setBusy(true);
    setError('');
    try {
      setInfo(await api.tmuxResume(id, action));
    } catch (e) {
      setInfo(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className="card-action"
        disabled={privacy}
        onClick={() => {
          setOpen(true);
          void act('status');
        }}
      >
        <Terminal size={13} />
        {text.title}
      </button>
      {open &&
        !privacy &&
        createPortal(
          <Modal title={text.title} onClose={() => setOpen(false)}>
            <div className="tmux-resume">
              <p>{text.intro}</p>
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
                  {!info.running && <p>{text.caution}</p>}
                </>
              )}
              {error && <p role="alert">{error}</p>}
            </div>
            <div className="tmux-resume-actions">
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
                {busy ? text.loading : text.refresh}
              </button>
            </div>
          </Modal>,
          document.body,
        )}
    </>
  );
}
