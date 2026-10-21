import { durationLabel, officeSchedule } from '../shared/lifecycle';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { PetCustomizer } from './PetCustomizer';
import { MobileSettings } from './MobileSettings';
import { FederationSettings } from './FederationSettings';
import { petLook, PET_CHARACTERS, PET_ACCESSORIES } from '../shared/pets';
import {
  ShieldCheck,
  RotateCw,
  Check,
  Eye,
  Pause,
  Sparkles,
  LayoutGrid,
  Terminal,
  Languages,
  X,
  Pencil,
  MessageCircleQuestion,
  ShieldQuestion,
  SlidersHorizontal,
  Palette,
  Building2,
  Plug,
  Database,
  Bell,
  BellRing,
  Volume2,
  BookOpenCheck,
  Timer,
  Tag,
  CircleDot,
  PanelBottom,
  MoveHorizontal,
  Columns3,
  Users,
  Layers,
  Clock,
  type LucideIcon,
} from 'lucide-react';
import type { AnswerSettings, Preferences, Snapshot, Provider } from '../shared/types';
import { PROVIDERS } from '../shared/types';
import { Sprite } from './Sprite';
import { shortPath, ago } from '../lib/format';
import { ZONE_MATCH_LABELS, isCustomZone, ruleZoneKey } from '../shared/zones';
import { projectKey } from '../shared/office';
import { LOCALES, type LocalePreference } from '../shared/i18n';
import { useI18n } from '../lib/i18n';
import { isWindows } from '../lib/platform';
import { isDesktop } from '../lib/api';
import { notifyPreferences } from '../shared/notify-plan';
import { cardReadSettings } from '../shared/card-reads';
import {
  DOCK_PILL_CHOICES,
  HELPER_RETAIN_CHOICES,
  HELPER_STACK_CHOICES,
  READ_DWELL_CHOICES,
  viewPrefs,
} from '../shared/view-prefs';
import {
  SETTINGS_CATEGORIES,
  settingsAnchor,
  settingsCategory,
  type SettingsCategory,
  type SettingsSection,
} from '../shared/settings';
export type { SettingsSection } from '../shared/settings';
const CATEGORY_KEY = 'agent-office:settings-category';
function lastPageCategory(): SettingsCategory {
  try {
    const saved = sessionStorage.getItem(CATEGORY_KEY);
    return (SETTINGS_CATEGORIES as readonly string[]).includes(saved ?? '')
      ? (saved as SettingsCategory)
      : 'general';
  } catch {
    return 'general';
  }
}
const CATEGORY_ICONS: Record<SettingsCategory, LucideIcon> = {
  general: SlidersHorizontal,
  appearance: Palette,
  office: Building2,
  spaces: LayoutGrid,
  connections: Plug,
  records: Database,
};
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
/**
 * One settings surface, two frames: the big office's page (category list on the left) and the
 * settings window (tabs on top). Every control and deep link is the same in both.
 */
