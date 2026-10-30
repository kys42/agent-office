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

/**
 * Which step of its loop an animation shows at `local` ms after it started. A smooth loop changes
 * every office frame; one whose keyframes are already stepped (`steps` > 1: a sprite's 4 frames)
 * only once per drawn frame, so the ticks in between leave it alone. Before its delay ends it
 * shows its first frame (-1). Equal keys mean an unchanged picture.
 */
export function stepKey(local: number, delay: number, duration: number, steps = 1) {
  const active = local - delay;
  const stepMs = steps > 1 ? Math.max(duration / steps, FRAME_MS) : FRAME_MS;
  return active < 0 ? -1 : Math.floor(active / stepMs);
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
