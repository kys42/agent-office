import { useEffect, useMemo, useRef, useState } from 'react';
import { zoneLabel } from '../shared/zones';
import { CheckCheck, ChevronDown, Pin, Search, X } from 'lucide-react';
import type { OfficeNotice, OfficeZone, Provider, Session } from '../shared/types';
import { MOODS, PROVIDERS } from '../shared/types';
import { Sprite } from './Sprite';
import { ago, date } from '../lib/format';
import { sessionActivity, activityLabel } from '../shared/activity';
import { sessionName } from '../shared/office';
import {
  durationShort,
  triage,
  TRIAGE_LABELS,
  unreadInbox,
  workingFor,
  type TriageGroup,
} from '../shared/triage';
import { PanelTabs } from './PanelTabs';
import type { ReceiptHandler } from './News';
import { isWorking } from '../shared/presentation';
import { isAttentionNotice } from '../shared/notices';
import { useI18n } from '../lib/i18n';
function saved(key: string) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
export function Roster({
  zone,
  sessions,
  totalSessions,
  zoneCount,
  notices,
  unread,
  query,
  onQuery,
  sort,
  onSort,
  selected,
  onSelect,
  hovered,
  onHover,
  onInbox,
  onReceipt,
  privacy,
  filter,
  onFilter,
}: {
  zone: OfficeZone;
  sessions: Session[];
  totalSessions: Session[];
  zoneCount: number;
  notices: OfficeNotice[];
  unread: number;
  query: string;
  onQuery: (q: string) => void;
  sort: 'recent' | 'frequent';
  onSort: (s: 'recent' | 'frequent') => void;
  selected: string | null;
  onSelect: (id: string) => void;
  hovered: string | null;
  onHover: (id: string | null) => void;
  onInbox: () => void;
  onReceipt: ReceiptHandler;
  privacy: boolean;
  filter: Provider | 'all';
  onFilter: (p: Provider | 'all') => void;
}) {
  const { t } = useI18n();
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const [restFolded, setRestFolded] = useState(() => saved('office:roster:rest-folded'));
  useEffect(() => {
    try {
      localStorage.setItem('office:roster:rest-folded', restFolded ? '1' : '0');
    } catch {
      /* per-viewer convenience only */
    }
  }, [restFolded]);
  const scroller = useRef<HTMLDivElement>(null);
  const summary = useMemo(
    () => triage(totalSessions, notices, clock),
    [totalSessions, notices, clock],
  );
  const byGroup = Object.fromEntries(summary.map((g) => [g.group, g.sessions])) as Record<
    TriageGroup,
    Session[]
  >;
  // Tiles are facts that may overlap (a working colleague can also have a result to read);
  // the list below is the exclusive to-do order.
  // Tile labels are shorter cuts of the group names: four tiles share the panel width.
  const tiles = [
    { key: 'attention', tone: 'calling', label: t.roster.tiles.attention, ids: byGroup.attention },
    {
      key: 'results',
      tone: 'done',
      label: t.roster.tiles.results,
      ids: totalSessions.filter((s) => unreadInbox(s, notices).length),
    },
    {
      key: 'working',
      tone: 'working',
      label: t.roster.tiles.working,
      ids: totalSessions.filter((s) => workingFor(s, clock) !== null || isWorking(s, clock)),
    },
    { key: 'all', tone: 'resting', label: t.roster.tiles.all, ids: totalSessions },
  ] as const;
  const visible = sessions.filter((s) => filter === 'all' || s.provider === filter);
  // Rooms other than the office are not a to-do list; keep them as one calm list.
  const groups =
    zone === 'office'
      ? triage(visible, notices, clock).filter((g) => g.sessions.length)
      : [{ group: 'resting' as TriageGroup, sessions: visible }];
  const jump = (ids: readonly Session[]) => {
    const target = ids.find((s) => visible.includes(s)) ?? ids[0];
    if (!target) return;
    if (byGroup.resting.includes(target)) setRestFolded(false);
    requestAnimationFrame(() =>
      scroller.current
        ?.querySelector(`[data-session-id="${CSS.escape(target.id)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    );
    onHover(target.id);
  };
  const hour = new Date(clock).getHours();
  const greeting =
    hour < 6
      ? t.roster.greeting.lateNight
      : hour < 12
        ? t.roster.greeting.morning
        : hour < 18
          ? t.roster.greeting.afternoon
          : t.roster.greeting.evening;
  const resultCount = totalSessions.reduce((n, s) => n + unreadInbox(s, notices).length, 0);
  const headline = tiles[0].ids.length
    ? t.roster.headline.waiting(tiles[0].ids.length)
    : resultCount
      ? t.roster.headline.results(resultCount)
      : tiles[2].ids.length
        ? t.roster.headline.working(tiles[2].ids.length)
        : byGroup.standby?.length
          ? t.roster.headline.standby(byGroup.standby.length)
          : t.roster.headline.quiet;
  return (
    <aside className="roster" aria-label={t.roster.label}>
      <PanelTabs active="roster" unread={unread} onInbox={onInbox} />
      <div className="roster-head">
        <span>
          {date(clock)} · {greeting}
        </span>
        <h2>{headline}</h2>
      </div>
      <div className="stats-grid" role="group" aria-label={t.roster.summary}>
        {tiles.map((tile) => (
          <button
            key={tile.key}
            className={`stat ${tile.tone} ${tile.ids.length && tile.key !== 'all' ? { attention: 'is-alert', results: 'is-result', working: 'is-live' }[tile.key] : ''}`}
            onClick={() => jump(tile.ids)}
            disabled={zone !== 'office' || !tile.ids.length}
            title={t.roster.findInList(tile.label)}
          >
            <span>
              <i />
              {tile.label}
            </span>
            <strong>{tile.ids.length}</strong>
          </button>
        ))}
      </div>
      <div className="roster-panel">
        <div className="section-title">
          <h2>{t.roster.titles[zone]}</h2>
          <span>{zoneCount}</span>
          <select
            aria-label={t.roster.sortLabel}
            value={sort}
            onChange={(e) => onSort(e.target.value as 'recent' | 'frequent')}
          >
            <option value="recent">{t.roster.sort.recent}</option>
            <option value="frequent">{t.roster.sort.frequent}</option>
          </select>
        </div>
        <div className="roster-finder">
          <label>
            <Search size={13} />
            <input
              aria-label={t.roster.searchLabel}
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder={t.roster.searchPlaceholder}
            />
            {query && (
              <button aria-label={t.roster.clearSearch} onClick={() => onQuery('')}>
                <X size={12} />
              </button>
            )}
          </label>
        </div>
        <div className="provider-filters" role="group" aria-label={t.roster.filterLabel}>
          {(['all', 'claude', 'codex', 'openclaw'] as const).map((p) => (
            <button
              key={p}
              className={`${filter === p ? 'active' : ''} chip-${p}`}
              onClick={() => onFilter(p)}
            >
              {p !== 'all' && <i />}
              {p === 'all' ? t.roster.all : PROVIDERS[p].short}
            </button>
          ))}
        </div>
        <div className="roster-scroll" ref={scroller} onMouseLeave={() => onHover(null)}>
          {groups.map(({ group, sessions: rows }) => {
            const foldable = zone === 'office' && group === 'resting' && groups.length > 1;
            const folded = foldable && restFolded && !query;
            return (
              <section key={group} className={`roster-group group-${group}`} data-group={group}>
                {zone === 'office' && (
                  <div className="group-head">
                    <button
                      aria-expanded={!folded}
                      onClick={() => foldable && setRestFolded(!restFolded)}
                      disabled={!foldable}
                    >
                      <i />
                      <b>{TRIAGE_LABELS[group]}</b>
                      <em>{rows.length}</em>
                      {foldable && <ChevronDown size={13} className="group-chev" />}
                    </button>
                    {group === 'results' ? (
                      <button
                        className="group-action"
                        title={t.roster.markAllReadTitle}
                        onClick={() =>
                          onReceipt(
                            rows
                              .flatMap((r) => unreadInbox(r, notices))
                              .filter((n) => !isAttentionNotice(n))
                              .map(({ id, version }) => ({ id, version })),
                            'read',
                          )
                        }
                      >
                        <CheckCheck size={12} />
                        {t.roster.markAllRead}
                      </button>
                    ) : (
                      <small>{t.roster.hints[group]}</small>
                    )}
                  </div>
                )}
                {!folded &&
                  rows.map((s) => {
                    const news = unreadInbox(s, notices);
                    const elapsed = workingFor(s, clock);
                    const activity = sessionActivity(s);
                    const active =
                      s.id === selected || s.resident?.sessionIds.includes(selected ?? '');
                    const result = zone === 'office' && group === 'results' ? news[0] : undefined;
                    return (
                      <button
                        key={s.id}
                        data-session-id={s.id}
                        className={`session-row status-${s.status} ${elapsed !== null ? 'is-live' : ''} ${active ? 'selected' : ''} ${hovered === s.id ? 'is-hover' : ''}`}
                        onClick={() => onSelect(s.id)}
                        onMouseEnter={() => onHover(s.id)}
                      >
                        <div className={`face face-${s.provider}`}>
                          <Sprite provider={s.provider} mood={s.status} size={36} />
                          <i style={{ background: MOODS[s.status].color }} />
                        </div>
                        <div className="session-copy">
                          <strong>
                            <span>{privacy ? PROVIDERS[s.provider].name : sessionName(s)}</span>
                            {s.pinned && <Pin size={10} />}
                            {news.length > 0 && (
                              <em title={t.roster.unreadTitle(news.length)}>{news.length}</em>
                            )}
                          </strong>
                          <span className="session-meta">
                            {privacy ? t.roster.hidden : zoneLabel(s)}
                            <i>·</i>
                            {sort === 'frequent'
                              ? t.roster.opened(s.openCount || 0)
                              : ago(s.updatedAt)}
                          </span>
                          {!privacy && (
                            <p
                              className="session-progress"
                              title={`${activityLabel(s)} · ${ago(activity.at)}\n${activity.text}`}
                            >
                              {result ? result.text : activity.text}
                            </p>
                          )}
                          <small style={{ color: MOODS[s.status].color }}>
                            {elapsed !== null
                              ? t.roster.workingFor(durationShort(elapsed))
                              : result
                                ? t.roster.newResults(news.length, ago(result.at))
                                : MOODS[s.status].label}
                            {s.resident ? ` · ${t.roster.runs(s.resident.sessionIds.length)}` : ''}
                            {s.relation?.kind === 'subagent' || s.relation?.kind === 'child'
                              ? ` · ${t.roster.helper}`
                              : s.relation?.kind === 'fork'
                                ? ` · ${t.roster.fork}`
                                : ''}
                          </small>
                        </div>
                      </button>
                    );
                  })}
              </section>
            );
          })}
          {visible.length === 0 && <div className="empty-small">{t.roster.empty}</div>}
        </div>
      </div>
    </aside>
  );
}
