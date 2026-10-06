import type { ExecutionPhase, Mood, RuntimeObservation } from './types';
// Office Observation Protocol v1. Provider adapters emit evidence; time policy is shared.
const phases: Record<Mood, ExecutionPhase> = {
  work: 'working',
  think: 'thinking',
  call: 'needs-input',
  done: 'responded',
  error: 'error',
  idle: 'quiet',
  sleep: 'quiet',
  leave: 'quiet',
};
export function runtimeObservation(mood: Mood, at: number, reason: string): RuntimeObservation {
  return {
    phase: reason.includes('turn_aborted') ? 'interrupted' : phases[mood],
    at,
    reason,
    evidence: mood === 'idle' && !reason.includes('turn_aborted') ? 'unknown' : 'observed',
  };
}
export function deriveState(
  status: Mood,
  updatedAt: number,
  now = Date.now(),
  archived = false,
  standbyHours = 4,
): { status: Mood; reason?: string } {
  if (archived) return { status: 'leave', reason: '사용자가 보관한 기록' };
  const age = now - updatedAt;
  if (age >= standbyHours * 3600_000 && status !== 'leave')
    return {
      status: 'sleep',
      reason: `${standbyHours}시간 이상 새 기록 없음 · 실행 종료 여부는 미확인`,
    };
  if (age > 120_000 && ['work', 'think', 'done'].includes(status))
    return { status: 'idle', reason: '최근 새 기록 없음 · 실행 여부는 미확인' };
  return { status };
}
