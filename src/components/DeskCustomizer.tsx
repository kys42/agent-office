import { useI18n } from '../lib/i18n';
import { useState, type CSSProperties } from 'react';
import { Check, Minus, RotateCcw, Sparkles } from 'lucide-react';
import type { Preferences, Provider, Session } from '../shared/types';
import { projectKey } from '../shared/office';
import { zoneLabel } from '../shared/zones';
import { petKey } from '../shared/pets';
import {
  DEFAULT_DESK_LOOK,
  DESK_CHAIRS,
  DESK_ITEMS,
  DESK_MONITORS,
  DESK_TOPS,
  deskAssets,
  deskLayer,
  deskLook,
  type DeskChair,
  type DeskCustomization,
  type DeskItem,
  type DeskLook,
  type DeskMonitor,
  type DeskTop,
} from '../shared/desks';
import { useDeskAppearance } from './DeskAppearanceContext';
import { Furniture } from './Furniture';
import { Modal } from './Modal';
import { Sprite } from './Sprite';

type Scope = 'office' | 'project' | 'colleague';
export interface DeskZone {
  key: string;
  name: string;
}

/** One desk station, seated and working, cropped to the desk and drawn at `scale`. */
export function DeskPreview({
  look,
  session,
  provider = session?.provider ?? 'claude',
  scale = 1,
}: {
  look: DeskLook;
  session?: Session;
  provider?: Provider;
  scale?: number;
}) {
  return (
    <div
      className="desk-preview-scene"
      style={{ '--desk-preview-scale': scale } as CSSProperties}
      aria-hidden="true"
    >
      <div className="desk-preview-frame">
        <Furniture kind="desk" look={look} style={{ left: -12, top: 134, width: 188 }} />
        <div className="desk-station station-working status-work">
          <Furniture kind="chair" look={look} />
          <div className="pet-shadow" />
          <div className="office-pet">
            <Sprite provider={provider} session={session} mood="work" size={80} />
          </div>
          <Furniture kind="equipment" look={look} />
        </div>
      </div>
    </div>
  );
}

/**
 * Desk customization, layered like the office reads it: the whole office, one project zone,
 * one colleague. Opened from settings it starts office-wide and can pick a project; opened from
 * a work card it can also dress that colleague's own desk.
 */
