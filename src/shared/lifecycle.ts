import type { OfficeEvent, Preferences, Session } from './types';

/** A new request or native turn start is a boundary; tools/polling/final output are not. */
export function latestTaskStart(events: OfficeEvent[], previous?: number) {
  const at = events.reduce(
    (at, e) => (e.kind === 'user' || e.lifecycle === 'started' ? Math.max(at, e.at) : at),
    previous ?? 0,
  );
  return at > 0 ? at : undefined;
}
export const taskStart = (s: Session) => latestTaskStart(s.events, s.taskStartedAt);
export const durationLabel = (hours: number) =>
  hours % 24 === 0 ? `${hours / 24}일` : `${hours}시간`;
export const officeSchedule = (
  p: Pick<Preferences, 'standbyHours' | 'archiveDays' | 'autoArchive' | 'readyMinutes'>,
) =>
  `${p.readyMinutes ?? 30}분 대기 · ${durationLabel(p.standbyHours ?? 4)} 후 퇴근 · ${p.autoArchive === false ? '자동 보관 안 함' : `${p.archiveDays ?? 7}일 후 보관`}`;
/** Standing by ends before going home, and going home comes before archiving. */
export const validOfficeSchedule = (
  p: Pick<Preferences, 'standbyHours' | 'archiveDays' | 'autoArchive' | 'readyMinutes'>,
) =>
  (p.readyMinutes ?? 30) < (p.standbyHours ?? 4) * 60 &&
  (p.autoArchive === false || (p.archiveDays ?? 7) * 24 > (p.standbyHours ?? 4));
