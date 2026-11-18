import type { OfficeZone, Session } from './types';
import { projectKey, sessionName } from './office';
import { zoneLabel } from './zones';
import { conversationChoices, type ConversationChoice } from './launch-sheet';
import { awayColleagues } from './summon-existing';

/** A project the dock's ＋ can start a new session in (its launch sheet's entry). */
export interface SummonProject {
  key: string;
  name: string;
  /** Its colleagues in the office (the sheet's own conversations come first). */
  office: Session[];
  /** Everyone of it, away colleagues included (counted on the row). */
  count: number;
  /** One session per project folder: where a new session can start. */
  folders: Session[];
  /** The newest activity, for the order after the office's projects. */
  at: number;
}

/**
 * The projects the ＋ offers for a new session: the office's first (in seat order), then those
 * whose colleagues all rest in the lounge or the archive, newest first. A project is offered
 * only with a local folder to start in (a remote office's project keeps its own summon).
 */
export function summonProjects(zones: Record<OfficeZone, Session[]>): SummonProject[] {
  const byKey = new Map<string, SummonProject>();
  for (const zone of ['office', 'waiting', 'archive'] as const)
    for (const s of zones[zone]) {
      if (s.remote || s.attachedTo) continue;
      const key = projectKey(s);
      let p = byKey.get(key);
      if (!p) {
        p = { key, name: zoneLabel(s), office: [], count: 0, folders: [], at: 0 };
        byKey.set(key, p);
      }
      if (zone === 'office') p.office.push(s);
      p.count++;
      p.at = Math.max(p.at, s.updatedAt);
      if (s.cwd && !p.folders.some((f) => f.cwd === s.cwd)) p.folders.push(s);
    }
  const list = [...byKey.values()].filter((p) => p.folders.length > 0);
  const inOffice = list.filter((p) => p.office.length > 0);
  const away = list.filter((p) => !p.office.length).sort((a, b) => b.at - a.at);
  return [...inOffice, ...away];
}

/** The launch sheet's choices for a project picked from the ＋ (as its own zone "+" does). */
export function summonChoices(
  zones: Record<OfficeZone, Session[]>,
  project: SummonProject,
): { list: ConversationChoice[]; hidden: number } {
  if (project.office.length) return conversationChoices(zones, project.office);
  // Nobody of it in the office: its away colleagues are its conversations.
  const away = awayColleagues(zones, project.folders);
  return { list: away.list, hidden: away.total - away.list.length };
}

export type AwayRoom = Extract<OfficeZone, 'waiting' | 'archive'>;

/**
 * Who the ＋'s 데려오기 lists from a room: its colleagues (not helpers on someone's desk), newest
 * first, matching `query` by name, project or area. Privacy matches nothing by name: the list
 * hides names, so a search must not reveal them.
 */
export function awayList(sessions: Session[], query = '', privacy = false): Session[] {
  const q = privacy ? '' : query.trim().toLowerCase();
  return sessions
    .filter((s) => !s.attachedTo)
    .filter(
      (s) =>
        !q ||
        [sessionName(s), s.project, s.area?.name ?? '', zoneLabel(s)]
          .join(' ')
          .toLowerCase()
          .includes(q),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
