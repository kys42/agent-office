import type { Session } from './types';
import { benchKey, projectKey } from './office';

export const STATION_WIDTH = 164;
export const STATION_HEIGHT = 238;
export const HELPER_ROW_HEIGHT = 72;
const PADDING = 14;
const LABEL = 38;
const GAP = 22;
const WALL = 68;

export interface StationPlacement {
  id: string;
  x: number;
  y: number;
  children: { id: string; x: number; y: number }[];
}
export interface ProjectArea {
  key: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  stations: StationPlacement[];
  benches: { key: string; members: string[]; x: number; y: number; width: number }[];
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
  projects: { key: string; name: string; benches: { key: string; members: Session[] }[] }[];
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
      name: members[0].project,
      benches: [...benches].map(([key, members]) => ({ key, members })),
    };
  });
  return { primary, projects, children };
}

/** Only topology/ordering changes furniture. Activity, selection and recent-use sorting do not. */
export function layoutSignature(sessions: Session[]) {
  return sessions
    .map((s) => [s.id, s.project, projectKey(s), benchKey(s), s.attachedTo, s.officeSeat].join('|'))
    .sort()
    .join('\n');
}

export function layoutOffice(sessions: Session[], aspect = 1.7): OfficeLayout {
  const { primary, projects: groups, children } = officeTopology(sessions);
  if (!primary.length) return { width: 800, height: 440, projects: [], count: 0 };

  function candidate(columns: number): OfficeLayout {
    const maxWidth =
      columns * STATION_WIDTH + (columns - 1) * GAP + PADDING * 2 + groups.length * PADDING * 2;
    const projects: ProjectArea[] = [];
    let x = PADDING,
      y = WALL,
      rowHeight = 0;
    for (const { key, name, benches } of groups) {
      const ordered = benches.flatMap((b) => b.members);
      const cols = Math.min(columns, ordered.length);
      const area: ProjectArea = {
        key,
        name,
        x: 0,
        y: 0,
        width: cols * STATION_WIDTH + PADDING * 2,
        height: 0,
        stations: [],
        benches: [],
      };
      let stationY = LABEL;
      for (let start = 0; start < ordered.length; start += cols) {
        const row = ordered.slice(start, start + cols);
        row.forEach((s, col) => {
          const stationX = PADDING + col * STATION_WIDTH;
          area.stations.push({
            id: s.id,
            x: stationX,
            y: stationY,
            children: (children.get(s.id) ?? []).map((c, i) => ({
              id: c.id,
              x: stationX + 10 + (i % 2) * 73,
              y: stationY + STATION_HEIGHT + Math.floor(i / 2) * HELPER_ROW_HEIGHT - 4,
            })),
          });
          const previous = area.benches.at(-1);
          if (col > 0 && previous?.key === benchKey(s)) {
            previous.width += STATION_WIDTH;
            previous.members.push(s.id);
          } else
            area.benches.push({
              key: benchKey(s),
              members: [s.id],
              x: stationX + 5,
              y: stationY + 134,
              width: STATION_WIDTH - 10,
            });
        });
        const helpers = Math.max(
          0,
          ...row.map((s) => Math.ceil((children.get(s.id)?.length ?? 0) / 2)),
        );
        stationY += STATION_HEIGHT + helpers * HELPER_ROW_HEIGHT;
      }
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
const ROW_PAD = 12;
const ROW_ZONE_GAP = 18;
const HELPER_WIDTH = 73;
export interface RowZone {
  key: string;
  name: string;
  x: number;
  width: number;
  stations: { id: string; x: number }[];
  helpers: { id: string; parent: string; x: number }[];
  benches: { key: string; members: string[]; x: number; width: number }[];
}
export interface RowLayout {
  width: number;
  zones: RowZone[];
  count: number;
}

/**
 * The office as one line: zones side by side, a bench's members joined at one long desk,
 * and helper desks right after the bench they belong to (benches stay unbroken).
 */
export function layoutRow(sessions: Session[]): RowLayout {
  const { projects, children } = officeTopology(sessions);
  const zones: RowZone[] = [];
  let x = 0;
  for (const { key, name, benches } of projects) {
    const zone: RowZone = { key, name, x, width: 0, stations: [], helpers: [], benches: [] };
    let cursor = ROW_PAD;
    for (const bench of benches) {
      zone.benches.push({
        key: bench.key,
        members: bench.members.map((s) => s.id),
        x: cursor + 5,
        width: bench.members.length * STATION_WIDTH - 10,
      });
      for (const s of bench.members) {
        zone.stations.push({ id: s.id, x: cursor });
        cursor += STATION_WIDTH;
      }
      for (const s of bench.members)
        for (const c of children.get(s.id) ?? []) {
          zone.helpers.push({ id: c.id, parent: s.id, x: cursor });
          cursor += HELPER_WIDTH;
        }
    }
    zone.width = cursor + ROW_PAD;
    zones.push(zone);
    x += zone.width + ROW_ZONE_GAP;
  }
  return { width: Math.max(0, x - ROW_ZONE_GAP), zones, count: sessions.length };
}
