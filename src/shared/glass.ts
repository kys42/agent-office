import type { Preferences } from './types';

/** The most see-through the slider goes: past this, words over a busy wallpaper stop reading. */
export const GLASS_MAX = 70;
export const GLASS_STEP = 5;

/**
 * The chosen see-through level (0 … GLASS_MAX percent), or null for each platform's look from
 * before: on macOS a frosted system material under the card, on Windows a 90% tint.
 */
export function glassLevel(p?: Pick<Preferences, 'windowGlass'> | null): number | null {
  const v = p?.windowGlass;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(GLASS_MAX, Math.max(0, Math.round(v)));
}
