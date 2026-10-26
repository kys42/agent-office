import { useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  Info,
  LoaderCircle,
  Terminal,
  Users,
} from 'lucide-react';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { copyText, jumpOrCopy } from '../lib/resume';
import { useI18n } from '../lib/i18n';
import { residentLabel } from '../shared/office-model';
import type { AwayColleague } from '../shared/summon-existing';
import type { OrcaLaunchInfo, TmuxResumeInfo } from '../shared/types';

const PROVIDER: Record<string, string> = { claude: 'Claude', codex: 'Codex', openclaw: 'OpenClaw' };

/**
 * The summon sheet's second choice: a colleague of this project resting in the lounge or the
 * archive. Picking one checks the existing resume paths (tmux, and Orca when it answers); once a
 * terminal really opens, the colleague is brought back to the office with the existing
 * "bring back" (unarchive + a fresh return time). The list itself comes from the shared core.
 */
export function SummonExisting({
  colleagues,
  total,
  privacy,
  notify,
  onReturn,
  close,
}: {
  colleagues: AwayColleague[];
  total: number;
  privacy: boolean;
  notify: (message: string) => void;
  /** The existing "bring back to the office" (store `returnToOffice`). */
  onReturn: (id: string) => unknown;
  close: () => void;
}) {
  const { t } = useI18n();
  const text = t.summonExisting;
  // Kept as picked: once brought back, the colleague leaves this list but the panel stays.
  const [chosen, setChosen] = useState<AwayColleague | null>(null);
  const [info, setInfo] = useState<TmuxResumeInfo | null>(null);
  const [orca, setOrca] = useState<OrcaLaunchInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const returned = useRef(new Set<string>());
  const bringBack = async (id: string) => {
    if (returned.current.has(id)) return;
    returned.current.add(id);
    await onReturn(id);
  };
  const run = async <T,>(work: (ticket: number) => Promise<T>) => {
    if (busy) return;
    const ticket = ++request.current;
    setBusy(true);
    setError('');
    try {
      await work(ticket);
    } catch (e) {
      if (ticket === request.current) setError((e as Error).message);
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  };
  const pick = (c: AwayColleague) => {
    if (c.block || !api.tmuxResume) return;
    request.current++;
    setChosen(c);
    setInfo(null);
    setOrca(null);
    setError('');
    setBusy(false);
    const id = c.session.id;
    void run(async (ticket) => {
      // Independent checks: a missing tmux must not hide a working Orca, nor the other way round.
      const [tmux, launch] = await Promise.allSettled([
        api.tmuxResume!(id, 'status'),
        api.orcaLaunch ? api.orcaLaunch(id, 'status') : Promise.resolve(null),
      ]);
      if (ticket !== request.current) return;
      setInfo(tmux.status === 'fulfilled' ? tmux.value : null);
      setOrca(launch.status === 'fulfilled' ? launch.value : null);
      if (tmux.status === 'rejected') throw tmux.reason;
    });
  };
  const tmux = (action: 'start' | 'open') =>
    chosen &&
    run(async (ticket) => {
      const id = chosen.session.id;
      const result = await api.tmuxResume!(id, action);
      if (ticket !== request.current) return;
      setInfo(result);
      // A cancelled confirmation leaves it where it was.
      if (result.running) await bringBack(id);
    });
  const launchOrca = () =>
    chosen &&
    run(async (ticket) => {
      const id = chosen.session.id;
      const result = await api.orcaLaunch!(id, 'start');
      if (ticket !== request.current || !result.launched) return;
      await bringBack(id);
      notify(result.message ?? t.tmux.orcaLaunched);
      close();
    });
  const jump = (id: string) =>
    chosen &&
    run(async () => {
      // A vanished terminal only copies the resume command: nothing opened, nobody comes back.
      if ((await jumpOrCopy(id, notify)) !== 'copy') await bringBack(chosen.session.id);
    });
  const label = (c: AwayColleague) => residentLabel(c.session, privacy).name;
  const live = info?.connections?.filter((c) => c.id) ?? [];
  if (!total && !chosen) return null;
  return (
    <details className="summon-existing">
      <summary>
        <Users size={14} aria-hidden="true" />
        <span>{text.title}</span>
        <small>{text.count(total)}</small>
        <ChevronDown size={13} aria-hidden="true" />
      </summary>
      <p className="summon-existing-intro">{text.description}</p>
      <ul className="summon-existing-list" aria-label={text.title}>
        {colleagues.map((c) => {
          const s = c.session;
          const reason = c.block ? text.blocked[c.block] : undefined;
          return (
            <li key={s.id}>
              <button
                type="button"
                className="summon-existing-row"
                aria-pressed={chosen?.session.id === s.id}
                disabled={!!c.block || busy || !api.tmuxResume}
                title={reason}
                onClick={() => pick(c)}
              >
                <span className="summon-existing-name">
                  <b>{label(c)}</b>
                  <small>
                    {PROVIDER[s.provider] ?? s.provider} · {text.active(ago(s.updatedAt))}
                  </small>
                  {reason && <small className="summon-existing-reason">{reason}</small>}
                </span>
                <span className="summon-existing-zone" data-zone={c.zone}>
                  {text.zone[c.zone]}
                </span>
                {chosen?.session.id === s.id && <Check size={13} aria-hidden="true" />}
              </button>
            </li>
          );
        })}
      </ul>
      {total > colleagues.length && (
        <p className="summon-existing-more">{text.more(total - colleagues.length)}</p>
      )}
      {chosen && (
        <section className="summon-existing-chosen" aria-label={text.chosen}>
          <div className="tmux-session-status" role="status">
            {busy ? (
              <LoaderCircle size={14} className="now-spin" aria-hidden="true" />
            ) : info?.running ? (
              <Check size={15} aria-hidden="true" />
            ) : (
              <Terminal size={15} aria-hidden="true" />
            )}
            <strong>
              {label(chosen)} ·{' '}
              {busy && !info ? t.tmux.loading : info?.running ? t.tmux.running : t.tmux.ready}
            </strong>
          </div>
          <p className="tmux-caution">
            <Info size={14} aria-hidden="true" />
            {text.hint}
          </p>
          {error && (
            <p className="tmux-error" role="alert">
              <AlertCircle size={15} aria-hidden="true" />
              <span>{error}</span>
            </p>
          )}
          {(info || orca?.available) && (
            <div className="summon-existing-actions">
              {live.map((c) => (
                <button
                  key={c.id}
                  className="button"
                  disabled={busy}
                  onClick={() => void jump(c.id!)}
                >
                  <ArrowUpRight size={13} aria-hidden="true" />
                  {t.tmux.existingOpen} · {c.label}
                </button>
              ))}
              {info?.running && info.canOpen && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void tmux('open')}
                >
                  <ArrowUpRight size={13} aria-hidden="true" />
                  {t.tmux.open}
                </button>
              )}
              {/* Where Terminal cannot be opened for it (Linux), the attach command is the way in. */}
              {info?.running && (
                <button
                  className="button"
                  disabled={busy}
                  title={info.command}
                  onClick={() =>
                    void copyText(info.command, notify).catch((e) => setError(e.message))
                  }
                >
                  <Copy size={13} aria-hidden="true" />
                  {t.tmux.copy}
                </button>
              )}
              {info && !info.running && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void tmux('start')}
                >
                  <Terminal size={13} aria-hidden="true" />
                  {text.tmuxStart}
                </button>
              )}
              {orca?.available && !info?.running && (
                <button className="button" disabled={busy} onClick={() => void launchOrca()}>
                  <ArrowUpRight size={13} aria-hidden="true" />
                  {text.orcaStart}
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </details>
  );
}
