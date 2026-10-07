import type { ExecutionPhase, Mood, RuntimeObservation, Session } from './types';

import { taskStart } from './lifecycle';
import { DEFAULT_READY_MINUTES, QUIET_MS, runtimeObservation } from './runtime';
import { liveLabels, liveList } from './labels';
export { runtimeObservation } from './runtime';

export const isWorking = (s: Session, now = Date.now()) =>
  !s.archived && ['work', 'think'].includes(s.status) && now - s.updatedAt <= QUIET_MS;

/**
 * Just finished and still at the desk ('대기 중'): the derived ready state, or — before the
 * service re-derives a raw status — a fresh answer or work gone quiet, within the default
 * standing-by window. Not working, not resting yet.
 */
export function isStandingBy(s: Session, now = Date.now()) {
  if (s.archived) return false;
  if (s.status === 'ready') return true;
  const age = now - s.updatedAt;
  const window = DEFAULT_READY_MINUTES * 60_000;
  return (
    (s.status === 'done' && age < window) ||
    (['work', 'think'].includes(s.status) && age > QUIET_MS && age < window)
  );
}

export function presentSession(s: Session, now = Date.now()) {
  const runtime =
    s.runtime ?? runtimeObservation(s.observedStatus ?? s.status, s.updatedAt, s.statusReason);
  const stale = now - s.updatedAt > QUIET_MS;
  // Standing by is upright at the desk — never the decorative stroll or doze.
  const standby = isStandingBy(s, now) && (s.status !== 'done' || stale);
  // Quiet work past the standing-by window (no fresh snapshot yet) rests like idle.
  const resting =
    (['idle', 'sleep', 'done', 'leave'].includes(s.status) ||
      (stale && ['work', 'think'].includes(s.status))) &&
    !standby &&
    !['needs-input', 'error'].includes(runtime.phase);
  const seed = [...s.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
  // Decorative time is independent of execution: no fake reading/reviewing/commits.
  const cycle = Math.floor((now + (seed % 45_000)) / 15_000) % 8;
  const posture =
    s.zone === 'archive'
      ? 'stored'
      : s.status === 'call'
        ? 'calling'
        : s.status === 'error'
          ? 'attention'
          : s.status === 'sleep'
            ? 'dozing'
            : standby
              ? 'standby'
              : resting && stale
                ? cycle === 3
                  ? 'strolling'
                  : cycle >= 6
                    ? 'dozing'
                    : 'resting'
                : s.status === 'work'
                  ? 'typing'
                  : s.status === 'think'
                    ? 'thinking'
                    : s.status === 'done'
                      ? 'result'
                      : 'resting';
  const mood: Mood =
    posture === 'dozing'
      ? 'sleep'
      : posture === 'standby'
        ? 'ready'
        : posture === 'strolling' || (resting && stale)
          ? 'idle'
          : s.status;
  return { runtime, stale, posture, mood, decorative: resting, seed, working: isWorking(s, now) };
}
export const POSTURE_LABELS: Record<string, string> = liveLabels(
  (t) => t.shared.presentation.posture,
);

export const PHASE_LABELS: Record<ExecutionPhase, string> = liveLabels(
  (t) => t.shared.presentation.phase,
);

/**
 * How long the current observed task has kept going (decorative intensity only): 1 focused
 * (5 min), 2 deep (15 min), 3 on fire (30 min). Anchored to a known current task, never
 * session age, and needs live work evidence.
 */
export type FocusLevel = 0 | 1 | 2 | 3;
/** Minutes into the task where each focus level starts (1, 2, 3). */
export const FOCUS_MINUTES = [5, 15, 30] as const;
/** Per focus level, in the active language (read at use time). */
export const FOCUS_LABELS = liveList((t) => t.shared.presentation.focus) as unknown as readonly [
  string,
  string,
  string,
  string,
];
export function focusLevel(s: Session, now = Date.now()): FocusLevel {
  const start = taskStart(s);
  if (!isWorking(s, now) || !start || start > now) return 0;
  const minutes = (now - start) / 60_000;
  return FOCUS_MINUTES.filter((m) => minutes >= m).length as FocusLevel;
}

/**
 * Who sits in front of a stacked helper desk: one waiting for the person (call/error) first,
 * then one at work, then the most recently active.
 */
export function stackLead(members: Session[], working: (s: Session) => boolean) {
  const calling = (s: Session) => s.status === 'call' || s.status === 'error';
  return [...members].sort(
    (a, b) =>
      Number(calling(b)) - Number(calling(a)) ||
      Number(working(b)) - Number(working(a)) ||
      b.updatedAt - a.updatedAt,
  )[0];
}

/** One sheet per five minutes of the current task (at least one), up to eight. */
export const PAPER_MINUTES = 5;
export const MAX_PAPERS = 8;
/**
 * Papers piled on the desk: they build up while the task runs and stay while the colleague
 * stands by; once resting (or with no observed task start) the desk is cleared.
 */
export function deskPapers(s: Session, now = Date.now()) {
  if (s.archived || !['work', 'think', 'done', 'ready'].includes(s.status)) return 0;
  const start = taskStart(s);
  if (!start || start > now) return 0;
  const end = isWorking(s, now) ? now : Math.max(start, s.updatedAt);
  return Math.min(MAX_PAPERS, Math.max(1, Math.floor((end - start) / (PAPER_MINUTES * 60_000))));
}
