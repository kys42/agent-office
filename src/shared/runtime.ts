import type { ExecutionPhase, Mood, RuntimeObservation } from './types';
import { m } from './i18n';
// Office Observation Protocol v1. Provider adapters emit evidence; time policy is shared.
const phases: Record<Mood, ExecutionPhase> = {
  work: 'working',
  think: 'thinking',
  call: 'needs-input',
  done: 'responded',
  error: 'error',
  ready: 'quiet',
  idle: 'quiet',
  sleep: 'quiet',
  leave: 'quiet',
};
export function runtimeObservation(mood: Mood, at: number, reason: string): RuntimeObservation {
  return {
    phase: reason.includes('turn_aborted') ? 'interrupted' : phases[mood],
    at,
    reason,
    evidence:
      ['idle', 'ready'].includes(mood) && !reason.includes('turn_aborted') ? 'unknown' : 'observed',
  };
}
/** After this much silence, observed work is no longer shown as live (provider-agnostic). */
export const QUIET_MS = 120_000;
export const DEFAULT_READY_MINUTES = 30;

/**
 * The status ladder (docs/golden/STATUS-POLICY.md). From the last activity: observed work for
 * 2 minutes → standing by ('ready') until `readyMinutes` → resting ('idle') until
 * `standbyHours` → gone home ('sleep', lounge). Calls and errors never fall to standing by or
 * resting; like everyone, they go home once `standbyHours` pass.
 */
export function deriveState(
  status: Mood,
  updatedAt: number,
  now = Date.now(),
  archived = false,
  standbyHours = 4,
  readyMinutes = DEFAULT_READY_MINUTES,
): { status: Mood; reason?: string } {
  const t = m().shared.runtime;
  if (archived) return { status: 'leave', reason: t.archived };
  const age = now - updatedAt;
  if (age >= standbyHours * 3600_000 && status !== 'leave')
    return { status: 'sleep', reason: t.offDuty(standbyHours) };
  if (age > QUIET_MS && ['work', 'think', 'done', 'ready'].includes(status))
    return age < readyMinutes * 60_000
      ? { status: 'ready', reason: t.ready(readyMinutes) }
      : { status: 'idle', reason: t.quiet };
  return { status };
}
