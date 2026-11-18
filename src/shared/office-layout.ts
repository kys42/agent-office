import type { Session } from './types';
import { benchKey, projectKey } from './office';
import { isCustomZone, zoneLabel } from './zones';

export const STATION_WIDTH = 164;
export const STATION_HEIGHT = 238;
/** A helper desk's width beside the desk it belongs to (big office and row alike). */
export const HELPER_WIDTH = 73;
/** Helper desks stand with their table at the station's desk height (station space; the big
 * office and the row's office mode — the floor stands them on the floor instead). */
export const HELPER_TOP = 102;
/**
 * From this many helpers on one colleague, they share one stacked desk ("×N"). The default of
 * the `helperStackAt` preference; the layouts take the person's choice as `stackAt`.
 */
export const HELPER_STACK_AT = 4;
const PADDING = 14;
const LABEL = 38;
const GAP = 22;
const WALL = 68;

export interface StationPlacement {
  id: string;
  x: number;
  y: number;
  /** Helper desks; a `stack` slot holds every helper id behind one stacked desk. */
  children: { id: string; x: number; y: number; stack?: string[] }[];
}
export interface ProjectArea {
  key: string;
  name: string;
  /** Source projects behind a custom area, for its floor-mark tooltip. */
  custom?: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  stations: StationPlacement[];
  /** `shared`: the long desk of one branch, even where a colleague's helpers break it. */
  benches: {
    key: string;
    members: string[];
    x: number;
    y: number;
    width: number;
    shared: boolean;
  }[];
}
export interface OfficeLayout {
  width: number;
  height: number;
  projects: ProjectArea[];
  count: number;
}

const stableOrder = (a: Session, b: Session) =>
  (a.officeSeat ?? Number.MAX_SAFE_INTEGER) - (b.officeSeat ?? Number.MAX_SAFE_INTEGER) ||
  a.id.localeCompare(b.id);

const colors = ['#7fae86', '#d39a62', '#a48fd0', '#6fa9bd', '#d08497', '#b8ad5d'];
/** Stable floor tint per project zone, shared by every presentation. */
export function projectColor(key: string) {
  let n = 0;
  for (const c of key) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return colors[n % colors.length];
}

/**
 * Who sits where, before any coordinates: project zones in seat order, the shared benches
 * inside each zone (same worktree + branch/commit), and the helper desks of each station.
 * The big office (2D grid) and the desk row (1D strip) project this same topology.
 */
export interface OfficeTopology {
  primary: Session[];
  projects: {
    key: string;
    name: string;
    /** Source projects behind a custom area (user-defined zone), for its sign's tooltip. */
    custom?: string[];
    benches: { key: string; members: Session[] }[];
  }[];
  children: Map<string, Session[]>;
}
export function officeTopology(sessions: Session[]): OfficeTopology {
  const primary = sessions.filter((s) => !s.attachedTo).sort(stableOrder);
  const groups = new Map<string, Session[]>();
  for (const s of primary) groups.set(projectKey(s), [...(groups.get(projectKey(s)) ?? []), s]);
  const children = new Map(
    primary.map((s) => [s.id, sessions.filter((c) => c.attachedTo === s.id).sort(stableOrder)]),
  );
  const projects = [...groups].map(([key, members]) => {
    const benches = new Map<string, Session[]>();
    for (const s of members) benches.set(benchKey(s), [...(benches.get(benchKey(s)) ?? []), s]);
    return {
      key,
      name: zoneLabel(members[0]),
      custom: isCustomZone(key) ? [...new Set(members.map((s) => s.project))] : undefined,
      benches: [...benches].map(([key, members]) => ({ key, members })),
    };
  });
  return { primary, projects, children };
}

/**
 * A colleague's helper desks: one each, or — from `stackAt` helpers (HELPER_STACK_AT unless the
 * person chose otherwise) — one stacked desk that keeps every helper reachable through its list.
 */
export function helperSlots(
  helpers: Session[],
  stackAt: number = HELPER_STACK_AT,
): { id: string; stack?: string[] }[] {
  if (helpers.length < Math.max(2, stackAt)) return helpers.map((c) => ({ id: c.id }));
  return [{ id: helpers[0].id, stack: helpers.map((c) => c.id) }];
}

/** Only topology/ordering changes furniture. Activity, selection and recent-use sorting do not. */
export function layoutSignature(sessions: Session[]) {
  return sessions
    .map((s) =>
      [s.id, s.project, zoneLabel(s), projectKey(s), benchKey(s), s.attachedTo, s.officeSeat].join(
        '|',
      ),
    )
    .sort()
    .join('\n');
}

