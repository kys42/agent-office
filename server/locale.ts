import { resolveLocale, setLocale, type LocalePreference } from '../src/shared/i18n/index.js';

/**
 * System language candidates for this process, most specific first.
 * `AGENT_OFFICE_LOCALE` is a deterministic override (tests, CI, screenshots);
 * `AGENT_OFFICE_SYSTEM_LANGUAGES` carries the OS preference list from the desktop shell.
 */
export function systemLanguages(): string[] {
  return [
    process.env.AGENT_OFFICE_LOCALE,
    ...(process.env.AGENT_OFFICE_SYSTEM_LANGUAGES?.split(',') ?? []),
    Intl.DateTimeFormat().resolvedOptions().locale,
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
  ]
    .map((tag) => tag?.trim())
    .filter((tag): tag is string => !!tag);
}

/** Applies the saved preference to this process. Returns whether the language changed. */
export const syncLocale = (preference: LocalePreference | undefined) =>
  setLocale(resolveLocale(preference, systemLanguages()));
