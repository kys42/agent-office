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
const PREFERENCE_KEY = 'office:locale-preference';
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
/** The last language choice seen in a snapshot, so a demo opened later starts in the same language. */
export function savedLocalePreference(): LocalePreference | undefined {
  try {
    const value = localStorage.getItem(PREFERENCE_KEY);
    return value === 'auto' || isLocale(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
/**
 * Follows the saved language preference. For `auto` the collector's resolved language wins, so the
 * window and the collector (status reasons, connector messages, tray) never disagree; the browser's
 * own languages are only the fallback (demo, before the collector answers).
 */
export function useLocalePreference(
  preference: LocalePreference | undefined,
  ready: boolean,
  resolved?: Locale,
) {
  useEffect(() => {
    if (!ready) return;
    apply(
      pinned() ??
        (isLocale(preference)
          ? preference
          : (resolved ?? resolveLocale('auto', navigator.languages))),
    );
    if (pinned() || !preference) return;
    try {
      localStorage.setItem(PREFERENCE_KEY, preference);
    } catch {}
  }, [preference, ready, resolved]);
}
/** Re-renders on a language switch. `t` is the active catalog: `t.app.title`, `t.common.minutesAgo(3)`. */
export function useI18n() {
  const locale = useSyncExternalStore(onLocaleChange, getLocale, getLocale);
  return { locale, t: m() };
}
