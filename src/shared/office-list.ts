import type { Session } from './types';
import { projectKey } from './office';
import { zoneLabel } from './zones';

export type OfficeView = 'graphic' | 'list';
export type OfficeListOrder = 'recent' | 'project';

/** A presentation preference, local to this viewer; never changes seats or session identity. */
export function officeListPrefs(value: unknown): { view: OfficeView; order: OfficeListOrder } {
  const p = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    view: p.view === 'list' ? 'list' : 'graphic',
    order: p.order === 'project' ? 'project' : 'recent',
  };
}

/** Recent means the same observed activity time as the office lifecycle, even for pinned rows. */
export function officeListGroups(sessions: readonly Session[], order: OfficeListOrder) {
  const recent = [...sessions].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
  );
  if (order === 'recent') return [{ key: 'recent', label: '', sessions: recent }];
  const groups = new Map<string, { key: string; label: string; sessions: Session[] }>();
  for (const s of recent) {
    const key = projectKey(s);
    const group = groups.get(key) ?? { key, label: zoneLabel(s), sessions: [] };
    group.sessions.push(s);
    groups.set(key, group);
  }
  // The most recently active project leads, then the most recent colleague in that project.
  return [...groups.values()];
}
