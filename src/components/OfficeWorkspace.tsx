import { useEffect, useState } from 'react';
import { zoneLabel } from '../shared/zones';
import {
  Archive,
  Armchair,
  Building2,
  RotateCw,
  ArrowUpRight,
  Clock3,
  Layers,
  ChevronUp,
  SlidersHorizontal,
  EyeOff,
} from 'lucide-react';
import type { OfficeZone, Provider, Session, Snapshot } from '../shared/types';
import type { OfficeModel } from '../shared/office-model';
import { PROVIDERS } from '../shared/types';
import { sessionName } from '../shared/office';
import { ago } from '../lib/format';
import { Office } from './Office';
import { Roster } from './Roster';
import { officeSchedule } from '../shared/lifecycle';
import { sessionScopeLabel } from '../shared/residents';
import { RestLounge } from './RestLounge';
import { Sprite } from './Sprite';
import type { ReceiptHandler } from './News';
import { useI18n } from '../lib/i18n';
function saved<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
// Labels come from the active catalog at render time (`t.office.zones[id]`).
const ZONES = [
  { id: 'office', icon: Building2 },
  { id: 'waiting', icon: Armchair },
  { id: 'archive', icon: Archive },
] as const;
export function OfficeWorkspace({
  snapshot,
  onReceipt,
  onNews,
  selected,
  onSelect,
  onReturn,
  onRefresh,
  onSettings,
  refreshing,
  demo,
  unread,
  onInbox,
  zoneRequest,
  onZoneHandled,
  model,
  onVeil,
  onPin,
  onZoneDrop,
  onReply,
}: {
  snapshot: Snapshot;
  onReceipt: ReceiptHandler;
  onNews: (id: string) => void;
  selected: string | null;
  onSelect: (id: string) => void;
  onReturn: (id: string) => void;
  onRefresh: () => void;
  onSettings: () => void;
  refreshing: boolean;
  demo: boolean;
  unread: number;
  onInbox: () => void;
  zoneRequest?: { zone: OfficeZone; at: number } | null;
  onZoneHandled?: () => void;
  /** Shared office core: projection and zones are derived once for every view. */
  model: OfficeModel;
  /** Hide colleagues (all member runs) until their next conversation, or bring them back. */
  onVeil: (ids: string[], on: boolean) => void;
  /** Keep a colleague in the office however long it stays quiet (toggles `pinned`). */
  onPin: (s: Session) => void;
  onZoneDrop?: (sessionId: string, zoneKey: string | null) => void;
  onReply?: (sessionId: string, text: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const key = `office:view:${demo ? 'demo' : 'live'}`;
  const [zone, setZone] = useState<OfficeZone>(
    () => saved(key, { zone: 'office' }).zone as OfficeZone,
  );
  const [filter, setFilter] = useState<Provider | 'all'>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'recent' | 'frequent'>(
    () => saved(key, { sort: 'recent' }).sort as 'recent' | 'frequent',
  );
  const { preferences: prefs } = snapshot;
  const { residents: sessions, hidden, zones } = model;
  const [historyLimit, setHistoryLimit] = useState(20);
  // List hover spotlights a desk; desk hover only highlights its list row (no room dimming).
  const [listHover, setListHover] = useState<string | null>(null);
  const [deskHover, setDeskHover] = useState<string | null>(null);
  useEffect(() => {
    if (!zoneRequest) return;
    setZone(zoneRequest.zone);
    onZoneHandled?.();
  }, [zoneRequest]);
  const office = zones.office;
  useEffect(() => {
    const owner = selected ? model.view(selected) : undefined;
    if (owner) setZone(owner.zone);
  }, [selected]);
  const rows = zones[zone]
    .filter(
      (s) =>
        (filter === 'all' || s.provider === filter) &&
        [sessionName(s), s.project, s.area?.name ?? '']
          .join(' ')
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (sort === 'frequent' ? (b.openCount || 0) - (a.openCount || 0) : 0) ||
        b.updatedAt - a.updatedAt,
    );
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify({ zone, sort }));
  }, [key, zone, sort]);
  const bring = (id: string) => {
    onReturn(id);
    setZone('office');
  };
  return (
    <div className="office-layout">
      <div className="office-column">
        <div className="stage-toolbar">
          <div className="zone-tabs" role="tablist" aria-label={t.office.spaces}>
            {ZONES.map((z) => (
              <button
                key={z.id}
                role="tab"
                aria-selected={zone === z.id}
                className={zone === z.id ? 'active' : ''}
                onClick={() => {
                  setZone(z.id);
                  setQuery('');
                }}
              >
                <z.icon size={15} strokeWidth={1.9} />
                {t.office.zones[z.id]}
                <span>{zones[z.id].length}</span>
              </button>
            ))}
          </div>
          <div className="stage-toolbar-end">
            <span
              className={`live-badge ${demo ? 'demo' : prefs.paused ? 'paused' : ''}`}
              title={
                demo ? t.office.live.demo : prefs.paused ? t.office.live.paused : t.office.live.live
              }
            >
              <i />
              {demo ? 'Demo' : prefs.paused ? 'Paused' : 'Live'}
            </span>
            <button
              className="office-policy"
              onClick={onSettings}
              aria-label={t.office.settingsLabel}
              title={t.office.settingsTitle}
            >
              <SlidersHorizontal size={13} />
              {officeSchedule(prefs)}
            </button>
            <button
              className={`icon-btn ${refreshing ? 'spin' : ''}`}
              aria-label={t.office.refreshLabel}
              title={t.office.refreshTitle}
              onClick={onRefresh}
              disabled={refreshing}
            >
              <RotateCw size={15} />
            </button>
          </div>
        </div>
        {zone === 'office' ? (
          <Office
            sessions={model.scene}
            notices={snapshot.notices ?? []}
            bubbleHours={prefs.bubbleHours ?? 3}
            onReceipt={onReceipt}
            onNews={onNews}
            selected={selected}
            onSelect={onSelect}
            reducedMotion={prefs.reducedMotion}
            privacy={prefs.privacy}
            onShowWaiting={() => setZone('waiting')}
            spotlight={listHover && model.view(listHover)?.veiled ? null : listHover}
            onHover={setDeskHover}
            onVeil={(s) => onVeil(s.resident?.sessionIds ?? [s.id], true)}
            canVeil={(s) => !model.view(s.id)?.needsPerson}
            onPin={onPin}
            onZoneDrop={onZoneDrop}
            onReply={onReply}
            footer={
              <>
                {model.veiled.length > 0 && (
                  <details className="background-records veiled-records">
                    <summary>
                      <EyeOff size={13} />
                      {t.office.veiled.summary} <b>{model.veiled.length}</b>
                      <ChevronUp size={13} className="chev" />
                    </summary>
                    <div className="background-pop">
                      <p>{t.office.veiled.body}</p>
                      <div>
                        {model.veiled.map(({ session: s }) => (
                          <button
                            key={s.id}
                            onClick={() => onVeil(s.resident?.sessionIds ?? [s.id], false)}
                          >
                            <span className={`face face-${s.provider}`}>
                              <Sprite session={s} provider={s.provider} mood="idle" size={22} />
                            </span>
                            <span>{prefs.privacy ? t.office.records.hidden : sessionName(s)}</span>
                            <small className="veil-row-hint">{t.office.veiled.again}</small>
                          </button>
                        ))}
                      </div>
                      <button
                        className="button subtle"
                        onClick={() => onVeil(model.hiddenSessionIds, false)}
                      >
                        {t.office.veiled.all}
                      </button>
                    </div>
                  </details>
                )}
                {hidden.length > 0 && (
                  <details className="background-records">
                    <summary>
                      <Layers size={13} />
                      {t.office.records.summary} <b>{hidden.length}</b>
                      <ChevronUp size={13} className="chev" />
                    </summary>
                    <div className="background-pop">
                      <p>{t.office.records.body}</p>
                      <div>
                        {[...hidden]
                          .sort((a, b) => b.updatedAt - a.updatedAt)
                          .slice(0, historyLimit)
                          .map((s) => (
                            <button key={s.id} onClick={() => onSelect(s.id)}>
                              <span className={`face face-${s.provider}`}>
                                <Sprite session={s} provider={s.provider} mood="idle" size={22} />
                              </span>
                              <span>
                                {prefs.privacy ? t.office.records.hidden : sessionName(s)}
                              </span>
                              <small>
                                {sessionScopeLabel(s)} · {ago(s.updatedAt)}
                              </small>
                            </button>
                          ))}
                      </div>
                      {hidden.length > historyLimit && (
                        <button
                          className="button subtle"
                          onClick={() => setHistoryLimit((n) => n + 20)}
                        >
                          {t.office.records.more}
                        </button>
                      )}
                    </div>
                  </details>
                )}
              </>
            }
          />
        ) : (
          <section className={`session-room room-${zone}`}>
            {zone === 'waiting' ? (
              <RestLounge
                sessions={rows}
                privacy={prefs.privacy}
                reducedMotion={prefs.reducedMotion}
                onSelect={onSelect}
                onReturn={bring}
              />
            ) : (
              <div className="archive-room">
                <div className="room-intro">
                  <Archive size={18} />
                  <div>
                    <h2>{t.office.archive.title}</h2>
                    <p>{t.office.archive.body}</p>
                  </div>
                </div>
                <div className="room-sessions">
                  {rows.map((s) => (
                    <article key={s.id} className="room-session">
                      <button className="room-session-main" onClick={() => onSelect(s.id)}>
                        <div className={`face face-lg face-${s.provider}`}>
                          <Sprite session={s} provider={s.provider} mood="leave" size={48} />
                        </div>
                        <div>
                          <span className="provider-label">{PROVIDERS[s.provider].name}</span>
                          <h3>{prefs.privacy ? t.office.archive.hiddenSession : sessionName(s)}</h3>
                          <p>{prefs.privacy ? t.office.archive.hiddenProject : zoneLabel(s)}</p>
                          <small>
                            <Clock3 size={11} />
                            {t.office.archive.activity(ago(s.updatedAt), s.openCount || 0)}
                          </small>
                        </div>
                      </button>
                      <div className="room-session-bottom">
                        <span>{s.archived ? t.office.archive.byYou : t.office.archive.aged}</span>
                        <button onClick={() => bring(s.id)}>
                          {t.office.archive.bringBack} <ArrowUpRight size={13} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            )}
            {!rows.length && (
              <div className="empty-state room-empty">
                {zone === 'waiting' ? <Armchair size={30} /> : <Archive size={30} />}
                <h3>{t.office.emptyRoom.title}</h3>
                <p>{t.office.emptyRoom.body}</p>
              </div>
            )}
          </section>
        )}
      </div>
      <Roster
        zone={zone}
        sessions={rows}
        totalSessions={office}
        zoneCount={zones[zone].length}
        notices={snapshot.notices ?? []}
        unread={unread}
        onInbox={onInbox}
        onReceipt={onReceipt}
        hovered={deskHover ?? listHover}
        onHover={setListHover}
        selected={selected}
        onSelect={onSelect}
        privacy={prefs.privacy}
        filter={filter}
        onFilter={setFilter}
        query={query}
        onQuery={setQuery}
        sort={sort}
        onSort={setSort}
      />
    </div>
  );
}
