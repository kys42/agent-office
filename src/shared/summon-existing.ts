import type { OfficeZone, Session } from './types';
import { projectKey } from './office';
import { isBackground, isHelper } from './residents';

/**
 * Project "+" → "Bring back a colleague": who of this project is resting in the lounge or the
 * archive, and whether their saved conversation can be resumed in a terminal. Pure: the summon
 * sheet only draws it; tmux/Orca checks (installed tools, the folder still existing) stay with
 * the desktop's own resume status calls.
 */
export type AwayZone = Exclude<OfficeZone, 'office'>;
/** Why a conversation cannot be resumed from here (the row is listed, disabled). */
export type ResumeBlock = 'remote' | 'provider' | 'conversation' | 'folder';
export interface AwayColleague {
  session: Session;
  zone: AwayZone;
  block?: ResumeBlock;
}
/** At most this many rows; the rest is counted ("and N more"). */
export const AWAY_LIMIT = 30;
// The same id shape the desktop resume paths accept (desktop/tmux-resume.ts, orca-launch.ts).
const NATIVE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;

/** Only local Claude/Codex conversations with an id and an absolute folder can be resumed. */
export function resumeBlock(s: Session): ResumeBlock | undefined {
  if (s.remote) return 'remote';
  if (s.provider !== 'claude' && s.provider !== 'codex') return 'provider';
  if (!NATIVE_ID.test(s.nativeId ?? '')) return 'conversation';
  if (!s.cwd || !s.cwd.startsWith('/')) return 'folder';
  return undefined;
}

/**
 * Lounge (`waiting`) and archive residents of the projects the given office sessions belong
 * to, newest activity first. Helpers, attached desks and background runs (scheduled/internal)
 * are not colleagues one brings back on their own.
 */
export function awayColleagues(
  zones: Pick<Record<OfficeZone, Session[]>, AwayZone>,
  projectSessions: Session[],
  limit = AWAY_LIMIT,
): { list: AwayColleague[]; total: number } {
  const keys = new Set(projectSessions.map(projectKey));
  const seen = new Set<string>();
  const all: AwayColleague[] = [];
  for (const zone of ['waiting', 'archive'] as const)
    for (const s of zones[zone] ?? []) {
      if (seen.has(s.id) || s.attachedTo || isHelper(s) || isBackground(s)) continue;
      if (!keys.has(projectKey(s))) continue;
      seen.add(s.id);
      all.push({ session: s, zone, block: resumeBlock(s) });
    }
  all.sort(
    (a, b) => b.session.updatedAt - a.session.updatedAt || a.session.id.localeCompare(b.session.id),
  );
  return { list: all.slice(0, Math.max(0, limit)), total: all.length };
}