export function layoutOffice(
  sessions: Session[],
  aspect = 1.7,
  stackAt: number = HELPER_STACK_AT,
): OfficeLayout {
  const { primary, projects: groups, children } = officeTopology(sessions);
  if (!primary.length) return { width: 800, height: 440, projects: [], count: 0 };

  function candidate(columns: number): OfficeLayout {
    const maxWidth =
      columns * STATION_WIDTH + (columns - 1) * GAP + PADDING * 2 + groups.length * PADDING * 2;
    const projects: ProjectArea[] = [];
    let x = PADDING,
      y = WALL,
      rowHeight = 0;
    for (const { key, name, custom, benches } of groups) {
      const ordered = benches.flatMap((b) => b.members);
      const together = new Map(benches.map((b) => [b.key, b.members.length > 1]));
      const cols = Math.min(columns, ordered.length);
      const area: ProjectArea = {
        key,
        name,
        custom,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        stations: [],
        benches: [],
      };
      let stationY = LABEL;
      let widest = 0;
      for (let start = 0; start < ordered.length; start += cols) {
        const row = ordered.slice(start, start + cols);
        // A bench's members sit side by side at one long desk; a colleague's helper desks join
        // right beside its own desk, at desk height (the long desk breaks there to make room).
        let cursor = PADDING;
        let bench: ProjectArea['benches'][number] | undefined;
        for (const m of row) {
          const key = benchKey(m);
          if (bench?.key === key) {
            bench.width += STATION_WIDTH;
            bench.members.push(m.id);
          } else {
            bench = {
              key,
              members: [m.id],
              x: cursor + 5,
              y: stationY + 134,
              width: STATION_WIDTH - 10,
              shared: together.get(key) ?? false,
            };
            area.benches.push(bench);
          }
          const station: StationPlacement = { id: m.id, x: cursor, y: stationY, children: [] };
          area.stations.push(station);
          cursor += STATION_WIDTH;
          const slots = helperSlots(children.get(m.id) ?? [], stackAt);
          for (const slot of slots) {
            station.children.push({ ...slot, x: cursor, y: stationY + HELPER_TOP });
            cursor += HELPER_WIDTH;
          }
          if (slots.length) bench = undefined;
        }
        widest = Math.max(widest, cursor);
        stationY += STATION_HEIGHT;
      }
      area.width = widest + PADDING;
      area.height = stationY + PADDING;
      if (x > PADDING && x + area.width > maxWidth + PADDING) {
        x = PADDING;
        y += rowHeight + GAP;
        rowHeight = 0;
      }
      area.x = x;
      area.y = y;
      projects.push(area);
      x += area.width + GAP;
      rowHeight = Math.max(rowHeight, area.height);
    }
    return {
      projects,
      count: sessions.length,
      width: Math.max(640, ...projects.map((p) => p.x + p.width + PADDING)),
      height: Math.max(420, ...projects.map((p) => p.y + p.height + 26)),
    };
  }
  const choices = Array.from({ length: Math.min(12, primary.length) }, (_, i) => candidate(i + 1));
  // Maximize furniture size in the target viewport, not the number of empty slots.
  const fit = (layout: OfficeLayout) => Math.min(aspect / layout.width, 1 / layout.height);
  return choices.sort((a, b) => fit(b) - fit(a) || a.width * a.height - b.width * b.height)[0];
}

/** Station-space geometry of the desk row (the same 164×238 station as the big office). */
export const ROW_TOP = 104;
/** Floor version: same bubble headroom; desks stand on the scene's bottom edge. */
export const FLOOR_TOP = 104;
/** Where the desk legs meet the floor, in station space (bench at 134, legs to 188). */
export const DESK_FOOT = 188;
/** Floor version leaves room between zones for a flag pole. */
export const FLOOR_ZONE_GAP = 56;
const ROW_PAD = 12;
const ROW_ZONE_GAP = 18;
export interface RowZone {
  key: string;
  name: string;
  custom?: string[];
  x: number;
  width: number;
  stations: { id: string; x: number }[];
  helpers: { id: string; parent: string; x: number; stack?: string[] }[];
  benches: { key: string; members: string[]; x: number; width: number; shared: boolean }[];
}
export interface RowLayout {
  width: number;
  zones: RowZone[];
  count: number;
}

/**
 * The office as one line: zones side by side, a bench's members joined at one long desk,
 * and helper desks right beside the desk they belong to (the long desk breaks there).
 */
export function layoutRow(
  sessions: Session[],
  {
    zoneGap = ROW_ZONE_GAP,
    stackAt = HELPER_STACK_AT,
  }: { zoneGap?: number; stackAt?: number } = {},
): RowLayout {
  const { projects, children } = officeTopology(sessions);
  const zones: RowZone[] = [];
  let x = 0;
  for (const { key, name, custom, benches } of projects) {
    const zone: RowZone = {
      key,
      name,
      custom,
      x,
      width: 0,
      stations: [],
      helpers: [],
      benches: [],
    };
    let cursor = ROW_PAD;
    for (const bench of benches) {
      // As in the big office: a colleague's helpers right beside its own desk, the long desk
      // breaking there and going on after them.
      let piece: RowZone['benches'][number] | undefined;
      for (const s of bench.members) {
        if (piece) {
          piece.width += STATION_WIDTH;
          piece.members.push(s.id);
        } else {
          piece = {
            key: bench.key,
            members: [s.id],
            x: cursor + 5,
            width: STATION_WIDTH - 10,
            shared: bench.members.length > 1,
          };
          zone.benches.push(piece);
        }
        zone.stations.push({ id: s.id, x: cursor });
        cursor += STATION_WIDTH;
        const slots = helperSlots(children.get(s.id) ?? [], stackAt);
        for (const c of slots) {
          zone.helpers.push({ ...c, parent: s.id, x: cursor });
          cursor += HELPER_WIDTH;
        }
        if (slots.length) piece = undefined;
      }
    }
    zone.width = cursor + ROW_PAD;
    zones.push(zone);
    x += zone.width + zoneGap;
  }
  return { width: Math.max(0, x - zoneGap), zones, count: sessions.length };
}
