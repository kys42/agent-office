import { en, type Messages } from './locales/en';
import { ko } from './locales/ko';
// Shared by the UI, the collector and the desktop shell. Each process keeps its own active
// language; English is the source catalog and the fallback for unsupported system languages.
export type Locale = 'en' | 'ko';
export type LocalePreference = 'auto' | Locale;
export type { Messages };
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALES: Record<Locale, { label: string; intl: string }> = {
  en: { label: 'English', intl: 'en-US' },
  ko: { label: '한국어', intl: 'ko-KR' },
};
const catalog: Record<Locale, Messages> = { en, ko };
export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && Object.hasOwn(catalog, value);
/** An explicit choice wins; `auto` takes the first supported system language, else English. */
export function resolveLocale(
  preference: LocalePreference | undefined,
  system: readonly (string | null | undefined)[] = [],
): Locale {
  if (isLocale(preference)) return preference;
  for (const tag of system) {
    const base = tag?.toLowerCase().split(/[-_.@]/)[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();
export const getLocale = () => current;
export function setLocale(next: Locale): boolean {
  if (next === current) return false;
  current = next;
  for (const listener of listeners) listener();
  return true;
}
export function onLocaleChange(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
/** Messages for the active language. Read at use time so a language switch is never stale. */
export const m = (): Messages => catalog[current];
export const messagesFor = (locale: Locale): Messages => catalog[locale];
/** BCP 47 tag for Intl/Date formatting in the active language. */
export const intlLocale = () => LOCALES[current].intl;
