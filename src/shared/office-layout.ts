import type { Session } from './types';
import { benchKey, projectKey } from './office';
import { isCustomZone } from './zones';

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
  /** Source projects behind a custom area, for its floor-mark tooltip. */
  custom?: string[];
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

/** Only topology/ordering changes furniture. Activity, selection and recent-use sorting do not. */
export function layoutSignature(sessions: Session[]) {
  return sessions
    .map((s) => [s.id, s.project, projectKey(s), benchKey(s), s.attachedTo, s.officeSeat].join('|'))
    .sort()
    .join('\n');
}

export function layoutOffice(sessions: Session[], aspect = 1.7): OfficeLayout {
  const primary = sessions.filter((s) => !s.attachedTo).sort(stableOrder);
  const groups = new Map<string, Session[]>();
  for (const s of primary) groups.set(projectKey(s), [...(groups.get(projectKey(s)) ?? []), s]);
  if (!primary.length) return { width: 800, height: 440, projects: [], count: 0 };
  const children = new Map(
    primary.map((s) => [s.id, sessions.filter((c) => c.attachedTo === s.id).sort(stableOrder)]),
  );

  function candidate(columns: number): OfficeLayout {
    const maxWidth =
      columns * STATION_WIDTH + (columns - 1) * GAP + PADDING * 2 + groups.size * PADDING * 2;
    const projects: ProjectArea[] = [];
    let x = PADDING,
      y = WALL,
      rowHeight = 0;
    for (const [key, members] of groups) {
      const benches = new Map<string, Session[]>();
      for (const s of members) benches.set(benchKey(s), [...(benches.get(benchKey(s)) ?? []), s]);
      const ordered = [...benches.values()].flat();
      const cols = Math.min(columns, ordered.length);
      const area: ProjectArea = {
        key,
        name: members[0].area?.name ?? members[0].project,
        custom: isCustomZone(key) ? [...new Set(members.map((s) => s.project))] : undefined,
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
