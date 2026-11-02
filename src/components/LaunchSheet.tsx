import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Copy,
  GitFork,
  History,
  Info,
  LoaderCircle,
  Plus,
  RotateCw,
  Terminal,
} from 'lucide-react';
import { Modal } from './Modal';
import { ago } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useLaunch, type LaunchEntry } from '../lib/useLaunch';
import {
  LAUNCH_KINDS,
  NEW_AGENTS,
  agentLabel,
  keepsDestinations,
  messageProblem,
  nameProblem,
  startLabel,
  type ResultAction,
} from '../shared/launch-sheet';
import { residentLabel } from '../shared/office-model';
import type { LaunchKind } from '../shared/launch';

const KIND_ICON: Record<LaunchKind, typeof Plus> = { new: Plus, resume: History, fork: GitFork };

/**
 * The launch sheet (#319): ① what (a new session, continuing a conversation, or forking it),
 * ② where (Orca, tmux, Terminal, a copied command: each with whether it can and why not),
 * ③ progress and what came of it. Opened by a project "+" and by a work card. It only draws
 * `useLaunch`; the launch itself (confirmation included) is the main process's.
 */
export function LaunchSheet({
  entry,
  privacy,
  notify,
  onClose,
  onReturn,
}: {
  entry: LaunchEntry;
  privacy: boolean;
  notify: (message: string) => void;
  onClose: () => void;
  onReturn?: (id: string) => unknown;
}) {
  const { t } = useI18n();
  const s = t.launchSheet;
  const id = useId();
  const l = useLaunch(entry, { notify, close: onClose, onReturn });
  const { draft, busy } = l;
  const body = useRef<HTMLDivElement>(null);
  // A button that went away (a start finished, a result replaced the form) leaves focus on
  // the page: give it back to the sheet so Escape and Tab keep working.
  useEffect(() => {
    if (document.activeElement === document.body)
      body.current?.closest<HTMLElement>('[role=dialog]')?.focus();
  }, [busy, l.phase, l.result, l.duplicate.blocks]);
  // Hiding names and paths closes the sheet: nothing of it stays on screen.
  useEffect(() => {
    if (privacy) onClose();
  }, [privacy, onClose]);
  if (privacy) return null;
  const nameIssue = draft.kind === 'new' ? nameProblem(draft.name) : '';
  const forkIssue = draft.kind === 'fork' ? nameProblem(draft.forkName) : '';
  const messageIssue = draft.kind !== 'resume' ? messageProblem(draft.message) : '';
  const place = l.chosen ? t.launch.destination[l.chosen] : '';
  const showWhere =
    !l.duplicate.blocks &&
    !(draft.kind !== 'new' && !draft.session) &&
    keepsDestinations(l.phase === 'result' ? l.result : null);
  const label = (session: Parameters<typeof residentLabel>[0]) =>
    residentLabel(session, privacy).name;
  const action = (a: ResultAction, primary: boolean) => {
    const cls = primary ? 'button primary' : 'button';
    switch (a.kind) {
      case 'reveal':
        return (
          <button key="reveal" className={cls} disabled={busy} onClick={() => l.act(a)}>
            <ArrowUpRight size={14} aria-hidden="true" />
            {t.tmux.orcaReveal}
          </button>
        );
      case 'go':
        return (
          <button key="go" className={cls} disabled={busy} onClick={() => l.act(a)}>
            <ArrowUpRight size={14} aria-hidden="true" />
            {s.goThere}
          </button>
        );
      case 'open-terminal':
        return (
          <button key="open" className={cls} disabled={busy} onClick={() => l.act(a)}>
            <Terminal size={14} aria-hidden="true" />
            {s.openTerminal}
          </button>
        );
      case 'copy-command':
        return (
          <button
            key="copy"
            className="button"
            disabled={busy}
            title={a.command}
            onClick={() => l.act(a)}
          >
            <Copy size={14} aria-hidden="true" />
            {s.copyCommand}
          </button>
        );
      case 'suggest':
        return (
          <button
            key={'suggest-' + a.destination}
            className={cls}
            disabled={busy}
            onClick={() => l.act(a)}
          >
            {startLabel(a.destination)}
          </button>
        );
    }
  };
  const progress = (() => {
    if (l.busy) return { icon: 'spin', text: s.progress.starting } as const;
    if (l.phase === 'result' && l.result && !l.result.close)
      return { icon: l.result.tone === 'error' ? 'alert' : 'info', text: l.result.text } as const;
    if (draft.kind !== 'new' && !draft.session) return { icon: 'info', text: s.progress.pick };
    if (nameIssue || forkIssue || messageIssue) return { icon: 'info', text: s.progress.invalid };
    if (l.checking) return { icon: 'spin', text: s.progress.checking } as const;
    if (l.duplicate.blocks) return null;
    if (l.options && !l.chosen) return { icon: 'alert', text: s.progress.none } as const;
    if (l.chosen) return { icon: 'ready', text: s.progress.ready(place) } as const;
    return null;
  })();
  const resultActions =
    l.phase === 'result' && l.result && !l.result.close ? l.result.actions : null;
  return createPortal(
    <Modal title={s.title} onClose={onClose}>
      <div className="tmux-resume launch-sheet" ref={body} data-solid>
        <section className="launch-step" aria-labelledby={`${id}-what`}>
          <h3 id={`${id}-what`}>
            <span className="launch-step-number" aria-hidden="true">
              1
            </span>
            {s.step.what}
          </h3>
          <div role="group" aria-labelledby={`${id}-what`} className="summon-provider launch-kinds">
            {LAUNCH_KINDS.map((kind) => {
              const Icon = KIND_ICON[kind];
              return (
                <button
                  type="button"
                  key={kind}
                  disabled={busy || (kind !== 'new' && !l.conversation && !l.choices.length)}
                  aria-pressed={draft.kind === kind}
                  onClick={() => l.setKind(kind)}
                >
                  <Icon size={13} aria-hidden="true" />
                  {t.launch.kind[kind]}
                </button>
              );
            })}
          </div>
          <p className="launch-hint">{t.launch.intro[draft.kind]}</p>
          {draft.kind === 'new' ? (
            <div className="summon-form">
              <div className="summon-field">
                <span id={`${id}-agent`}>{t.tmux.agentType}</span>
                <div role="group" aria-labelledby={`${id}-agent`} className="summon-provider">
                  {NEW_AGENTS.map((agent) => (
                    <button
                      type="button"
                      key={agent.id}
                      disabled={busy}
                      aria-pressed={draft.provider === agent.id}
                      onClick={() => l.edit({ provider: agent.id })}
                    >
                      {agent.label}
                      {draft.provider === agent.id && <Check size={13} aria-hidden="true" />}
                    </button>
                  ))}
                </div>
              </div>
              {l.projects.length > 1 && (
                <label className="summon-field">
                  <span>{t.tmux.folder}</span>
                  <select
                    aria-label={t.tmux.folder}
                    disabled={busy}
                    value={draft.at}
                    onChange={(e) => l.edit({ at: e.target.value })}
                  >
                    {l.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.cwd}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="summon-field">
                <span>{t.tmux.agentName}</span>
                <input
                  aria-label={t.tmux.agentName}
                  disabled={busy}
                  maxLength={40}
                  value={draft.name}
                  aria-invalid={!!nameIssue}
                  aria-describedby={`${id}-name-help`}
                  onChange={(e) => l.edit({ name: e.target.value })}
                />
                <small id={`${id}-name-help`} className={nameIssue ? 'is-invalid' : ''}>
                  {nameIssue || t.tmux.nameHint}
                </small>
              </label>
            </div>
          ) : (
            <>
              {entry.from === 'card' ? (
                l.conversation && (
                  <div className="launch-conversation" aria-label={s.conversation} role="group">
                    <b>{label(l.conversation.session)}</b>
                    <small>{agentLabel(l.conversation.session.provider)}</small>
                  </div>
                )
              ) : l.choices.length ? (
                <>
                  <ul className="summon-existing-list launch-choices" aria-label={s.conversation}>
                    {l.choices.map((c) => {
                      const reason = c.block ? s.blocked[c.block] : undefined;
                      const chosen = draft.session === c.session.id;
                      return (
                        <li key={c.session.id}>
                          <button
                            type="button"
                            className="summon-existing-row"
                            aria-pressed={chosen}
                            disabled={!!c.block || busy}
                            title={reason}
                            onClick={() => l.pickConversation(c.session.id)}
                          >
                            <span className="summon-existing-name">
                              <b>{label(c.session)}</b>
                              <small>
                                {agentLabel(c.session.provider)} ·{' '}
                                {s.active(ago(c.session.updatedAt))}
                              </small>
                              {reason && <small className="summon-existing-reason">{reason}</small>}
                            </span>
                            <span className="summon-existing-zone" data-zone={c.zone}>
                              {s.zone[c.zone]}
                            </span>
                            {chosen && <Check size={13} aria-hidden="true" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {l.hidden > 0 && <p className="launch-hint">{s.more(l.hidden)}</p>}
                </>
              ) : (
                <p className="launch-hint">{s.noConversations}</p>
              )}
              {l.away && <p className="launch-hint">{s.bringBackHint}</p>}
            </>
          )}
          {draft.kind !== 'resume' && (
            <div className="summon-form">
              {draft.kind === 'fork' && (
                <label className="summon-field">
                  <span>{t.tmux.agentName}</span>
                  <input
                    aria-label={t.tmux.agentName}
                    disabled={busy}
                    maxLength={40}
                    value={draft.forkName}
                    aria-invalid={!!forkIssue}
                    aria-describedby={`${id}-fork-help`}
                    onChange={(e) => l.edit({ forkName: e.target.value })}
                  />
                  <small id={`${id}-fork-help`} className={forkIssue ? 'is-invalid' : ''}>
                    {forkIssue || t.tmux.nameHint}
                  </small>
                </label>
              )}
              <label className="summon-field">
                <span>{t.tmux.initialMessage}</span>
                <textarea
                  aria-label={t.tmux.initialMessage}
                  rows={3}
                  maxLength={4000}
                  placeholder={t.tmux.messagePlaceholder}
                  disabled={busy}
                  value={draft.message}
                  aria-invalid={!!messageIssue}
                  aria-describedby={`${id}-message-help`}
                  onChange={(e) => l.edit({ message: e.target.value })}
                />
                <small id={`${id}-message-help`} className={messageIssue ? 'is-invalid' : ''}>
                  {messageIssue || t.tmux.messageHint}
                </small>
              </label>
            </div>
          )}
          {l.duplicate.notice && (
            <p className={`tmux-caution launch-notice is-${l.duplicate.tone}`} role="status">
              <AlertCircle size={14} aria-hidden="true" />
              <span>{l.duplicate.notice}</span>
            </p>
          )}
        </section>
        {showWhere && (
          <section className="launch-step" aria-labelledby={`${id}-where`}>
            <h3 id={`${id}-where`}>
              <span className="launch-step-number" aria-hidden="true">
                2
              </span>
              {s.step.where}
            </h3>
            {draft.kind === 'fork' && l.options?.origin && l.options.origin !== 'other' && (
              <p className="launch-hint">{s.forkOrigin(t.tmux.place[l.options.origin])}</p>
            )}
            <fieldset
              className="launch-destinations"
              aria-labelledby={`${id}-where`}
              aria-busy={l.stale}
              data-stale={l.stale}
            >
              {l.rows.map((row) => (
                <label
                  key={row.id}
                  className="launch-destination"
                  data-available={row.available}
                  data-destination={row.id}
                >
                  <input
                    type="radio"
                    name={`${id}-destination`}
                    value={row.id}
                    checked={l.chosen === row.id}
                    disabled={!row.available || busy}
                    onChange={() => l.pick(row.id)}
                  />
                  <span className="launch-destination-text">
                    <b>
                      {row.label}
                      {row.remembered && <em className="launch-remembered">{s.remembered}</em>}
                    </b>
                    <small>{row.hint}</small>
                    {row.reason && <small className="launch-reason">{row.reason}</small>}
                  </span>
                  <span
                    className="launch-badge"
                    data-state={row.available ? (row.running ? 'running' : 'ok') : 'off'}
                  >
                    {row.badge}
                  </span>
                </label>
              ))}
            </fieldset>
            {l.chosen === 'tmux' && l.canOpenAfter && (
              <label className="launch-check">
                <input
                  type="checkbox"
                  checked={l.openAfter}
                  disabled={busy}
                  onChange={(e) => l.setOpenAfter(e.target.checked)}
                />
                <span>{s.openAfterStart}</span>
              </label>
            )}
          </section>
        )}
        {progress && (
          <section className="launch-step" aria-labelledby={`${id}-progress`}>
            <h3 id={`${id}-progress`}>
              <span className="launch-step-number" aria-hidden="true">
                3
              </span>
              {s.step.progress}
            </h3>
            <p className="launch-progress" data-tone={progress.icon} role="status">
              {progress.icon === 'spin' ? (
                <LoaderCircle size={14} className="now-spin" aria-hidden="true" />
              ) : progress.icon === 'alert' ? (
                <AlertCircle size={14} aria-hidden="true" />
              ) : progress.icon === 'ready' ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Info size={14} aria-hidden="true" />
              )}
              <span>{progress.text}</span>
            </p>
            {!!resultActions?.some((a) => a.kind === 'suggest') && (
              <p className="launch-hint">{s.suggest}</p>
            )}
          </section>
        )}
        {l.error && (
          <p className="tmux-error" role="alert">
            <AlertCircle size={15} aria-hidden="true" />
            <span>{l.error}</span>
          </p>
        )}
      </div>
      <div className="tmux-resume-actions launch-actions" data-solid>
        <button className="button subtle" disabled={busy} onClick={l.refresh}>
          <RotateCw size={14} aria-hidden="true" />
          {t.tmux.refresh}
        </button>
        <div className="launch-actions-main">
          {l.unreturned && (
            <button className="button" disabled={busy} onClick={l.returnAgain}>
              {s.returnAgain}
            </button>
          )}
          {resultActions ? (
            resultActions.map((a, i) => action(a, i === 0))
          ) : l.duplicate.blocks ? (
            l.duplicate.reveal ? (
              action({ kind: 'reveal' }, true)
            ) : l.duplicate.go ? (
              action({ kind: 'go', go: l.duplicate.go }, true)
            ) : null
          ) : (
            <>
              {l.duplicate.go &&
                draft.kind === 'resume' &&
                action({ kind: 'go', go: l.duplicate.go }, true)}
              {showWhere && (
                <button
                  className={
                    l.duplicate.go && draft.kind === 'resume' ? 'button' : 'button primary'
                  }
                  disabled={!l.canStart}
                  onClick={l.start}
                >
                  {busy ? (
                    <LoaderCircle size={14} className="now-spin" aria-hidden="true" />
                  ) : (
                    <Terminal size={14} aria-hidden="true" />
                  )}
                  {l.chosen
                    ? startLabel(l.chosen, !!l.duplicate.go && draft.kind === 'resume')
                    : s.start}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>,
    document.body,
  );
}
