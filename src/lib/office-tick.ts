/**
 * The office's one clock: when its looping decorations take their next step (see frame-clock.ts
 * for what a step does). Plain timers, no DOM, so every window (big office, desk pet, dock card,
 * mini office) runs the same rules and tests can drive it.
 *
 * - In sight and in use: one step per office frame (FRAME_MS, 8 a second).
 * - In sight but another app has the focus for a while: half that (RESTING_FRAME_MS).
 * - Out of sight, less motion asked for, or nothing looping: no timer at all.
 */
export const FRAME_MS = 125;
export const RESTING_FRAME_MS = 2 * FRAME_MS;
/** A glance at another app keeps the full rate; only a longer stay away slows the office. */
export const RESTING_AFTER_MS = 3000;

export interface TickConditions {
  /** The window is out of sight (hidden, minimized, covered). */
  hidden: boolean;
  /** Less motion: the app setting or the system's reduced-motion preference. */
  still: boolean;
  /** The window has the keyboard focus. */
  focused: boolean;
  /** Since when it has not (null while focused). */
  blurredAt: number | null;
  /** Anything is looping in this window at all. */
  busy: boolean;
}

/** Milliseconds between steps, or null when the office holds still. */
export function tickInterval(c: TickConditions, now: number): number | null {
  if (c.hidden || c.still || !c.busy) return null;
  if (!c.focused && c.blurredAt !== null && now - c.blurredAt >= RESTING_AFTER_MS)
    return RESTING_FRAME_MS;
  return FRAME_MS;
}

/** A keyframe's place in the loop and the easing to the next one (as `getKeyframes()` gives). */
export interface KeyframeTiming {
  computedOffset: number;
  easing?: string;
}

const STEPS = /^steps\((\d+)/;
const round = (p: number) => Math.round(p * 1e9) / 1e9;

/**
 * Where, as a fraction of one iteration, a stepped loop's picture changes; null when it changes
 * continuously. Easing applies per keyframe segment in CSS, so a `steps(2)` loop with a 50%
 * keyframe changes four times (0, 25, 50, 75%), not twice. Any smooth segment or effect easing
 * makes the whole loop continuous; a reversing direction adds the mirrored points (a superset,
 * so a change is never missed).
 */
export function changePoints(
  keyframes: readonly KeyframeTiming[],
  direction = 'normal',
  effectEasing = 'linear',
): number[] | null {
  if (effectEasing !== 'linear') return null;
  const points = new Set([0]);
  for (let i = 0; i < keyframes.length - 1; i++) {
    const from = keyframes[i].computedOffset;
    const to = keyframes[i + 1].computedOffset;
    if (!(to > from)) continue;
    const n = Number(String(keyframes[i].easing ?? 'linear').match(STEPS)?.[1]);
    if (!n) return null;
    for (let k = 0; k < n; k++) points.add(round(from + ((to - from) * k) / n));
  }
  if (direction !== 'normal') for (const p of [...points]) points.add(round(p ? 1 - p : 0));
  return [...points].filter((p) => p < 1).sort((a, b) => a - b);
}

/**
 * Which picture a loop shows at `local` ms after it started. A continuous loop (no `points`)
 * changes every office frame; a stepped one only where its keyframes step, so the ticks in
 * between leave it alone. Before its delay ends it shows its first frame (-1). Equal keys mean
 * an unchanged picture.
 */
export function stepKey(local: number, delay: number, duration: number, points: number[] | null) {
  const active = local - delay;
  if (active < 0) return -1;
  if (!points?.length || !(duration > 0)) return Math.floor(active / FRAME_MS);
  const iteration = Math.floor(active / duration);
  const progress = (active - iteration * duration) / duration;
  let at = 0;
  for (let i = 0; i < points.length; i++) if (points[i] <= progress + 1e-9) at = i;
  return iteration * points.length + at;
}

/** Whether the stylesheet itself pauses this loop (`animation-play-state` of its layer). */
export function pausedByCss(names: string, states: string, name: string) {
  const index = names.split(',').findIndex((n) => n.trim() === name);
  if (index < 0) return false;
  const list = states.split(',');
  return list[index % list.length].trim() === 'paused';
}

/** One loop as the office clock keeps it. */
export interface LoopState {
  /** Timeline time of its first frame, on the grid; moves on by however long CSS paused it. */
  origin: number;
  /** When CSS paused it (null while it plays). */
  pausedAt: number | null;
  /** Last picture shown (see stepKey); NaN when it must be set again. */
  key: number;
}

/**
 * Where a loop should be at `at`, or null to leave it as it is: unchanged picture, or paused by
 * the stylesheet (dragging a zone flag holds its wave). A CSS pause resumes where it stopped,
 * like CSS, rather than jumping ahead by the time it was held.
 */
export function loopPosition(
  loop: LoopState,
  at: number,
  cssPaused: boolean,
  timing: { delay: number; duration: number },
  points: number[] | null,
) {
  if (cssPaused) {
    loop.pausedAt ??= at;
    return null;
  }
  if (loop.pausedAt !== null) {
    loop.origin += at - loop.pausedAt;
    loop.pausedAt = null;
  }
  const local = at - loop.origin;
  const key = stepKey(local, timing.delay, timing.duration, points);
  if (key === loop.key) return null;
  loop.key = key;
  return local;
}

export interface TickerEnv {
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  /** One step, at an instant on the FRAME_MS grid. */
  onTick(at: number): void;
}

export function createTicker(env: TickerEnv) {
  const c: TickConditions = {
    hidden: false,
    still: false,
    focused: true,
    blurredAt: null,
    busy: false,
  };
  let timer: unknown;
  let interval: number | null = null;
  const schedule = () => {
    const now = env.now();
    const next = tickInterval(c, now);
    if (timer !== undefined && next === interval) return;
    if (timer !== undefined) env.clearTimer(timer);
    timer = undefined;
    interval = next;
    if (next === null) return;
    // Wake on the grid, so every loop and every window steps at the same instants.
    timer = env.setTimer(fire, next - (now % next));
  };
  const fire = () => {
    timer = undefined;
    const now = env.now();
    env.onTick(Math.floor(now / FRAME_MS) * FRAME_MS);
    // The pace is chosen again every step: a long stay in another app slows it here.
    schedule();
  };
  return {
    /** Changes what the clock knows; it starts, stops or changes pace accordingly. */
    update(next: Partial<Omit<TickConditions, 'blurredAt'>>) {
      if (next.focused !== undefined && next.focused !== c.focused)
        c.blurredAt = next.focused ? null : env.now();
      Object.assign(c, next);
      schedule();
    },
    /** Current pace in ms, or null while still. */
    get interval() {
      return interval;
    },
    get conditions(): Readonly<TickConditions> {
      return c;
    },
  };
}
