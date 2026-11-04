import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowUpRight,
  BatteryWarning,
  CornerDownRight,
  EyeOff,
  Folder,
  GitBranch,
  GitFork,
  Layers,
  List,
  Pin,
  Search,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import type { Provider, Session } from '../shared/types';
import { MOODS, PROVIDERS } from '../shared/types';
import type { OfficeModel } from '../shared/office-model';
import { officeListGroups, type OfficeListOrder } from '../shared/office-list';
import { helperName, parentSession, projectKey, sessionName } from '../shared/office';
import { isHelper } from '../shared/residents';
import { durationShort, workingFor } from '../shared/triage';
import { projectColor } from '../shared/office-layout';
import { zoneLabel } from '../shared/zones';
import { branchInfo } from '../shared/branch';
import { messageExcerpt, sessionActivity } from '../shared/activity';
import { ago, date, time } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { Sprite } from './Sprite';

const projectStyle = (key: string) => ({ '--project-color': projectColor(key) }) as CSSProperties;

export function OfficeList({
  sessions,
  model,
  privacy,
  selected,
  onSelect,
  query,
  onQuery,
  filter,
  onFilter,
  order,
  onOrder,
  scope,
  label,
  action,
  note,
  empty,
}: {
  sessions: Session[];
  model: OfficeModel;
  privacy: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  query: string;
  onQuery: (value: string) => void;
  filter: Provider | 'all';
  onFilter: (value: Provider | 'all') => void;
  order: OfficeListOrder;
  onOrder: (value: OfficeListOrder) => void;
  scope?: { label: string; onClear: () => void };
  /** Accessible name for the list; defaults to the office list. */
  label?: string;
  /** Per-row action beside the row (e.g. bring a lounge/archive colleague back to the office). */
  action?: { label: string; onAct: (id: string) => unknown };
  /** Replaces the status text for rooms where the mood is not the interesting part. */
  note?: (s: Session) => string | undefined;
  empty?: { icon: ReactNode; title: string; body?: string };
}) {
  const { t } = useI18n();
  const copy = t.office.list;
  const groups = useMemo(() => officeListGroups(sessions, order), [sessions, order]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Rows being brought back: ignore repeat presses until the move settles.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const act = (id: string) => {
    if (!action || busy.has(id)) return;
    const buttons = [
      ...(scrollRef.current?.querySelectorAll<HTMLButtonElement>('.office-list-action') ?? []),
    ];
    const at = buttons.findIndex((b) => b.dataset.sessionId === id);
    const focused = at >= 0 && document.activeElement === buttons[at];
    const neighbor = (buttons[at + 1] ?? buttons[at - 1])?.dataset.sessionId;
    setBusy((b) => new Set(b).add(id));
    void Promise.resolve(action.onAct(id))
      .catch(() => undefined)
      .finally(() => {
        setBusy((b) => {
          const next = new Set(b);
          next.delete(id);
          return next;
        });
        if (!focused) return;
        // The row leaves the list; keep keyboard users on the next one so they can continue.
        requestAnimationFrame(() => {
          const root = scrollRef.current;
          if (!root || root.querySelector(`[data-session-id="${CSS.escape(id)}"]`)) return;
          const target = neighbor
            ? root.querySelector<HTMLButtonElement>(
                `.office-list-action[data-session-id="${CSS.escape(neighbor)}"]`,
              )
            : null;
          (target ?? searchRef.current)?.focus();
        });
      });
  };
  return (
    <section
      className={`office-list ${action ? 'with-action' : ''}`}
      aria-label={label ?? copy.label}
    >
      <div className="office-list-tools">
        <label className="office-list-search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={searchRef}
            aria-label={t.roster.searchLabel}
            placeholder={t.roster.searchPlaceholder}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
          {query && (
            <button aria-label={t.roster.clearSearch} onClick={() => onQuery('')}>
              <X size={13} />
            </button>
          )}
        </label>
        <select
          aria-label={t.roster.filterLabel}
          value={filter}
          onChange={(e) => onFilter(e.target.value as Provider | 'all')}
        >
          <option value="all">{t.roster.all}</option>
          {(['claude', 'codex', 'openclaw'] as const).map((p) => (
            <option key={p} value={p}>
              {PROVIDERS[p].name}
            </option>
          ))}
        </select>
        <select
          aria-label={copy.orderLabel}
          value={order}
          onChange={(e) => onOrder(e.target.value as OfficeListOrder)}
        >
          <option value="recent">{t.roster.sort.recent}</option>
          <option value="project">{copy.byProject}</option>
        </select>
      </div>
      {scope && (
        <div className="roster-scope office-list-scope">
          <span>{scope.label}</span>
          <button aria-label={t.roster.clearScope} onClick={scope.onClear}>
            <X size={12} />
          </button>
        </div>
      )}
      <div className="office-list-scroll" ref={scrollRef}>
        <div className="office-list-columns" aria-hidden="true">
          <span>{copy.teammate}</span>
          <span>{copy.project}</span>
          <span>{copy.status}</span>
          <span>{copy.activity}</span>
        </div>
        {groups.map((group) => (
          <section key={group.key} className="office-list-group" style={projectStyle(group.key)}>
            {order === 'project' && (
              <h3>
                <Folder size={14} aria-hidden="true" />
                <span>{privacy ? t.app.sidebar.hiddenProject : group.label}</span>
                <small>{group.sessions.length}</small>
              </h3>
            )}
            <ul>
              {group.sessions.map((s) => {
                const view = model.view(s.id);
                const mood = view?.pose.mood ?? s.status;
                const active = s.id === selected || s.resident?.sessionIds.includes(selected ?? '');
                const branch = branchInfo(s);
                const unread = view?.unread.length ?? 0;
                const helperNews = view?.helperUnread.length ?? 0;
                const helper = isHelper(s) && !s.resident;
                const fork = s.relation?.kind === 'fork';
                const parent = s.attachedTo
                  ? model.ownerOf(s.attachedTo)
                  : parentSession(s, model.residents);
                const helpers = view?.helpers.length ?? 0;
                const callingHelpers = view?.helpers.filter((v) => v.needsPerson).length ?? 0;
                const result = view?.group === 'results' ? view.unread[0] : undefined;
                const elapsed = workingFor(s, model.now);
                const noted = note?.(s);
                return (
                  <li key={s.id} className={action ? 'with-action' : undefined}>
                    <button
                      className={`office-list-row ${helper ? 'is-helper' : ''} ${active ? 'selected' : ''}`}
                      data-session-id={s.id}
                      style={projectStyle(projectKey(s))}
                      aria-pressed={!!active}
                      onClick={() => onSelect(s.id)}
                    >
                      <span className="office-list-identity">
                        <span
                          className={`office-list-avatar face face-${s.provider} ${helper ? 'helper-avatar' : ''}`}
                          aria-label={PROVIDERS[s.provider].name}
                          title={PROVIDERS[s.provider].name}
                        >
                          <Sprite
                            session={s}
                            provider={s.provider}
                            mood={mood}
                            size={helper ? 28 : 36}
                          />
                          {helper && (
                            <CornerDownRight
                              size={11}
                              className="office-list-helper-mark"
                              aria-hidden="true"
                            />
                          )}
                        </span>
                        <span className="office-list-copy">
                          <strong>
                            <span>
                              {privacy
                                ? PROVIDERS[s.provider].name
                                : helper
                                  ? helperName(s)
                                  : sessionName(s)}
                            </span>
                            {s.pinned && <Pin size={11} aria-label={copy.pinned} />}
                            {view?.veiled && (
                              <EyeOff size={12} aria-label={t.office.veiled.summary} />
                            )}
                            {unread > 0 && <em title={t.roster.unreadTitle(unread)}>{unread}</em>}
                          </strong>
                          {(helper || fork || helpers > 0 || s.resident || view?.quota) && (
                            <span className="office-list-relations">
                              {helper && (
                                <span className="office-list-kind helper-kind">
                                  <CornerDownRight size={11} />
                                  {t.roster.helper}
                                </span>
                              )}
                              {fork && (
                                <span className="office-list-kind">
                                  <GitFork size={11} />
                                  {t.roster.fork}
                                </span>
                              )}
                              {(helper || fork) && parent && (
                                <span
                                  className="office-list-lineage"
                                  title={privacy ? undefined : sessionName(parent)}
                                >
                                  {privacy
                                    ? helper
                                      ? copy.hiddenParent
                                      : copy.hiddenFork
                                    : helper
                                      ? copy.helperOf(sessionName(parent))
                                      : copy.forkOf(sessionName(parent))}
                                </span>
                              )}
                              {helpers > 0 && (
                                <span
                                  className={`office-list-kind ${callingHelpers ? 'helpers-calling' : ''}`}
                                >
                                  <Users size={11} />
                                  {copy.main} · {copy.helpers(helpers)}
                                  {callingHelpers > 0 &&
                                    ` · ${copy.helpersCalling(callingHelpers)}`}
                                </span>
                              )}
                              {s.resident && (
                                <span
                                  className="office-list-kind"
                                  title={copy.activeRuns(
                                    s.resident.activeCount,
                                    s.resident.sessionIds.length,
                                  )}
                                >
                                  <Layers size={11} />
                                  {t.roster.runs(s.resident.sessionIds.length)}
                                </span>
                              )}
                              {view?.quota && (
                                <span
                                  className="office-list-kind quota-kind"
                                  title={t.desk.quota.title(PROVIDERS[s.provider].short)}
                                >
                                  <BatteryWarning size={11} />
                                  {t.desk.quota.label(PROVIDERS[s.provider].short)}
                                </span>
                              )}
                            </span>
                          )}
                          <small>
                            {privacy
                              ? t.roster.hidden
                              : messageExcerpt(result?.text ?? sessionActivity(s).text, 180)}
                          </small>
                        </span>
                      </span>
                      <span className="office-list-project">
                        <span className="office-list-project-name">
                          <Folder size={12} aria-hidden="true" />
                          <span>{privacy ? t.app.sidebar.hiddenProject : zoneLabel(s)}</span>
                        </span>
                        <small>
                          {!privacy && (
                            <>
                              <GitBranch size={11} />
                              <span title={branch.detail}>{branch.label}</span>
                            </>
                          )}
                          {s.remote && (
                            <span>{privacy ? t.office.zones.office : s.remote.label}</span>
                          )}
                        </small>
                      </span>
                      <span className={`office-list-status status-${mood}`}>
                        <i />
                        {noted
                          ? noted
                          : elapsed !== null
                            ? t.roster.workingFor(durationShort(elapsed))
                            : result
                              ? t.roster.newResults(unread, ago(result.at))
                              : MOODS[mood].label}
                        {helperNews > 0 && (
                          <small className="office-list-helper-news">
                            <CornerDownRight size={11} />
                            {copy.helperNews(helperNews)}
                          </small>
                        )}
                        {s.remote?.stale && (
                          <small className="office-list-offline">
                            <WifiOff size={11} />
                            {t.federation.offline}
                          </small>
                        )}
                      </span>
                      <time
                        dateTime={new Date(s.updatedAt).toISOString()}
                        title={`${date(s.updatedAt)} ${time(s.updatedAt)}`}
                      >
                        {ago(s.updatedAt)}
                      </time>
                    </button>
                    {action && (
                      <button
                        className="office-list-action"
                        data-session-id={s.id}
                        aria-disabled={busy.has(s.id) || undefined}
                        aria-label={`${action.label} · ${privacy ? PROVIDERS[s.provider].name : helper ? helperName(s) : sessionName(s)}`}
                        title={action.label}
                        onClick={() => act(s.id)}
                      >
                        <span>{action.label}</span>
                        <ArrowUpRight size={13} aria-hidden="true" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {!sessions.length && (
          <div className="empty-state office-list-empty">
            {empty?.icon ?? <List size={28} />}
            <h3>{empty?.title ?? t.roster.empty}</h3>
            {empty?.body && <p>{empty.body}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
