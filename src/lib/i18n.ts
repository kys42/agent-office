import { useEffect, useSyncExternalStore } from 'react';
import {
  getLocale,
  isLocale,
  m,
  onLocaleChange,
  resolveLocale,
  setLocale,
  type Locale,
  type LocalePreference,
} from '../shared/i18n';
const STORAGE_KEY = 'office:locale';
// `?lang=en|ko` pins the language for previews, screenshots and tests without touching settings.
const pinned = (): Locale | null => {
  const lang = new URLSearchParams(location.search).get('lang');
  return isLocale(lang) ? lang : null;
};
function apply(locale: Locale) {
  setLocale(locale);
  document.documentElement.lang = locale;
  if (pinned()) return;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {}
}
/** First paint reuses the last language so the office doesn't flash before the snapshot arrives. */
export function bootLocale() {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {}
  apply(pinned() ?? resolveLocale(isLocale(stored) ? stored : 'auto', navigator.languages));
}
/** Follows the saved language preference; `auto` uses the system language, falling back to English. */
export function useLocalePreference(preference: LocalePreference | undefined, ready: boolean) {
  useEffect(() => {
    if (ready) apply(pinned() ?? resolveLocale(preference, navigator.languages));
  }, [preference, ready]);
}
/** Re-renders on a language switch. `t` is the active catalog: `t.app.title`, `t.common.minutesAgo(3)`. */
export function useI18n() {
  const locale = useSyncExternalStore(onLocaleChange, getLocale, getLocale);
  return { locale, t: m() };
}
