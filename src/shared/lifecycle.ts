import type { OfficeEvent, Preferences, Session } from './types';
import { m } from './i18n';

/** A new request or native turn start is a boundary; tools/polling/final output are not. */
export function latestTaskStart(events: OfficeEvent[], previous?: number) {
  const at = events.reduce(
    (at, e) => (e.kind === 'user' || e.lifecycle === 'started' ? Math.max(at, e.at) : at),
    previous ?? 0,
  );
  return at > 0 ? at : undefined;
}
export const taskStart = (s: Session) => latestTaskStart(s.events, s.taskStartedAt);
export const durationLabel = (hours: number) => {
  const t = m().shared.lifecycle;
  return hours % 24 === 0 ? t.days(hours / 24) : t.hours(hours);
};
export const officeSchedule = (
  p: Pick<Preferences, 'standbyHours' | 'archiveDays' | 'autoArchive' | 'readyMinutes'>,
) => {
  const t = m().shared.lifecycle;
  return `${t.readyFor(p.readyMinutes ?? 30)} · ${t.offDutyAfter(durationLabel(p.standbyHours ?? 4))} · ${p.autoArchive === false ? t.noAutoArchive : t.archiveAfter(p.archiveDays ?? 7)}`;
};
/** Standing by ends before going home, and going home comes before archiving. */
export const validOfficeSchedule = (
  p: Pick<Preferences, 'standbyHours' | 'archiveDays' | 'autoArchive' | 'readyMinutes'>,
) =>
  (p.readyMinutes ?? 30) < (p.standbyHours ?? 4) * 60 &&
  (p.autoArchive === false || (p.archiveDays ?? 7) * 24 > (p.standbyHours ?? 4));
