import { m } from './i18n';
import { OFFICE_PALETTES, type OfficePalette } from './office-assets';
import { projectKey } from './office';
import { petKey } from './pets';
import type { Session } from './types';

/** Desk looks are presentation only: placement, status and the glowing glass stay the scene's. */
export const DESK_TOPS = Object.fromEntries(
  (Object.keys(OFFICE_PALETTES) as OfficePalette[]).map((id) => [
    id,
    {
      get name() {
        return m().desks.tops[id];
      },
      swatch: OFFICE_PALETTES[id].top,
      edge: OFFICE_PALETTES[id].edge,
    },
  ]),
) as Record<OfficePalette, { readonly name: string; swatch: string; edge: string }>;
export type DeskTop = OfficePalette;
/** A rect in desk-station coordinates (164×238), border included. */
export type DeskRect = readonly [x: number, y: number, width: number, height: number];
/**
 * Each monitor's glass, where `.desk-screen` glows. Matches `SCREENS` in
 * scripts/generate-desks.py; `basic` is the screen the desk always had.
 */
export const DESK_MONITORS = {
  basic: {
    get name() {
      return m().desks.monitors.basic;
    },
    screens: [[34, 122, 32, 20]] as DeskRect[],
  },
  wide: {
    get name() {
      return m().desks.monitors.wide;
    },
    screens: [[22, 120, 50, 22]] as DeskRect[],
  },
  crt: {
    get name() {
      return m().desks.monitors.crt;
    },
    screens: [[31, 117, 32, 22]] as DeskRect[],
  },
  laptop: {
    get name() {
      return m().desks.monitors.laptop;
    },
    screens: [[33, 121, 32, 21]] as DeskRect[],
  },
  dual: {
    get name() {
      return m().desks.monitors.dual;
    },
    screens: [
      [9, 124, 28, 19],
      [40, 122, 30, 20],
    ] as DeskRect[],
  },
} as const;
export type DeskMonitor = keyof typeof DESK_MONITORS;
export const DESK_CHAIRS = {
  get green() {
    return m().desks.chairs.green;
  },
  get navy() {
    return m().desks.chairs.navy;
  },
  get pink() {
    return m().desks.chairs.pink;
  },
  get gaming() {
    return m().desks.chairs.gaming;
  },
  get stool() {
    return m().desks.chairs.stool;
  },
} as const;
export type DeskChair = keyof typeof DESK_CHAIRS;
export const DESK_ITEMS = {
  get none() {
    return m().desks.items.none;
  },
  get cup() {
    return m().desks.items.cup;
  },
  get plant() {
    return m().desks.items.plant;
  },
  get lamp() {
    return m().desks.items.lamp;
  },
  get books() {
    return m().desks.items.books;
  },
  get cat() {
    return m().desks.items.cat;
  },
  get cactus() {
    return m().desks.items.cactus;
  },
  get duck() {
    return m().desks.items.duck;
  },
  get frame() {
    return m().desks.items.frame;
  },
} as const;
export type DeskItem = keyof typeof DESK_ITEMS;
/** Layer boxes in station coordinates (the generator draws into the same boxes). */
export const DESK_BOXES = {
  chair: [52, 92, 60, 62],
  monitor: [4, 100, 84, 52],
  itemLeft: [2, 126, 20, 26],
  itemRight: [122, 125, 20, 26],
} as const satisfies Record<string, DeskRect>;

export interface DeskLook {
  top: DeskTop;
  monitor: DeskMonitor;
  chair: DeskChair;
  itemLeft: DeskItem;
  itemRight: DeskItem;
}
/**
 * Layers over the default: the whole office, then a project zone, then one colleague. Each layer
 * keeps only the parts it changes. null entries are deletion commands on write, and are omitted
 * from stored preferences.
 */
export interface DeskCustomization {
  version: 1;
  office?: Partial<DeskLook> | null;
  projects: Record<string, Partial<DeskLook> | null>;
  colleagues: Record<string, Partial<DeskLook> | null>;
}
/** Today's desk: oak, the basic screen, the green fabric chair and a cup. */
export const DEFAULT_DESK_LOOK: DeskLook = {
  top: 'oak',
  monitor: 'basic',
  chair: 'green',
  itemLeft: 'none',
  itemRight: 'cup',
};
const PARTS = {
  top: OFFICE_PALETTES,
  monitor: DESK_MONITORS,
  chair: DESK_CHAIRS,
  itemLeft: DESK_ITEMS,
  itemRight: DESK_ITEMS,
} as const;
export const DESK_PARTS = Object.keys(PARTS) as (keyof DeskLook)[];
const owns = (object: object, key: unknown): key is string =>
  typeof key === 'string' && Object.hasOwn(object, key);
