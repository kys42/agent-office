import { useMemo } from 'react';
import { EyeOff, GitBranch, List, Pin, Search, WifiOff, X } from 'lucide-react';
import type { Provider, Session } from '../shared/types';
import { MOODS, PROVIDERS } from '../shared/types';
import type { OfficeModel } from '../shared/office-model';
import { officeListGroups, type OfficeListOrder } from '../shared/office-list';
import { sessionName } from '../shared/office';
import { zoneLabel } from '../shared/zones';
import { branchInfo } from '../shared/branch';
import { messageExcerpt, sessionActivity } from '../shared/activity';
import { ago, date, time } from '../lib/format';
import { useI18n } from '../lib/i18n';

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
}) {
  const { t } = useI18n();
  const copy = t.office.list;
  const groups = useMemo(() => officeListGroups(sessions, order), [sessions, order]);
  return (
    <section className="office-list" aria-label={copy.label}>
      <div className="office-list-tools">
        <label className="office-list-search">
          <Search size={15} aria-hidden="true" />
          <input
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
      <div className="office-list-scroll">
        <div className="office-list-columns" aria-hidden="true">
          <span>{copy.teammate}</span>
          <span>{copy.project}</span>
          <span>{copy.status}</span>
          <span>{copy.activity}</span>
        </div>
        {groups.map((group) => (
          <section key={group.key} className="office-list-group">
            {order === 'project' && (
              <h3>
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
                const unread = (view?.unread.length ?? 0) + (view?.helperUnread.length ?? 0);
                return (
                  <li key={s.id}>
                    <button
                      className={`office-list-row ${active ? 'selected' : ''}`}
                      data-session-id={s.id}
                      aria-pressed={!!active}
                      onClick={() => onSelect(s.id)}
                    >
                      <span className="office-list-identity">
                        <span
                          className={`office-list-provider provider-${s.provider}`}
                          aria-label={PROVIDERS[s.provider].name}
                        >
                          {PROVIDERS[s.provider].short.slice(0, 1)}
                        </span>
                        <span className="office-list-copy">
                          <strong>
                            <span>{privacy ? PROVIDERS[s.provider].name : sessionName(s)}</span>
                            {s.pinned && <Pin size={11} aria-label={copy.pinned} />}
                            {view?.veiled && (
                              <EyeOff size={12} aria-label={t.office.veiled.summary} />
                            )}
                            {unread > 0 && <em title={t.roster.unreadTitle(unread)}>{unread}</em>}
                          </strong>
                          <small>
                            {privacy
                              ? t.roster.hidden
                              : messageExcerpt(sessionActivity(s).text, 180)}
                          </small>
                        </span>
                      </span>
                      <span className="office-list-project">
                        <span>{privacy ? t.app.sidebar.hiddenProject : zoneLabel(s)}</span>
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
                        {MOODS[mood].label}
                        {s.remote?.stale && (
                          <small className="office-list-offline">
                            <WifiOff size={11} />
                            {t.federation.offline}
                          </small>
                        )}
                        {s.attachedTo && <small>{t.roster.helper}</small>}
                      </span>
                      <time
                        dateTime={new Date(s.updatedAt).toISOString()}
                        title={`${date(s.updatedAt)} ${time(s.updatedAt)}`}
                      >
                        {ago(s.updatedAt)}
                      </time>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {!sessions.length && (
          <div className="empty-state office-list-empty">
            <List size={28} />
            <h3>{t.roster.empty}</h3>
          </div>
        )}
      </div>
    </section>
  );
}
