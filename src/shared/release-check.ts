import type { Preferences } from './types';

/**
 * Settings › General › Updates (#369): may the installed app ask GitHub for a newer release?
 * Missing means on; preferences not loaded yet count as off, so nothing leaves before they are.
 */
export const wantsReleaseCheck = (p?: Pick<Preferences, 'startupUpdateCheck'> | null) =>
  !!p && p.startupUpdateCheck !== false;
