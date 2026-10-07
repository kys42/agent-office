import { useMemo, useState } from 'react';
import { LayoutGrid, Plus, Undo2 } from 'lucide-react';
import type { Session, ZoneRule } from '../shared/types';
import { projectKey } from '../shared/office';
import { ZONE_MATCH_LABELS, sendToZone, zoneCandidates, zoneOptions } from '../shared/zones';
import { shortPath } from '../lib/format';
import { useI18n } from '../lib/i18n';

/** Explicit office areas: pick an existing zone or name a new one, then choose who follows. */
export function ZoneEditor({
  session,
  sessions,
  rules,
  onRules,
  onClose,
  initialZone,
}: {
  session: Session;
  sessions: Session[];
  rules: ZoneRule[];
  onRules: (rules: ZoneRule[]) => Promise<void>;
  onClose: () => void;
  /** Zone key preselected by a drop; `null` opens a new zone. */
  initialZone?: string | null;
}) {
  const { t } = useI18n();
  const z = t.zoneEditor;
  const here = projectKey(session);
  const zones = useMemo(() => zoneOptions(sessions, rules), [sessions, rules]);
  const candidates = useMemo(() => zoneCandidates(session), [session]);
  const current = rules.find((r) => r.id === session.area?.ruleId);
  const known = current ? candidates.findIndex((c) => c.match === current.match) : -1;
  const initial = Math.max(0, known);
  const [zone, setZone] = useState<string | null>(
    initialZone !== undefined
      ? initialZone
      : (zones.find((z) => z.key !== here && z.custom)?.key ?? null),
  );
  const [name, setName] = useState('');
  const [scope, setScope] = useState(initial);
  const [value, setValue] = useState(known >= 0 ? current!.value : candidates[initial].value);
  const [busy, setBusy] = useState(false);
  const target = { ...candidates[scope], value: value.trim() };
  const editable = target.match === 'branch' || target.match === 'path';
  const label = name.trim();
  const chosen = zone ? zones.find((z) => z.key === zone) : null;
  const destination = chosen ?? (label ? { key: `area:${label}`, name: label } : null);
  const unchanged = destination?.key === here && !current;

  const save = async (next: ZoneRule[]) => {
    setBusy(true);
    try {
      await onRules(next);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="zone-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!destination || !target.value || unchanged) return;
        void save(sendToZone(session, rules, target, destination));
      }}
    >
      <div className="zone-editor-head">
        <LayoutGrid size={13} />
        <b>{z.title}</b>
        <small>{z.subtitle}</small>
      </div>
      <fieldset className="zone-picker">
        <legend>{z.destination}</legend>
        <div>
          {zones.map((o) => (
            <button
              type="button"
              key={o.key}
              aria-pressed={zone === o.key}
              className={`${o.custom ? 'custom' : ''} ${zone === o.key ? 'active' : ''}`}
              onClick={() => setZone(o.key)}
            >
              <span>{o.name}</span>
              <small>{o.key === here ? z.here : o.custom ? z.members(o.count) : z.project}</small>
            </button>
          ))}
          <button
            type="button"
            aria-pressed={zone === null}
            className={`new ${zone === null ? 'active' : ''}`}
            onClick={() => setZone(null)}
          >
            <Plus size={11} /> {z.newZone}
          </button>
        </div>
      </fieldset>
      {zone === null && (
        <label>
          {z.newZoneName}
          <input
            autoFocus
            value={name}
            maxLength={40}
            placeholder={z.placeholder}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      )}
      <fieldset>
        <legend>{z.who}</legend>
        {candidates.map((c, i) => (
          <label key={c.match} className={scope === i ? 'active' : ''}>
            <input
              type="radio"
              name="zone-scope"
              checked={scope === i}
              onChange={() => {
                setScope(i);
                setValue(c.value);
              }}
            />
            <span>{ZONE_MATCH_LABELS[c.match]}</span>
            <code title={c.value}>
              {c.match === 'session'
                ? z.thisSession
                : c.match === 'branch'
                  ? c.value
                  : shortPath(c.value)}
            </code>
          </label>
        ))}
      </fieldset>
      {editable && (
        <label>
          {target.match === 'branch' ? z.branchPattern : z.folderPath}
          <input value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
          <small>{target.match === 'branch' ? z.branchHint : z.folderHint}</small>
        </label>
      )}
      <p className="fine-print">
        {target.repo ? z.sameRepo : ''}
        {z.fine}
      </p>
      <div className="zone-editor-actions">
        {current && (
          <button
            type="button"
            className="button subtle"
            disabled={busy}
            onClick={() => void save(rules.filter((r) => r.id !== current.id))}
            title={z.removeTitle(ZONE_MATCH_LABELS[current.match])}
          >
            <Undo2 size={13} /> {z.backToProject}
          </button>
        )}
        <button type="button" className="button subtle" onClick={onClose}>
          {z.cancel}
        </button>
        <button
          className="button primary"
          disabled={busy || !destination || !target.value || unchanged}
        >
          {destination ? z.sendTo(destination.name) : z.assign}
        </button>
      </div>
    </form>
  );
}
