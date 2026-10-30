import { onPageVisibility, isPageHidden } from './visibility';
import {
  changePoints,
  createTicker,
  FRAME_MS,
  loopPosition,
  pausedByCss,
  type KeyframeTiming,
  type LoopState,
} from './office-tick';

export { FRAME_MS } from './office-tick';

/**
 * The office draws at its own frame rate, like a pixel game, not at the display's (60–120Hz).
 *
 * The stylesheets still say what loops and how (sprite frames, the work meter, typing dots,
 * pulses), but no looping animation runs on its own: each one is paused as it appears and the
 * office tick (office-tick.ts) moves it to where it would be, on a shared FRAME_MS grid, and only
 * when its picture changes. A running infinite animation, even one that changes 8 times a second,
 * keeps the compositor asking for a frame at display rate; paused ones leave it asleep until the
 * tick changes something. Each loop keeps its own phase, so colleagues don't move in lockstep,
 * and a new one starts from its first frame.
 *
 * The tick rests with the window (out of sight), slows when another app has had the focus for a
 * while, and holds every loop on its first frame when less motion is asked for. Looping durations
 * and delays in the stylesheets are multiples of FRAME_MS (tested), so the steps land on the
 * grid. One-shot effects (arrivals, entrances) stay smooth CSS.
 */
/** Short-lived loading spinners read better smooth and are not part of the scene. */
const SMOOTH = new Set(['spin']);

interface Loop extends LoopState {
  name: string;
  /** Where its picture changes within an iteration (null: every office frame). */
  points: number[] | null;
  /** Its element's live computed style, to see what the stylesheet asks (a CSS pause). */
  style: CSSStyleDeclaration;
}
const loops = new Map<Animation, Loop>();
const now = () => document.timeline.currentTime as number;
const snap = (t: number) => Math.round(t / FRAME_MS) * FRAME_MS;

/** Where one loop should be as of `at`, or null to leave it. Reads only. */
function due(animation: Animation, loop: Loop, at: number) {
  const timing = (animation.effect as KeyframeEffect).getTiming();
  const paused = pausedByCss(loop.style.animationName, loop.style.animationPlayState, loop.name);
  return loopPosition(
    loop,
    at,
    paused,
    { delay: Number(timing.delay) || 0, duration: Number(timing.duration) || FRAME_MS },
    loop.points,
  );
}

/** Whether CSS still has this loop (seeking a cancelled one would bring it back, orphaned). */
function live(animation: Animation) {
  const target = (animation.effect as KeyframeEffect | null)?.target;
  return animation.playState !== 'idle' && !!target?.isConnected;
}

/** Less motion: every loop sits on its first frame. */
function hold(animation: Animation, loop: Loop) {
  if (loop.key === -2 || !live(animation)) return;
  loop.key = -2;
  animation.currentTime = 0;
}

/** Loops seen but not yet taken over: a burst of `animationstart` events is taken in one go. */
const pending = new Set<Animation>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function adopt(animation: Animation) {
  if (loops.has(animation) || pending.has(animation)) return;
  pending.add(animation);
  flushTimer ??= setTimeout(takeOver, 0);
}

/** Pauses newly seen loops and puts them where the office clock has them. */
function takeOver() {
  flushTimer = undefined;
  const at = Math.floor(now() / FRAME_MS) * FRAME_MS;
  const still = ticker.conditions.still;
  // Reads first, then writes (see `step`).
  const fresh: [Animation, Loop, number | null][] = [];
  for (const animation of pending) {
    if (typeof CSSAnimation === 'undefined' || !(animation instanceof CSSAnimation)) continue;
    if (SMOOTH.has(animation.animationName) || animation.playState === 'idle') continue;
    const effect = animation.effect as KeyframeEffect | null;
    if (!effect) continue;
    const timing = effect.getComputedTiming();
    if (timing.iterations !== Infinity || !Number(timing.duration)) continue;
    const elapsed = Number(animation.currentTime ?? 0);
    const target = effect.target!;
    const loop: Loop = {
      name: animation.animationName,
      origin: snap(now() - elapsed),
      pausedAt: null,
      key: NaN,
      points: changePoints(
        effect.getKeyframes() as KeyframeTiming[],
        String(timing.direction),
        String(timing.easing),
      ),
      style: getComputedStyle(target, effect.pseudoElement),
    };
    fresh.push([animation, loop, still ? 0 : due(animation, loop, at)]);
    if (still) loop.key = -2;
  }
  pending.clear();
  for (const [animation, loop, local] of fresh) {
    animation.pause();
    loops.set(animation, loop);
    if (local !== null) animation.currentTime = local;
  }
  if (fresh.length) ticker.update({ busy: true });
}

/** Steps between looks for loops that slipped past `animationstart` (about once a second). */
const RESCAN_STEPS = 8;
let sinceScan = 0;

function step(at: number) {
  // Something else (a screenshot tool, devtools) may cancel and replay a loop: it would then run
  // freely at display rate, so catch it again.
  if (++sinceScan >= RESCAN_STEPS) {
    sinceScan = 0;
    adoptAll();
  }
  // All reads first, then all writes: reading a CSS animation brings styles up to date, so
  // interleaving would recalculate the page's style once per loop instead of once per step.
  const moves: [Animation, number, boolean][] = [];
  for (const [animation, loop] of loops) {
    // Gone from the stylesheet or the page: CSS cancelled it.
    if (!live(animation)) {
      loops.delete(animation);
      continue;
    }
    const running = animation.playState === 'running';
    if (running) loop.key = NaN;
    const local = due(animation, loop, at);
    if (local !== null) moves.push([animation, local, running]);
  }
  for (const [animation, local, running] of moves) {
    if (running) animation.pause();
    animation.currentTime = local;
  }
  if (!loops.size) ticker.update({ busy: false });
}

const ticker = createTicker({
  now: () => performance.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  onTick: step,
});

function adoptTarget(event: AnimationEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const pseudo = event.pseudoElement ?? '';
  // Pseudo-element animations are only listed with `subtree`.
  for (const animation of target.getAnimations({ subtree: !!pseudo }))
    if (
      animation instanceof CSSAnimation &&
      animation.animationName === event.animationName &&
      ((animation.effect as KeyframeEffect | null)?.pseudoElement ?? '') === pseudo
    )
      adopt(animation);
}

/** Loops that started unseen (out of sight, before this ran) join on the next look. */
function adoptAll() {
  for (const animation of document.getAnimations()) adopt(animation);
}

let appStill = false;
let systemStill: MediaQueryList | null = null;
function updateStill() {
  const still = appStill || !!systemStill?.matches;
  if (still === ticker.conditions.still) return;
  ticker.update({ still });
  if (still) for (const [animation, loop] of loops) hold(animation, loop);
  else adoptAll();
}

/** The app's own "less motion" setting, which every window reads from the shared preferences. */
export function setMotionReduced(reduced: boolean) {
  appStill = reduced;
  updateStill();
}

let started = false;
/** Puts every looping animation of this page on the office tick, now and as they appear. */
export function startFrameClock() {
  if (started || typeof document === 'undefined' || !document.getAnimations) return;
  started = true;
  document.addEventListener('animationstart', adoptTarget, true);
  const visibility = () => {
    ticker.update({ hidden: isPageHidden() });
    if (!isPageHidden()) adoptAll();
  };
  onPageVisibility(visibility);
  visibility();
  const focus = () => ticker.update({ focused: document.hasFocus() });
  window.addEventListener('focus', focus);
  window.addEventListener('blur', focus);
  focus();
  systemStill = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  systemStill?.addEventListener('change', updateStill);
  updateStill();
  adoptAll();
}
