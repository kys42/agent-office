import { durationLabel, officeSchedule } from '../shared/lifecycle';
import { useState } from 'react';
import { PetCustomizer } from './PetCustomizer';
import { petLook, PET_CHARACTERS, PET_ACCESSORIES } from '../shared/pets';
import {
  Plug,
  ShieldCheck,
  Folder,
  RotateCw,
  Check,
  ChevronRight,
  Copy,
  Eye,
  Pause,
  Sparkles,
  LayoutGrid,
  Terminal,
  Languages,
  X,
  Pencil,
} from 'lucide-react';
import type { Preferences, Snapshot, Provider } from '../shared/types';
import { PROVIDERS } from '../shared/types';
import { Sprite } from './Sprite';
import { shortPath, ago } from '../lib/format';
import { ZONE_MATCH_LABELS, isCustomZone, ruleZoneKey } from '../shared/zones';
import { projectKey } from '../shared/office';
import { LOCALES, type LocalePreference } from '../shared/i18n';
import { useI18n } from '../lib/i18n';
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      className={`toggle ${checked ? 'on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
    >
      <span />
    </button>
  );
}
export function Settings({
  snapshot,
  onPrefs,
  onRefresh,
  notify,
  terminalSend,
  onTerminalSend,
}: {
  snapshot: Snapshot;
  onPrefs: (p: Partial<Preferences>) => Promise<boolean>;
  onRefresh: () => void;
  notify: (s: string) => void;
  /** Desktop only; undefined hides the setting (web preview, demo). */
  terminalSend?: boolean;
  onTerminalSend?: () => void;
}) {
  const { t } = useI18n();
  const s = t.settings;
  const p = snapshot.preferences;
  const [customizing, setCustomizing] = useState<Provider | null>(null);
  const projects = [
    ...new Set([...snapshot.sessions.map((s) => s.project), ...p.excludedProjects]),
  ].sort();
  const zoneRules = p.zoneRules ?? [];
  const zones = [...new Set(zoneRules.map(ruleZoneKey))].sort(
    (a, b) => Number(isCustomZone(b)) - Number(isCustomZone(a)) || a.localeCompare(b),
  );
  const members = (key: string) =>
    snapshot.sessions.filter(
      (s) => s.area && projectKey(s) === key && s.zone === 'office' && !s.attachedTo,
    ).length;
  return (
    <div className="settings-page page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Settings</span>
          <h1>{s.title}</h1>
          <p>{s.subtitle}</p>
        </div>
      </header>
      <section className="pet-settings settings-section">
        <div className="section-title">
          <div>
            <span className="eyebrow">Little colleagues</span>
            <h2>{t.pets.settingsTitle}</h2>
          </div>
          <span className="pet-settings-count">{t.pets.newFriends}</span>
        </div>
        <p>{t.pets.settingsHint}</p>
        <div className="pet-provider-grid">
          {(['claude', 'codex', 'openclaw'] as const).map((provider) => {
            const look = petLook(provider, p.petAppearance);
            return (
              <button
                className="pet-provider-card"
                key={provider}
                onClick={() => setCustomizing(provider)}
                aria-label={t.pets.providerLabel(PROVIDERS[provider].short)}
              >
                <div className={`pet-provider-portrait face-${provider}`}>
                  <Sprite provider={provider} size={80} />
                </div>
                <div>
                  <span>{PROVIDERS[provider].short}</span>
                  <b>{PET_CHARACTERS[look.character].name}</b>
                  <small>
                    {PET_ACCESSORIES[look.accessory]} · {t.pets.changeCharacter}
                  </small>
                </div>
                <Pencil size={15} />
              </button>
            );
          })}
        </div>
      </section>
      {customizing && (
        <PetCustomizer
          provider={customizing}
          onPrefs={onPrefs}
          onClose={() => setCustomizing(null)}
        />
      )}
      <div className="settings-grid">
        <section className="settings-section">
          <div className="section-title">
            <h2>{s.connectors.title}</h2>
            <button className="icon-btn" aria-label={s.connectors.refresh} onClick={onRefresh}>
              <RotateCw size={16} />
            </button>
          </div>
          {snapshot.connectors.map((c) => (
            <div className="connector-card" key={c.provider}>
              <div className="connector-title">
                <div className={`face face-lg face-${c.provider}`}>
                  <Sprite
                    provider={c.provider}
                    mood={c.state === 'connected' ? 'idle' : 'sleep'}
                    size={40}
                  />
                </div>
                <div>
                  <h3>
                    {PROVIDERS[c.provider].name}
                    <em>{s.connectors.count(c.count)}</em>
                  </h3>
                  <span className={`connection-state connection-${c.state}`}>
                    {c.state === 'connected'
                      ? s.connectors.connected
                      : c.state === 'paused'
                        ? s.connectors.paused
                        : c.state === 'missing'
                          ? s.connectors.missing
                          : s.connectors.error}
                  </span>
                </div>
                <Toggle
                  checked={p.enabledProviders.includes(c.provider)}
                  label={s.connectors.collect(PROVIDERS[c.provider].name)}
                  onChange={() =>
                    onPrefs({
                      enabledProviders: p.enabledProviders.includes(c.provider)
                        ? p.enabledProviders.filter((x) => x !== c.provider)
                        : [...p.enabledProviders, c.provider],
                    })
                  }
                />
              </div>
              <code>{p.privacy ? s.connectors.pathHidden : shortPath(c.path)}</code>
              <p>{c.message}</p>
              <small>
                {c.lastSync ? s.connectors.checkedAgo(ago(c.lastSync)) : s.connectors.notChecked} ·{' '}
                {s.connectors.readOnly}
              </small>
            </div>
          ))}
        </section>
        <div>
          <section className="settings-section">
            <div className="setting-row">
              <Languages size={18} />
              <div>
                <b>{s.language.title}</b>
                <p>{s.language.hint}</p>
              </div>
              <select
                aria-label={s.language.title}
                value={p.locale ?? 'auto'}
                onChange={(e) => onPrefs({ locale: e.target.value as LocalePreference })}
              >
                <option value="auto">{t.common.language.auto}</option>
                {(Object.keys(LOCALES) as (keyof typeof LOCALES)[]).map((locale) => (
                  <option key={locale} value={locale}>
                    {LOCALES[locale].label}
                  </option>
                ))}
              </select>
            </div>
          </section>
          <section className="settings-section">
            <h2>{s.office.title}</h2>
            <p>{s.office.body}</p>
            <div className="setting-row">
              <div>
                <b>{s.office.autoArchive}</b>
                <p>{s.office.autoArchiveHint}</p>
              </div>
              <Toggle
                checked={p.autoArchive !== false}
                label={s.office.autoArchive}
                onChange={() =>
                  onPrefs({
                    autoArchive: p.autoArchive === false,
                    archiveDays: Math.max(
                      p.archiveDays ?? 7,
                      Math.floor((p.standbyHours ?? 4) / 24) + 1,
                    ),
                  })
                }
              />
            </div>
            <div className="lifecycle-settings">
              <label>
                {s.office.bubble}
                <select
                  aria-label={s.office.bubbleAria}
                  value={p.bubbleHours ?? 3}
                  onChange={(e) => onPrefs({ bubbleHours: Number(e.target.value) })}
                >
                  {[1, 3, 6, 12, 24].map((h) => (
                    <option key={h} value={h}>
                      {s.office.hours(h)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {s.office.ready}
                <select
                  aria-label={s.office.readyAria}
                  value={p.readyMinutes ?? 30}
                  onChange={(e) => onPrefs({ readyMinutes: Number(e.target.value) })}
                >
                  {[...new Set([10, 20, 30, 60, p.readyMinutes ?? 30])]
                    .sort((a, b) => a - b)
                    .map((m) => (
                      <option key={m} value={m} disabled={m >= (p.standbyHours ?? 4) * 60}>
                        {s.office.forMinutes(m)}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                {s.office.standby}
                <select
                  aria-label={s.office.standbyAria}
                  value={p.standbyHours ?? 4}
                  onChange={(e) => {
                    const standbyHours = Number(e.target.value);
                    const ready = p.readyMinutes ?? 30;
                    onPrefs({
                      standbyHours,
                      archiveDays: Math.max(p.archiveDays ?? 7, Math.floor(standbyHours / 24) + 1),
                      // Standing by must end before going home.
                      ...(ready >= standbyHours * 60 ? { readyMinutes: 30 } : {}),
                    });
                  }}
                >
                  {[...new Set([1, 2, 4, 8, 24, 48, 72, 168, 336, 720, 2160, p.standbyHours ?? 4])]
                    .sort((a, b) => a - b)
                    .map((h) => (
                      <option key={h} value={h}>
                        {s.office.after(durationLabel(h))}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                {s.office.archive}
                <select
                  aria-label={s.office.archiveAria}
                  disabled={p.autoArchive === false}
                  value={p.archiveDays ?? 7}
                  onChange={(e) => onPrefs({ archiveDays: Number(e.target.value) })}
                >
                  {[...new Set([1, 3, 7, 14, 30, 60, 90, 180, 365, p.archiveDays ?? 7])]
                    .sort((a, b) => a - b)
                    .map((d) => (
                      <option key={d} value={d} disabled={d * 24 <= (p.standbyHours ?? 4)}>
                        {s.office.afterDays(d)}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <p className="office-schedule-preview" aria-live="polite">
              {s.office.schedule(officeSchedule(p))}
            </p>
            <p className="helper-lifecycle-note">{s.office.helperNote}</p>
          </section>
          <section className="settings-section">
            <h2>{s.rhythm.title}</h2>
            <div className="setting-row">
              <Pause size={18} />
              <div>
                <b>{s.rhythm.pause}</b>
                <p>{s.rhythm.pauseHint}</p>
              </div>
              <Toggle
                checked={p.paused}
                label={s.rhythm.pauseAria}
                onChange={() => onPrefs({ paused: !p.paused })}
              />
            </div>
            <div className="setting-row">
              <Sparkles size={18} />
              <div>
                <b>{s.rhythm.motion}</b>
                <p>{s.rhythm.motionHint}</p>
              </div>
              <Toggle
                checked={p.reducedMotion}
                label={s.rhythm.motion}
                onChange={() => onPrefs({ reducedMotion: !p.reducedMotion })}
              />
            </div>
            <div className="setting-row">
              <Eye size={18} />
              <div>
                <b>{s.rhythm.privacy}</b>
                <p>{s.rhythm.privacyHint}</p>
              </div>
              <Toggle
                checked={p.privacy}
                label={s.rhythm.privacyAria}
                onChange={() => onPrefs({ privacy: !p.privacy })}
              />
            </div>
            {terminalSend !== undefined && onTerminalSend && (
              <div className="setting-row">
                <Terminal size={18} />
                <div>
                  <b>{s.rhythm.terminal}</b>
                  <p>{s.rhythm.terminalHint}</p>
                </div>
                <Toggle
                  checked={terminalSend}
                  label={s.rhythm.terminal}
                  onChange={onTerminalSend}
                />
              </div>
            )}
          </section>
          <section className="settings-section">
            <h2>{s.records.title}</h2>
            <p>{s.records.body}</p>
            <select
              className="record-limit"
              aria-label={s.records.aria}
              value={p.maxSessions}
              onChange={(e) => onPrefs({ maxSessions: Number(e.target.value) })}
            >
              {[60, 120, 300].map((n) => (
                <option key={n} value={n}>
                  {s.records.recent(n)}
                </option>
              ))}
            </select>
          </section>
          <section className="settings-section zone-settings">
            <h2>
              <LayoutGrid size={16} /> {s.zones.title}
            </h2>
            <p>{s.zones.body}</p>
            {zones.length === 0 ? (
              <small>{s.zones.empty}</small>
            ) : (
              <ul className="zone-list">
                {zones.map((key) => {
                  const rules = zoneRules.filter((r) => ruleZoneKey(r) === key);
                  const name = rules[0].name;
                  return (
                    <li key={key}>
                      <div className="zone-list-head">
                        {isCustomZone(key) ? (
                          <input
                            aria-label={s.zones.nameAria(name)}
                            defaultValue={name}
                            maxLength={40}
                            onBlur={(e) => {
                              const next = e.target.value.trim();
                              if (!next) e.target.value = name;
                              else if (next !== name)
                                onPrefs({
                                  zoneRules: zoneRules.map((r) =>
                                    ruleZoneKey(r) === key ? { ...r, name: next } : r,
                                  ),
                                });
                            }}
                            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                          />
                        ) : (
                          <b title={s.zones.projectRuleTitle}>
                            {p.privacy ? s.projectHidden : name}
                            <em>{s.zones.projectZone}</em>
                          </b>
                        )}
                        <small>{s.zones.sent(members(key))}</small>
                      </div>
                      <div className="project-chips">
                        {rules.map((r) => (
                          <button
                            key={r.id}
                            title={s.zones.removeRule(r.value)}
                            onClick={() =>
                              onPrefs({ zoneRules: zoneRules.filter((x) => x.id !== r.id) })
                            }
                          >
                            {ZONE_MATCH_LABELS[r.match]} ·{' '}
                            {p.privacy
                              ? s.zones.hidden
                              : r.match === 'session'
                                ? s.zones.oneSession
                                : r.match === 'branch'
                                  ? r.value
                                  : shortPath(r.value)}
                            <X size={11} />
                          </button>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section className="settings-section scope-settings">
            <h2>{s.exclude.title}</h2>
            <p>{s.exclude.body}</p>
            <div className="project-chips">
              {projects.map((project) => (
                <button
                  key={project}
                  className={p.excludedProjects.includes(project) ? 'excluded' : ''}
                  onClick={() =>
                    onPrefs({
                      excludedProjects: p.excludedProjects.includes(project)
                        ? p.excludedProjects.filter((x) => x !== project)
                        : [...p.excludedProjects, project],
                    })
                  }
                >
                  {p.excludedProjects.includes(project) && <Check size={12} />}{' '}
                  {p.privacy ? s.projectHidden : project}
                </button>
              ))}
            </div>
          </section>
          <section className="local-promise">
            <ShieldCheck size={25} />
            <div>
              <h3>{s.local.title}</h3>
              <p>{s.local.body}</p>
            </div>
          </section>
          <section className="settings-section mcp-card">
            <span className="eyebrow">MEMORY, WITH YOUR AGENTS</span>
            <h2>{s.mcp.title}</h2>
            <p>
              {s.mcp.bodyBefore}
              <code>npm run mcp</code>
              {s.mcp.bodyAfter}
            </p>
            <small>{s.mcp.footnote}</small>
          </section>
        </div>
      </div>
    </div>
  );
}
