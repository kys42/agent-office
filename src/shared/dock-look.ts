import type { DockMode } from './types';

/**
 * How the dock looks: the pet, the desk row or the floor, and whether the row/floor is drawn
 * tiny (쪼꼬미). The desktop main process owns it; the dock and the big office only read it.
 */
export interface DockLook {
  mode: DockMode;
  tiny: boolean;
}
export const DEFAULT_DOCK_LOOK: DockLook = { mode: 'pet', tiny: false };

/** The look by name: tiny only changes the row and the floor (the pet keeps its size). */
export type DockLookName = 'pet' | 'row' | 'floor' | 'tinyRow' | 'tinyFloor';
export function dockLookName(look: DockLook): DockLookName {
  if (look.mode === 'pet') return 'pet';
  if (!look.tiny) return look.mode;
  return look.mode === 'floor' ? 'tinyFloor' : 'tinyRow';
}

/** A look sent across windows; anything unreadable is the pet at its normal size. */
export function readDockLook(raw: unknown): DockLook {
  const p = raw as { mode?: unknown; tiny?: unknown } | null;
  if (!p || typeof p !== 'object') return DEFAULT_DOCK_LOOK;
  const mode = p.mode === 'row' || p.mode === 'floor' || p.mode === 'pet' ? p.mode : 'pet';
  return { mode, tiny: p.tiny === true };
}

/** What the dock's 보기 menu offers: the three looks and the tiny toggle. */
export type DockViewChoice = DockMode | 'tiny';
/** The change a choice asks for: a size first (when any), then a look (when it differs). */
export interface DockViewStep {
  tiny?: boolean;
  mode?: DockMode;
}
/**
 * The 보기 menu's choice applied to the current look. A look keeps the tiny setting (it is a
 * modifier of the row and floor); the tiny toggle flips it, and from the pet it unfolds to the
 * last unfolded look (`unfold`, the row or the floor) at the tiny size.
 */
export function dockViewStep(
  look: DockLook,
  choice: DockViewChoice,
  unfold: Exclude<DockMode, 'pet'> = 'row',
): DockViewStep {
  if (choice !== 'tiny') return choice === look.mode ? {} : { mode: choice };
  if (look.mode === 'pet') return look.tiny ? { mode: unfold } : { tiny: true, mode: unfold };
  return { tiny: !look.tiny };
}

/** Whether a menu entry shows as the current one. Tiny counts only on the row or the floor. */
export function dockViewChecked(look: DockLook, choice: DockViewChoice): boolean {
  if (choice === 'tiny') return look.mode !== 'pet' && look.tiny;
  return look.mode === choice;
}
