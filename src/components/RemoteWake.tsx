import { useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { RemoteLaunchInfo } from '../shared/remote-launch';

const hosts = { desktop: 'Codex Desktop', tmux: 'tmux', orca: 'Orca' } as const;
type Host = keyof typeof hosts;

export function RemoteWake({
  id,
  notify,
  refresh,
}: {
  id: string;
  notify: (message: string) => void;
  refresh: () => void;
}) {
  const {
    t: { tmux: t },
  } = useI18n();
  const [choices, setChoices] = useState<RemoteLaunchInfo['hosts'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const ticket = useRef(0);
  useEffect(
    () => () => {
      ticket.current++;
    },
    [],
  );
  const act = async (host?: Host) => {
    if (busy || !api.remoteLaunch) return;
    const n = ++ticket.current;
    setBusy(true);
    setNote('');
    try {
      const result = await api.remoteLaunch(id, host ? 'start' : 'status', {
        resume: true,
        provider: 'codex',
        host: host ?? 'desktop',
      });
      if (n !== ticket.current) return;
      if (!host) {
        if (Object.values(result.hosts).some(Boolean)) setChoices(result.hosts);
        else setNote(t.wakeMissing);
      } else if (result.status !== 'cancelled') {
        setChoices(null);
        if (result.status === 'started' || result.status === 'running') notify(t.wakeReady);
        else setNote(t.wakeUncertain);
        refresh();
      }
    } catch (e) {
      if (n === ticket.current) {
        setChoices(null);
        setNote(host ? t.wakeUncertain : (e as Error).message);
        if (host) refresh();
      }
    } finally {
      if (n === ticket.current) setBusy(false);
    }
  };
  return (
    <>
      {choices ? (
        <>
          {(Object.keys(hosts) as Host[])
            .filter((host) => choices[host])
            .map((host) => (
              <button
                className="card-action"
                data-solid
                key={host}
                disabled={busy}
                onClick={() => void act(host)}
              >
                {hosts[host]} · {t.wake}
              </button>
            ))}
          <button
            className="card-action"
            data-solid
            disabled={busy}
            onClick={() => setChoices(null)}
          >
            {t.cancel}
          </button>
        </>
      ) : (
        <button className="card-action" data-solid disabled={busy} onClick={() => void act()}>
          <RotateCcw size={13} />
          {busy ? t.loading : t.wake}
        </button>
      )}
      {note && (
        <span className="card-calling-note" role="status">
          {note}
        </span>
      )}
    </>
  );
}
