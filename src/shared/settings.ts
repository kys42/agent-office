/**
 * Settings are grouped into categories (#87): a left list on the big office's page and top
 * tabs in the settings window. A section is a deep-link target (`data-guide-section`) that
 * lives in exactly one category; a category id also works as a section (its top).
 */
export const SETTINGS_CATEGORIES = [
  'general',
  'appearance',
  'office',
  'spaces',
  'connections',
  'records',
] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

const SECTION_CATEGORY = {
  general: 'general',
  language: 'general',
  privacy: 'general',
  notifications: 'general',
  terminal: 'general',
  reading: 'general',
  appearance: 'appearance',
  motion: 'appearance',
  text: 'appearance',
  dock: 'appearance',
  panels: 'appearance',
  glass: 'appearance',
  office: 'office',
  helpers: 'office',
  spaces: 'spaces',
  zones: 'spaces',
  connections: 'connections',
  federation: 'connections',
  mobile: 'connections',
  records: 'records',
  exclude: 'records',
  mcp: 'records',
  // The single long page before #87 called pause·motion·privacy·terminal "rhythm".
  rhythm: 'general',
} as const satisfies Record<string, SettingsCategory>;
export type SettingsSection = keyof typeof SECTION_CATEGORY;

export const isSettingsSection = (v: unknown): v is SettingsSection =>
  typeof v === 'string' && Object.hasOwn(SECTION_CATEGORY, v);
export const settingsCategory = (section: SettingsSection): SettingsCategory =>
  SECTION_CATEGORY[section];
/** The anchor to scroll to: old ids point at the section that took over their controls. */
export const settingsAnchor = (section: SettingsSection): string =>
  section === 'rhythm' ? 'privacy' : section;
/** `#settings` or `#settings=<section>` opens the settings window (see main.tsx). */
export const settingsHashSection = (hash: string): SettingsSection | undefined => {
  const section = /^#settings(?:=([\w-]+))?$/.exec(hash)?.[1];
  return isSettingsSection(section) ? section : undefined;
};
