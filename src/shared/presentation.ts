import type { ExecutionPhase, Mood, RuntimeObservation, Session } from './types';

import { taskStart } from './lifecycle';
import { DEFAULT_READY_MINUTES, QUIET_MS, runtimeObservation } from './runtime';
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
  const resting =
    ['idle', 'sleep', 'done', 'leave'].includes(s.status) &&
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
export const POSTURE_LABELS: Record<string, string> = {
  stored: '보관 중',
  calling: '응답을 기다려요',
  attention: '확인이 필요해요',
  dozing: '잠깐 졸고 있어요',
  strolling: '자리 옆에서 기지개',
  resting: '자리에서 쉬는 중',
  standby: '자리에서 다음 요청을 기다려요',
  typing: '작업 기록이 이어져요',
  thinking: '응답을 준비하는 중',
  result: '응답이 도착했어요',
};

export const PHASE_LABELS: Record<ExecutionPhase, string> = {
  working: '작업 중',
  thinking: '응답 준비',
  'needs-input': '입력 필요',
  responded: '응답 완료',
  interrupted: '중단됨',
  error: '오류 관측',
  quiet: '최근 실행 정보 없음',
  unknown: '미확인',
};

/** Decorative focus level, anchored to a known current request, never session age. */
export function focusLevel(s: Session, now = Date.now()): 0 | 1 | 2 {
  const start = taskStart(s);
  if (!isWorking(s, now) || !start || start > now) return 0;
  const minutes = (now - start) / 60_000;
  return minutes >= 15 ? 2 : minutes >= 5 ? 1 : 0;
}