/** The valid parts of a layer; undefined when nothing valid is left. */
function cleanLayer(value: unknown): Partial<DeskLook> | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Record<string, unknown>;
  const layer = Object.fromEntries(
    DESK_PARTS.filter((part) => owns(PARTS[part], input[part])).map((part) => [part, input[part]]),
  ) as Partial<DeskLook>;
  return Object.keys(layer).length ? layer : undefined;
}
function cleanLayers(value: unknown, cap: number, shared = true) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key.length > 0 && key.length <= 500)
      .map(
        ([key, layer]) => [key, cleanLayer(shared ? layer : { ...layer, top: undefined })] as const,
      )
      .filter((entry): entry is [string, Partial<DeskLook>] => !!entry[1])
      // Oldest first: at the cap the oldest looks go, never the one just chosen.
      .slice(-cap),
  );
}
export const DESK_PROJECT_CAP = 500;
export const DESK_COLLEAGUE_CAP = 3000;
export function normalizeDeskCustomization(value: unknown): DeskCustomization {
  if (!value || typeof value !== 'object' || (value as DeskCustomization).version !== 1)
    return { version: 1, projects: {}, colleagues: {} };
  const input = value as DeskCustomization;
  const office = cleanLayer(input.office);
  return {
    version: 1,
    ...(office ? { office } : {}),
    projects: cleanLayers(input.projects, DESK_PROJECT_CAP),
    // A colleague never has its own top: the bench is the zone's.
    colleagues: cleanLayers(input.colleagues, DESK_COLLEAGUE_CAP, false),
  };
}
/** Patched keys move to the newest end, so the cap drops the oldest untouched looks. */
function mergeLayers(
  previous: Record<string, Partial<DeskLook> | null>,
  patch: Record<string, Partial<DeskLook> | null> | undefined,
) {
  const patched = Object.entries(patch ?? {});
  const changed = new Set(patched.map(([key]) => key));
  return Object.fromEntries([
    ...Object.entries(previous).filter(([key]) => !changed.has(key)),
    ...patched,
  ]);
}
/** A layer in the patch replaces that layer whole; null (or an empty layer) removes it. */
export function mergeDeskCustomization(
  current: unknown,
  patch: DeskCustomization,
): DeskCustomization {
  const previous = normalizeDeskCustomization(current);
  return normalizeDeskCustomization({
    version: 1,
    office: patch.office === undefined ? previous.office : patch.office,
    projects: mergeLayers(previous.projects, patch.projects),
    colleagues: mergeLayers(previous.colleagues, patch.colleagues),
  });
}
/**
 * The desk a colleague sits at: default → office → project zone → colleague. A bench is shared
 * by everyone in a zone, so its top stops at the project layer.
 */
export function deskLook(
  customization?: DeskCustomization,
  zoneKey?: string,
  session?: Pick<Session, 'id' | 'actor'>,
): DeskLook {
  if (customization?.version !== 1) return DEFAULT_DESK_LOOK;
  const project = zoneKey ? cleanLayer(customization.projects?.[zoneKey]) : undefined;
  const { top: _, ...colleague } =
    (session && cleanLayer(customization.colleagues?.[petKey(session)])) || {};
  return {
    ...DEFAULT_DESK_LOOK,
    ...cleanLayer(customization.office),
    ...project,
    ...colleague,
  };
}
/** A session's desk in the office it sits in. */
export const sessionDesk = (customization: DeskCustomization | undefined, session: Session) =>
  deskLook(customization, projectKey(session), session);
/** The parts of `look` that differ from what the layers below already give. */
export function deskLayer(look: DeskLook, inherited: DeskLook): Partial<DeskLook> {
  return Object.fromEntries(
    DESK_PARTS.filter((part) => look[part] !== inherited[part]).map((part) => [part, look[part]]),
  );
}
export function deskAssets(look: DeskLook) {
  return {
    monitor: `./sprites/desk/monitor-${look.monitor}.png`,
    chair: `./sprites/desk/chair-${look.chair}.png`,
    itemLeft: look.itemLeft === 'none' ? undefined : `./sprites/desk/item-${look.itemLeft}.png`,
    itemRight: look.itemRight === 'none' ? undefined : `./sprites/desk/item-${look.itemRight}.png`,
  };
}
