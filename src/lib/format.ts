import { intlLocale, m } from '../shared/i18n';
export const compact = (n: number | null) =>
  n === null
    ? '—'
    : n >= 1e6
      ? (n / 1e6).toFixed(1) + 'M'
      : n >= 1e3
        ? (n / 1e3).toFixed(1) + 'k'
        : String(n);
export const ago = (at: number) => {
  const t = m().common;
  const min = Math.max(0, Math.floor((Date.now() - at) / 60000));
  return min < 1
    ? t.justNow
    : min < 60
      ? t.minutesAgo(min)
      : min < 1440
        ? t.hoursAgo(Math.floor(min / 60))
        : t.daysAgo(Math.floor(min / 1440));
};
export const time = (at: number) =>
  new Date(at).toLocaleTimeString(intlLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
export const date = (at: number) =>
  new Date(at).toLocaleDateString(intlLocale(), {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
export const shortPath = (s: string | null) =>
  s?.replace(/^\/Users\/[^/]+/, '~') ?? m().common.pathUnknown;