export function Settings({
  demo = false,
  layout = 'page',
  snapshot,
  onPrefs,
  onRefresh,
  notify,
  terminalSend,
  onTerminalSend,
  answers,
  onAnswers,
  focusSection,
  onSectionFocused,
}: {
  demo?: boolean;
  layout?: 'page' | 'popup';
  snapshot: Snapshot;
  onPrefs: (p: Partial<Preferences>) => Promise<boolean>;
  onRefresh: () => void;
  notify: (s: string) => void;
  /** Desktop only; undefined hides the setting (web preview, demo). */
  terminalSend?: boolean;
  onTerminalSend?: () => void;
  /** Desktop only; undefined hides the answering settings (web preview, demo). */
  answers?: AnswerSettings;
  onAnswers?: (key: keyof AnswerSettings) => void;
  focusSection?: { section: SettingsSection; at: number };
  onSectionFocused?: () => void;
}) {
  const { t } = useI18n();
  const s = t.settings;
  const p = snapshot.preferences;
  const view = viewPrefs(p);
  const read = cardReadSettings(p);
  const dwell = read.dwellMs / 1000;
  const retainMinutes = Math.round(view.helperUnfinishedMs / 60_000);
  /** A reset stamp every window hears (the dock and the big office are other renderers). */
  const stampReset = async (
    key: 'dockPillResetAt' | 'panelWidthsResetAt',
    done: string,
  ): Promise<void> => {
    if (await onPrefs({ [key]: Date.now() })) notify(done);
  };
  const [customizing, setCustomizing] = useState<Provider | null>(null);
  const [category, setCategory] = useState<SettingsCategory>(() =>
    focusSection
      ? settingsCategory(focusSection.section)
      : layout === 'page'
        ? lastPageCategory()
        : 'general',
  );
  // The page comes back to the category last open in this session.
  useEffect(() => {
    if (layout !== 'page') return;
    try {
      sessionStorage.setItem(CATEGORY_KEY, category);
    } catch {
      /* storage blocked: start at the first category next time */
    }
  }, [layout, category]);
  // A deep link first switches category, then scrolls once that category is drawn.
  const [pending, setPending] = useState<SettingsSection | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const ids = useId();
  useEffect(() => {
    if (!focusSection) return;
    setCategory(settingsCategory(focusSection.section));
    setPending(focusSection.section);
    onSectionFocused?.();
  }, [focusSection, onSectionFocused]);
  useEffect(() => {
    if (!pending) return;
    // A desktop-only section missing or empty here (web preview) falls back to its category's top.
    const found = panel.current?.querySelector<HTMLElement>(
      `.settings-category[data-category="${category}"] [data-guide-section="${settingsAnchor(pending)}"]`,
    );
    const section = found && found.offsetHeight > 0 ? found : panel.current;
    section?.scrollIntoView({ block: 'start' });
    section?.focus({ preventScroll: true });
    setPending(null);
  }, [pending, category]);
  const choose = (next: SettingsCategory) => {
    setCategory(next);
    panel.current?.scrollIntoView({ block: 'nearest' });
  };
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    // The page's list is vertical (Up/Down), the window's tabs horizontal (Left/Right).
    const step = (
      layout === 'page'
        ? { ArrowDown: 1, ArrowUp: -1 }
        : ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)
    )[e.key];
    const edge = e.key === 'Home' ? 0 : e.key === 'End' ? SETTINGS_CATEGORIES.length - 1 : null;
    if (step === undefined && edge === null) return;
    e.preventDefault();
    const at = SETTINGS_CATEGORIES.indexOf(category);
    const next =
      SETTINGS_CATEGORIES[
        edge ?? (at + step! + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length
      ];
    choose(next);
    root.current?.querySelector<HTMLElement>(`#${CSS.escape(`${ids}-tab-${next}`)}`)?.focus();
  };
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
  const general = (
    <>
      <section className="settings-section" data-guide-section="language" tabIndex={-1}>
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
      <section className="settings-section" data-guide-section="privacy" tabIndex={-1}>
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
      </section>
      <section className="settings-section" data-guide-section="reading" tabIndex={-1}>
        <h2>{s.reading.title}</h2>
        <div className="setting-row">
          <BookOpenCheck size={18} />
          <div>
            <b>{s.reading.readOnOpen}</b>
            <p>{s.reading.readOnOpenHint}</p>
          </div>
          <Toggle
            checked={read.enabled}
            label={s.reading.readOnOpen}
            onChange={() => onPrefs({ readOnOpen: !read.enabled })}
          />
        </div>
        <div className="setting-row">
          <Timer size={18} />
          <div>
            <b>{s.reading.dwell}</b>
            {read.enabled && dwell === 0 && <p>{s.reading.nowHint}</p>}
          </div>
          <select
            aria-label={s.reading.dwellAria}
            disabled={!read.enabled}
            value={dwell}
            onChange={(e) => onPrefs({ readDwellSeconds: Number(e.target.value) })}
          >
            {[...new Set([...READ_DWELL_CHOICES, dwell])]
              .sort((a, b) => a - b)
              .map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? s.reading.now : s.reading.seconds(n)}
                </option>
              ))}
          </select>
        </div>
      </section>
      {isDesktop && !demo && (
        <section className="settings-section" data-guide-section="notifications" tabIndex={-1}>
          <h2>{s.notifications.title}</h2>
          {(
            [
              ['finals', BellRing],
              ['calls', Bell],
              ['sound', Volume2],
            ] as const
          ).map(([key, Icon]) => {
            const want = notifyPreferences(p);
            return (
              <div className="setting-row" key={key}>
                <Icon size={18} />
                <div>
                  <b>{s.notifications[key]}</b>
                  <p>{s.notifications[`${key}Hint`]}</p>
                </div>
                <Toggle
                  checked={want[key]}
                  label={s.notifications[key]}
                  onChange={() => onPrefs({ notifications: { ...want, [key]: !want[key] } })}
                />
              </div>
            );
          })}
          <p className="notify-history-note">{s.notifications.historyNote}</p>
        </section>
      )}
      {((terminalSend !== undefined && onTerminalSend) || (answers && onAnswers)) && (
        <section className="settings-section" data-guide-section="terminal" tabIndex={-1}>
          <h2>{s.terminalTitle}</h2>
          {terminalSend !== undefined && onTerminalSend && (
            <div className="setting-row">
              <Terminal size={18} />
              <div>
                <b>{s.rhythm.terminal}</b>
                <p>{s.rhythm.terminalHint}</p>
              </div>
              <Toggle checked={terminalSend} label={s.rhythm.terminal} onChange={onTerminalSend} />
            </div>
          )}
          {answers &&
            onAnswers &&
            (['questions', 'permissions'] as const).map((key) => (
              <div className="setting-row" key={key}>
                {key === 'questions' ? (
                  <MessageCircleQuestion size={18} />
                ) : (
                  <ShieldQuestion size={18} />
                )}
                <div>
                  <b>{t.prompts.settings[key]}</b>
                  <p>
                    {key === 'questions'
                      ? t.prompts.settings.questionsHint
                      : t.prompts.settings.permissionsHint}
                  </p>
                </div>
                <Toggle
                  checked={answers[key] === 'on'}
                  label={t.prompts.settings[key]}
                  onChange={() => onAnswers(key)}
                />
              </div>
            ))}
        </section>
      )}
      <section className="local-promise">
        <ShieldCheck size={25} />
        <div>
          <h3>{s.local.title}</h3>
          <p>{s.local.body}</p>
        </div>
      </section>
    </>
  );
  const appearance = (
    <>
      <section
        className="pet-settings settings-section"
        data-guide-section="appearance"
        tabIndex={-1}
      >
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
      <section className="settings-section" data-guide-section="motion" tabIndex={-1}>
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
      </section>
      {/* The floating dock is the desktop app's; a browser has no dock window to set up. */}
      {isDesktop && (
        <section className="settings-section" data-guide-section="dock" tabIndex={-1}>
          <h2>{s.dock.title}</h2>
          <div className="setting-row">
            <Tag size={18} />
            <div>
              <b>{s.dock.tinyNames}</b>
              <p>{s.dock.tinyNamesHint}</p>
            </div>
            <Toggle
              checked={view.tinyNames}
              label={s.dock.tinyNames}
              onChange={() => onPrefs({ tinyNames: !view.tinyNames })}
            />
          </div>
          <div className="setting-row">
            <CircleDot size={18} />
            <div>
              <b>{s.dock.tinyFinalDot}</b>
              <p>{s.dock.tinyFinalDotHint}</p>
            </div>
            <Toggle
              checked={view.tinyFinalDot}
              label={s.dock.tinyFinalDot}
              onChange={() => onPrefs({ tinyFinalDot: !view.tinyFinalDot })}
            />
          </div>
          <div className="setting-row">
            <PanelBottom size={18} />
            <div>
              <b>{s.dock.pill}</b>
              <p>{s.dock.pillHint}</p>
            </div>
            <select
              aria-label={s.dock.pill}
              value={view.dockPill}
              onChange={(e) => onPrefs({ dockPill: e.target.value as typeof view.dockPill })}
            >
              {DOCK_PILL_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {s.dock.pillChoices[choice]}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <MoveHorizontal size={18} />
            <div>
              <b>{s.dock.pillReset}</b>
              <p>{s.dock.pillResetHint}</p>
            </div>
            <button
              type="button"
              className="setting-action"
              aria-label={s.dock.pillReset}
              onClick={() => void stampReset('dockPillResetAt', s.dock.pillResetDone)}
            >
              {s.dock.resetButton}
            </button>
          </div>
        </section>
      )}
      <section className="settings-section" data-guide-section="panels" tabIndex={-1}>
        <h2>{s.panels.title}</h2>
        <div className="setting-row">
          <Columns3 size={18} />
          <div>
            <b>{s.panels.reset}</b>
            <p>{s.panels.resetHint}</p>
          </div>
          <button
            type="button"
            className="setting-action"
            aria-label={s.panels.reset}
            onClick={() => void stampReset('panelWidthsResetAt', s.panels.resetDone)}
          >
            {s.dock.resetButton}
          </button>
        </div>
      </section>
    </>
  );
  const office = (
    <>
      <section className="settings-section" data-guide-section="office" tabIndex={-1}>
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
      <section className="settings-section" data-guide-section="helpers" tabIndex={-1}>
        <h2>{s.helpers.title}</h2>
        <div className="setting-row">
          <Users size={18} />
          <div>
            <b>{s.helpers.show}</b>
            <p>{s.helpers.showHint}</p>
          </div>
          <Toggle
            checked={view.helperDesks}
            label={s.helpers.show}
            onChange={() => onPrefs({ helperDesks: !view.helperDesks })}
          />
        </div>
        <div className="setting-row">
          <Layers size={18} />
          <div>
            <b>{s.helpers.stackAt}</b>
          </div>
          <select
            aria-label={s.helpers.stackAtAria}
            disabled={!view.helperDesks}
            value={view.helperStackAt}
            onChange={(e) => onPrefs({ helperStackAt: Number(e.target.value) })}
          >
            {HELPER_STACK_CHOICES.map((n) => (
              <option key={n} value={n}>
                {s.helpers.people(n)}
              </option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <Clock size={18} />
          <div>
            <b>{s.helpers.retain}</b>
          </div>
          <select
            aria-label={s.helpers.retainAria}
            value={retainMinutes}
            onChange={(e) => onPrefs({ helperRetainMinutes: Number(e.target.value) })}
          >
            {[...new Set([...HELPER_RETAIN_CHOICES, retainMinutes])]
              .sort((a, b) => a - b)
              .map((m) => (
                <option key={m} value={m}>
                  {s.helpers.minutes(m)}
                </option>
              ))}
          </select>
        </div>
      </section>
    </>
  );
  const spaces = (
    <section className="settings-section zone-settings" data-guide-section="zones" tabIndex={-1}>
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
                      onClick={() => onPrefs({ zoneRules: zoneRules.filter((x) => x.id !== r.id) })}
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
  );
  const connections = (
    <>
      <section className="settings-section" data-guide-section="connections" tabIndex={-1}>
        {isWindows && <p className="windows-support-note">{s.windowsSupport}</p>}
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
      {!demo && (
        <div className="settings-anchor" data-guide-section="federation" tabIndex={-1}>
          <FederationSettings snapshot={snapshot.federation} />
        </div>
      )}
      {!demo && (
        <div className="settings-anchor" data-guide-section="mobile" tabIndex={-1}>
          <MobileSettings privacy={p.privacy} />
        </div>
      )}
    </>
  );
  const records = (
    <>
      <section className="settings-section" data-guide-section="records" tabIndex={-1}>
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
      <section
        className="settings-section scope-settings"
        data-guide-section="exclude"
        tabIndex={-1}
      >
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
      <section className="settings-section mcp-card" data-guide-section="mcp" tabIndex={-1}>
        <span className="eyebrow">MEMORY, WITH YOUR AGENTS</span>
        <h2>{s.mcp.title}</h2>
        <p>
          {s.mcp.bodyBefore}
          <code>npm run mcp</code>
          {s.mcp.bodyAfter}
        </p>
        <small>{s.mcp.footnote}</small>
      </section>
    </>
  );
  // Every category stays mounted and only the open one is shown, so stateful parts (the
  // federation and phone pairing panels) keep their state across tab switches.
  const panels = { general, appearance, office, spaces, connections, records };
  return (
    <div
      className={`settings-page settings-${layout}${layout === 'page' ? ' page' : ''}`}
      ref={root}
    >
      {layout === 'page' && (
        <header className="page-head">
          <div>
            <span className="eyebrow">Settings</span>
            <h1>{s.title}</h1>
            <p>{s.subtitle}</p>
          </div>
        </header>
      )}
      <div className="settings-layout">
        <div
          className="settings-nav"
          role="tablist"
          aria-label={s.categoriesAria}
          aria-orientation={layout === 'page' ? 'vertical' : 'horizontal'}
        >
          {SETTINGS_CATEGORIES.map((c) => {
            const Icon = CATEGORY_ICONS[c];
            return (
              <button
                key={c}
                id={`${ids}-tab-${c}`}
                role="tab"
                aria-selected={c === category}
                aria-controls={`${ids}-panel`}
                tabIndex={c === category ? 0 : -1}
                data-category={c}
                onClick={() => choose(c)}
                onKeyDown={onTabKey}
              >
                <Icon size={15} />
                <span>{s.categories[c].label}</span>
              </button>
            );
          })}
        </div>
        <div
          className="settings-panel"
          role="tabpanel"
          id={`${ids}-panel`}
          aria-labelledby={`${ids}-tab-${category}`}
          data-category={category}
          tabIndex={-1}
          ref={panel}
        >
          <header className="settings-panel-head">
            <h2>{s.categories[category].label}</h2>
            <p>{s.categories[category].hint}</p>
          </header>
          {SETTINGS_CATEGORIES.map((c) => (
            <div key={c} className="settings-category" data-category={c} hidden={c !== category}>
              {panels[c]}
            </div>
          ))}
        </div>
      </div>
      {customizing && (
        <PetCustomizer
          provider={customizing}
          onPrefs={onPrefs}
          onClose={() => setCustomizing(null)}
        />
      )}
    </div>
  );
}
