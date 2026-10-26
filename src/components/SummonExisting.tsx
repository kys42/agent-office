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
import type { DuplicateCheck, OrcaLaunchInfo, TmuxResumeInfo } from '../shared/types';

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
  /** The existing "bring back to the office" (store `returnToOffice`): true once stored. */
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
  /** Remembered only once the store confirmed it: a failed restore is tried again next time. */
  const bringBack = async (id: string): Promise<boolean> => {
    if (returned.current.has(id)) return true;
    if ((await onReturn(id)) !== true) return false;
    returned.current.add(id);
    return true;
  };
  /**
   * Main's duplicate-launch check, from whichever status answered (tmux or Orca): the answer to
   * the newest request wins, as in the resume sheet. It only shapes the buttons; main checks
   * again before any launch.
   */
  const [duplicate, setDuplicate] = useState<DuplicateCheck | undefined>();
  const duplicateRequest = useRef(0);
  const duplicateShown = useRef(0);
  const noteDuplicate = (ticket: number, value: DuplicateCheck | undefined) => {
    if (!value || ticket < duplicateShown.current) return;
    duplicateShown.current = ticket;
    setDuplicate(value);
  };
  const run = async (work: (ticket: number) => Promise<unknown>) => {
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
  /** Both status reads, independently: a missing tmux must not hide a working Orca. */
  const check = async (id: string, ticket: number) => {
    const askedOrca = ++duplicateRequest.current;
    const askedTmux = ++duplicateRequest.current;
    const [tmux, launch] = await Promise.allSettled([
      api.tmuxResume!(id, 'status'),
      api.orcaLaunch ? api.orcaLaunch(id, 'status') : Promise.resolve(null),
    ]);
    if (ticket !== request.current) return;
    if (launch.status === 'fulfilled') noteDuplicate(askedOrca, launch.value?.duplicate);
    if (tmux.status === 'fulfilled') noteDuplicate(askedTmux, tmux.value.duplicate);
    setInfo(tmux.status === 'fulfilled' ? tmux.value : null);
    setOrca(launch.status === 'fulfilled' ? launch.value : null);
    if (tmux.status === 'rejected') throw tmux.reason;
  };
  /** A refusal (e.g. it already runs) may change the buttons: read again, keep its message. */
  const refused = async (id: string, ticket: number, e: unknown) => {
    if (ticket !== request.current) return;
    await check(id, ticket).catch(() => {});
    if (ticket === request.current) throw e;
  };
  const pick = (c: AwayColleague) => {
    if (c.block || !api.tmuxResume) return;
    request.current++;
    setChosen(c);
    setInfo(null);
    setOrca(null);
    setDuplicate(undefined);
    duplicateShown.current = duplicateRequest.current;
    setError('');
    setBusy(false);
    void run((ticket) => check(c.session.id, ticket));
  };
  const tmux = (action: 'start' | 'open') =>
    chosen &&
    run(async (ticket) => {
      const id = chosen.session.id;
      let result: TmuxResumeInfo;
      try {
        result = await api.tmuxResume!(id, action);
      } catch (e) {
        if (action === 'start') return refused(id, ticket, e);
        throw e;
      }
      if (ticket !== request.current) return;
      setInfo(result);
      // A cancelled confirmation leaves it where it was.
      if (result.running) await bringBack(id);
    });
  const launchOrca = () =>
    chosen &&
    run(async (ticket) => {
      const id = chosen.session.id;
      let result: OrcaLaunchInfo;
      try {
        result = await api.orcaLaunch!(id, 'start');
      } catch (e) {
        return refused(id, ticket, e);
      }
      if (ticket !== request.current || !result.launched) return;
      // The tab is open; a failed restore keeps the sheet (its error toast stays) and re-checks,
      // so the now-running conversation offers 터미널로 이동, which tries the restore again.
      if (!(await bringBack(id))) return check(id, ++request.current);
      notify(result.message ?? t.tmux.orcaLaunched);
      close();
    });
  const jump = (id: string) =>
    chosen &&
    run(async () => {
      // A vanished terminal only copies the resume command: nothing opened, nobody comes back.
      if ((await jumpOrCopy(id, notify)) !== 'copy') await bringBack(chosen.session.id);
    });
  /** The conversation's own Orca tab, matched again in main (never a jump's fallback). */
  const focusTab = () =>
    chosen &&
    run(async (ticket) => {
      const id = chosen.session.id;
      let result: OrcaLaunchInfo;
      try {
        result = await api.orcaLaunch!(id, 'focus');
      } catch (e) {
        return refused(id, ticket, e);
      }
      if (result.message) notify(result.message);
      await bringBack(id);
    });
  const runningElsewhere = duplicate?.state === 'running';
  const openElsewhere = duplicate?.state === 'open';
  const place =
    duplicate?.state === 'running' || duplicate?.state === 'open'
      ? t.tmux.place[duplicate.where]
      : '';
  const openTab = openElsewhere && duplicate.where === 'orca' && !!api.orcaLaunch;
  // The own tmux session shows its (separately labelled) reconnect controls instead.
  const openOther = openElsewhere && !(duplicate.where === 'tmux' && info?.running);
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
          {info?.running && (
            <p className="tmux-caution">
              <Info size={14} aria-hidden="true" />
              {t.tmux.ownSessionNote}
            </p>
          )}
          {runningElsewhere && (
            <p className="tmux-caution" role="status">
              <AlertCircle size={14} aria-hidden="true" />
              {t.tmux.runningNotice(place)}
            </p>
          )}
          {openOther && (
            <p className="tmux-caution" role="status">
              <AlertCircle size={14} aria-hidden="true" />
              {t.tmux.openNotice(place)} {t.tmux.openHint}
            </p>
          )}
          {duplicate?.state === 'unknown' && (
            <p className="tmux-caution" role="status">
              <Info size={14} aria-hidden="true" />
              {t.tmux.unknownNotice}
            </p>
          )}
          {error && (
            <p className="tmux-error" role="alert">
              <AlertCircle size={15} aria-hidden="true" />
              <span>{error}</span>
            </p>
          )}
          {(info || orca?.available || runningElsewhere || openTab) && (
            <div className="summon-existing-actions">
              {runningElsewhere && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void jump(chosen.session.id)}
                >
                  <ArrowUpRight size={13} aria-hidden="true" />
                  {t.tmux.jumpToTerminal}
                </button>
              )}
              {openTab && (
                <button className="button primary" disabled={busy} onClick={() => void focusTab()}>
                  <ArrowUpRight size={13} aria-hidden="true" />
                  {t.tmux.jumpToTab}
                </button>
              )}
              {!runningElsewhere &&
                live.map((c) => (
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
                  className={runningElsewhere || openTab ? 'button' : 'button primary'}
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
              {/* Launches follow the conversation's own evidence, not the owned tmux pane. */}
              {info && !info.running && !runningElsewhere && (
                <button
                  className={openElsewhere ? 'button' : 'button primary'}
                  disabled={busy}
                  onClick={() => void tmux('start')}
                >
                  <Terminal size={13} aria-hidden="true" />
                  {openElsewhere ? t.tmux.forceStart : text.tmuxStart}
                </button>
              )}
              {orca?.available && !runningElsewhere && (
                <button className="button" disabled={busy} onClick={() => void launchOrca()}>
                  <ArrowUpRight size={13} aria-hidden="true" />
                  {openElsewhere ? t.tmux.forceOrca : text.orcaStart}
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </details>
  );
}