export function DeskCustomizer({
  session,
  zones = [],
  privacy = false,
  onPrefs,
  onClose,
}: {
  session?: Session;
  zones?: DeskZone[];
  /** Screen sharing: project names stay hidden here as everywhere else. */
  privacy?: boolean;
  onPrefs: (patch: Partial<Preferences>) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const d = t.desks;
  const saved = useDeskAppearance();
  const choices: DeskZone[] = (
    session ? [{ key: projectKey(session), name: zoneLabel(session) }] : zones
  ).map((z, i) => (privacy ? { ...z, name: d.hiddenProject(i + 1) } : z));
  const [scope, setScope] = useState<Scope>(session ? 'colleague' : 'office');
  const [zone, setZone] = useState(choices[0]?.key);
  const zoneName = choices.find((z) => z.key === zone)?.name ?? '';
  const lookAt = (next: Scope, key = zone) =>
    next === 'office'
      ? deskLook(saved)
      : next === 'project'
        ? deskLook(saved, key)
        : deskLook(saved, key, session);
  const below = (next: Scope) =>
    next === 'office'
      ? DEFAULT_DESK_LOOK
      : next === 'project'
        ? deskLook(saved)
        : lookAt('project');
  const [draft, setDraft] = useState<DeskLook>(() => lookAt(scope));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choose = (next: Scope, key = zone) => {
    setScope(next);
    setZone(key);
    setDraft(lookAt(next, key));
  };
  const save = async (reset = false) => {
    setBusy(true);
    setError('');
    // A layer keeps only what it changes, so later changes below it still show through.
    const layer = deskLayer(draft, below(scope));
    // A colleague's desk sits on the zone's shared bench.
    if (scope === 'colleague') delete layer.top;
    const value = reset || Object.keys(layer).length === 0 ? null : layer;
    const deskAppearance: DeskCustomization = {
      version: 1,
      ...(scope === 'office' ? { office: value } : {}),
      projects: scope === 'project' && zone ? { [zone]: value } : {},
      colleagues: scope === 'colleague' && session ? { [petKey(session)]: value } : {},
    };
    try {
      if (await onPrefs({ deskAppearance })) onClose();
      else setError(d.saveError);
    } catch {
      setError(d.saveError);
    } finally {
      setBusy(false);
    }
  };
  const set = (patch: Partial<DeskLook>) => setDraft({ ...draft, ...patch });
  const assets = (look: Partial<DeskLook>) => deskAssets({ ...draft, ...look });
  // Dual screens take the left end of the desk: no left item beside them.
  const crowded = (side: 'itemLeft' | 'itemRight') =>
    side === 'itemLeft' && draft.monitor === 'dual';
  const itemGrid = (side: 'itemLeft' | 'itemRight', legend: string, n: string) => (
    <fieldset disabled={busy || crowded(side)}>
      <legend>
        {n} <b>{legend}</b>
      </legend>
      {crowded(side) && <small className="desk-crowded">{d.dualLeft}</small>}
      <div className="desk-item-grid">
        {(Object.entries(DESK_ITEMS) as [DeskItem, string][]).map(([id, name]) => {
          const image = assets({ [side]: id })[side];
          return (
            <button
              key={id}
              aria-label={d.itemLabel(legend, name)}
              aria-pressed={draft[side] === id}
              title={name}
              onClick={() => set({ [side]: id })}
            >
              {image ? (
                <i className="desk-thumb item" style={{ backgroundImage: `url(${image})` }} />
              ) : (
                <Minus size={16} className="desk-thumb-none" />
              )}
              <span>{name}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
  const scopes: Scope[] = session ? ['office', 'project', 'colleague'] : ['office', 'project'];
  return (
    <Modal title={d.title} onClose={onClose} wide>
      <div className="pet-customizer desk-customizer">
        <div className="pet-preview desk-preview">
          <span className="eyebrow">Make yourself at home</span>
          <div className="desk-preview-stage">
            <DeskPreview look={draft} session={session} scale={1.2} />
          </div>
          <div className="desk-scope" role="group" aria-label={d.scope}>
            {scopes.map((s) => (
              <button
                key={s}
                aria-pressed={scope === s}
                disabled={busy || (s !== 'office' && !zone)}
                onClick={() => choose(s)}
              >
                {s === 'project' && !session ? d.projectPick : d.scopes[s]}
              </button>
            ))}
          </div>
          {!session && scope === 'project' && (
            <select
              className="desk-zone-pick"
              aria-label={d.project}
              value={zone}
              disabled={busy}
              onChange={(e) => choose('project', e.target.value)}
            >
              {choices.map((z) => (
                <option key={z.key} value={z.key}>
                  {z.name}
                </option>
              ))}
            </select>
          )}
          {!session && choices.length === 0 && <small>{d.noProjects}</small>}
          <div className="pet-scope-note">
            <Sparkles size={14} />
            <span>
              {scope === 'office'
                ? d.officeNote
                : scope === 'project'
                  ? d.projectNote(zoneName)
                  : d.colleagueNote}
            </span>
          </div>
        </div>
        <div className="pet-options desk-options">
          <fieldset disabled={busy || scope === 'colleague'}>
            <legend>
              01 <b>{d.chooseTop}</b>
            </legend>
            <div className="pet-color-grid desk-top-grid">
              {(Object.entries(DESK_TOPS) as [DeskTop, (typeof DESK_TOPS)[DeskTop]][]).map(
                ([id, top]) => (
                  <button
                    key={id}
                    aria-label={d.topLabel(top.name)}
                    aria-pressed={draft.top === id}
                    onClick={() => set({ top: id })}
                  >
                    <span style={{ background: top.swatch, boxShadow: `inset 0 -6px ${top.edge}` }}>
                      {draft.top === id && <Check size={13} />}
                    </span>
                    {top.name}
                  </button>
                ),
              )}
            </div>
            {scope === 'colleague' && <small className="desk-top-shared">{d.topShared}</small>}
          </fieldset>
          <fieldset disabled={busy}>
            <legend>
              02 <b>{d.chooseMonitor}</b>
            </legend>
            <div className="desk-part-grid">
              {(Object.keys(DESK_MONITORS) as DeskMonitor[]).map((id) => (
                <button
                  key={id}
                  aria-label={d.monitorLabel(DESK_MONITORS[id].name)}
                  aria-pressed={draft.monitor === id}
                  onClick={() => set({ monitor: id })}
                >
                  <i
                    className="desk-thumb monitor"
                    style={{ backgroundImage: `url(${assets({ monitor: id }).monitor})` }}
                  />
                  <span>{DESK_MONITORS[id].name}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset disabled={busy}>
            <legend>
              03 <b>{d.chooseChair}</b>
            </legend>
            <div className="desk-part-grid">
              {(Object.entries(DESK_CHAIRS) as [DeskChair, string][]).map(([id, name]) => (
                <button
                  key={id}
                  aria-label={d.chairLabel(name)}
                  aria-pressed={draft.chair === id}
                  onClick={() => set({ chair: id })}
                >
                  <i
                    className="desk-thumb chair"
                    style={{ backgroundImage: `url(${assets({ chair: id }).chair})` }}
                  />
                  <span>{name}</span>
                </button>
              ))}
            </div>
          </fieldset>
          {itemGrid('itemLeft', d.chooseLeft, '04')}
          {itemGrid('itemRight', d.chooseRight, '05')}
        </div>
      </div>
      <div className="pet-customizer-footer">
        <button className="button subtle" disabled={busy} onClick={() => void save(true)}>
          <RotateCcw size={14} />
          {scope === 'office'
            ? d.resetOffice
            : scope === 'project'
              ? d.resetProject
              : d.resetColleague}
        </button>
        <span className="pet-save-error" role="status">
          {error}
        </span>
        <button className="button subtle" disabled={busy} onClick={onClose}>
          {d.cancel}
        </button>
        <button className="button primary" disabled={busy} onClick={() => void save()}>
          {busy ? d.saving : d.save}
        </button>
      </div>
    </Modal>
  );
}
