import type { DockPillVisibility, Preferences } from './types';
import { HELPER_STACK_AT } from './office-layout';
import { HELPER_UNFINISHED_MS } from './residents';

/**
 * The view preferences of #228 with their defaults filled in: every window (big office, dock,
 * card, settings) reads them the same way, and a missing value is the behaviour from before.
 */
export interface ViewPrefs {
  tinyNames: boolean;
  tinyFinalDot: boolean;
  dockPill: DockPillVisibility;
  dockPillResetAt: number | null;
  panelWidthsResetAt: number | null;
  helperDesks: boolean;
  helperStackAt: number;
  /** Milliseconds a quiet helper still mid-task keeps its desk. */
  helperUnfinishedMs: number;
}

export const DEFAULT_HELPER_STACK_AT = HELPER_STACK_AT;
export const DEFAULT_HELPER_RETAIN_MINUTES = HELPER_UNFINISHED_MS / 60_000;
export const DOCK_PILL_CHOICES: readonly DockPillVisibility[] = ['always', 'subdued', 'hover'];
export const HELPER_STACK_CHOICES = [2, 3, 4, 5, 6, 7, 8] as const;
export const HELPER_RETAIN_CHOICES = [10, 30, 60, 120] as const;
export const READ_DWELL_CHOICES = [0, 1.5, 3, 5] as const;

const stamp = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);

export function viewPrefs(p?: Partial<Preferences> | null): ViewPrefs {
  return {
    tinyNames: p?.tinyNames !== false,
    tinyFinalDot: p?.tinyFinalDot !== false,
    dockPill: DOCK_PILL_CHOICES.includes(p?.dockPill as DockPillVisibility)
      ? p!.dockPill!
      : 'subdued',
    dockPillResetAt: stamp(p?.dockPillResetAt),
    panelWidthsResetAt: stamp(p?.panelWidthsResetAt),
    helperDesks: p?.helperDesks !== false,
    helperStackAt: helperStackAt(p),
    helperUnfinishedMs: helperUnfinishedMs(p),
  };
}

export const helperStackAt = (p?: Pick<Preferences, 'helperStackAt'> | null) =>
  Number.isInteger(p?.helperStackAt) && p!.helperStackAt! >= 2
    ? p!.helperStackAt!
    : DEFAULT_HELPER_STACK_AT;

export const helperUnfinishedMs = (p?: Pick<Preferences, 'helperRetainMinutes'> | null) =>
  (typeof p?.helperRetainMinutes === 'number' && p.helperRetainMinutes > 0
    ? p.helperRetainMinutes
    : DEFAULT_HELPER_RETAIN_MINUTES) * 60_000;

/**
 * A remembered layout (the pill's spot, the column widths) is forgotten when the person asked
 * for a reset after it was saved. The stamp is a preference so every window hears it — the dock
 * and the big office are other renderers than the settings window that pressed the button.
 */
export const resetDue = (resetAt: number | null | undefined, savedAt: number | null | undefined) =>
  !!resetAt && resetAt > (savedAt ?? 0);
