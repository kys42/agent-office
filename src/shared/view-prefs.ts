import type {
  DockPillVisibility,
  PetNameMode,
  PetTallyGroup,
  Preferences,
  ViewSettings,
} from './types';
import { HELPER_STACK_AT } from './office-layout';
import { HELPER_UNFINISHED_MS } from './residents';

/**
 * The view preferences of #228 with their defaults filled in: every window (big office, dock,
 * card, settings) reads them the same way, and a missing value is the behaviour from before.
 */
export interface ViewPrefs {
  tinyNames: boolean;
  /** The work card lists the teammate's outputs (#350). */
  cardOutputs: boolean;
  /** The card's chat shows outputs as chips under the message that made them (#358). */
  chatOutputs: boolean;
  tinyFinalDot: boolean;
  dockPill: DockPillVisibility;
  dockPillResetAt: number | null;
  panelWidthsResetAt: number | null;
  helperDesks: boolean;
  helperStackAt: number;
  /** Milliseconds a quiet helper still mid-task keeps its desk. */
  helperUnfinishedMs: number;
  /** What each screen shows (#324), every choice filled in. */
  views: ResolvedViews;
}

/** A desk scene's effects with their defaults filled in. */
export interface DeskView {
  branch: boolean;
  papers: boolean;
  beacon: boolean;
  focus: boolean;
}
export interface ResolvedViews {
  pet: {
    tally: boolean;
    tallyGroups: PetTallyGroup[];
    name: PetNameMode;
    turnEffect: boolean;
    petting: boolean;
  };
  /** `tally`: the pill's numbers (the pet's, counting `pet.tallyGroups`); off, the old summary. */
  dock: DeskView & { hideRead: boolean; tally: boolean };
  tiny: { effects: boolean; tally: boolean };
  office: DeskView;
}

/** Every group the pet's pill can count, in triage order (resting colleagues never are). */
export const PET_TALLY_GROUPS: readonly PetTallyGroup[] = [
  'attention',
  'results',
  'working',
  'standby',
];
export const PET_NAME_CHOICES: readonly PetNameMode[] = ['speaking', 'always', 'never'];

const on = (v: unknown) => v !== false;

/** The pet's counted groups: known ones only, once each, in triage order. Missing: all of them. */
export const tallyGroups = (v: unknown): PetTallyGroup[] =>
  Array.isArray(v) ? PET_TALLY_GROUPS.filter((g) => v.includes(g)) : [...PET_TALLY_GROUPS];

/** A desk scene with nothing chosen: everything shows, as before #324. */
export const DEFAULT_DESK_VIEW: DeskView = {
  branch: true,
  papers: true,
  beacon: true,
  focus: true,
};

const deskView = (v?: ViewSettings['office']): DeskView => ({
  branch: on(v?.branch),
  papers: on(v?.papers),
  beacon: on(v?.beacon),
  focus: on(v?.focus),
});

/** #324: every screen's choices, a missing one being the look from before it existed. */
export function resolveViews(v?: ViewSettings | null): ResolvedViews {
  return {
    pet: {
      tally: on(v?.pet?.tally),
      tallyGroups: tallyGroups(v?.pet?.tallyGroups),
      name: PET_NAME_CHOICES.includes(v?.pet?.name as PetNameMode) ? v!.pet!.name! : 'speaking',
      turnEffect: on(v?.pet?.turnEffect),
      petting: on(v?.pet?.petting),
    },
    dock: { ...deskView(v?.dock), hideRead: on(v?.dock?.hideRead), tally: on(v?.dock?.tally) },
    tiny: { effects: on(v?.tiny?.effects), tally: on(v?.tiny?.tally) },
    office: deskView(v?.office),
  };
}

/**
 * Saving one screen's choice keeps the others: views merge mode by mode, and within a mode key by
 * key (a patch carries only what changed).
 */
export function mergeViews(base: ViewSettings | undefined, patch: ViewSettings): ViewSettings {
  const next: ViewSettings = { ...base };
  for (const mode of Object.keys(patch) as (keyof ViewSettings)[])
    if (patch[mode]) next[mode] = { ...base?.[mode], ...patch[mode] } as never;
  return next;
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
    cardOutputs: p?.cardOutputs !== false,
    chatOutputs: p?.chatOutputs !== false,
    tinyFinalDot: p?.tinyFinalDot !== false,
    dockPill: DOCK_PILL_CHOICES.includes(p?.dockPill as DockPillVisibility)
      ? p!.dockPill!
      : 'subdued',
    dockPillResetAt: stamp(p?.dockPillResetAt),
    panelWidthsResetAt: stamp(p?.panelWidthsResetAt),
    helperDesks: p?.helperDesks !== false,
    helperStackAt: helperStackAt(p),
    helperUnfinishedMs: helperUnfinishedMs(p),
    views: resolveViews(p?.views),
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
