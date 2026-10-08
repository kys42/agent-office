import { onPageVisibility } from './visibility';

/**
 * The office draws at its own frame rate, like a pixel game, not at the display's (60–120Hz).
 *
 * Every looping animation advances in steps of one office frame (FRAME_MS), and its start time
 * sits on a shared FRAME_MS grid of the document timeline, so whatever changes changes at the
 * same instants. Between those instants nothing on screen differs, and the browser has nothing
 * to paint or composite: about 1000 / FRAME_MS frames a second however many colleagues move.
 * Snapping (not zeroing) the start keeps each loop's own phase, so colleagues don't move in
 * lockstep and a new one starts from its first frame.
 *
 * Looping durations and delays in the stylesheets are multiples of FRAME_MS (tested), so the
 * steps land on the grid. One-shot effects (arrivals, entrances) stay smooth.
 */
export const FRAME_MS = 125;
/** Short-lived loading spinners read better smooth and are not part of the scene. */
const SMOOTH = new Set(['spin']);

/** Steps already in the keyframes (sprites: 4 frames). Office steps must be a multiple of it. */
function keyframeSteps(effect: KeyframeEffect) {
  let steps = 1;
  for (const k of effect.getKeyframes()) {
    const n = Number(String(k.easing ?? '').match(/^steps\((\d+)/)?.[1] ?? 1);
    steps = Math.max(steps, n);
  }
  return steps;
}

function fit(animation: Animation) {
  if (typeof CSSAnimation === 'undefined' || !(animation instanceof CSSAnimation)) return;
  if (SMOOTH.has(animation.animationName)) return;
  const effect = animation.effect as KeyframeEffect | null;
  if (!effect) return;
  const timing = effect.getComputedTiming();
  const duration = Number(timing.duration);
  if (timing.iterations !== Infinity || !duration) return;
  // Whole office frames, and never fewer than the keyframes' own steps (no frame skipped).
  const own = keyframeSteps(effect);
  const steps = Math.max(own, Math.round(duration / FRAME_MS / own) * own);
  // A smooth back-and-forth loop shows both of its ends (same step length: jump-none spreads
  // the values, not the time). Loops with their own keyframe steps keep their frames as drawn.
  const alternate = String(timing.direction).startsWith('alternate') && own === 1 && steps > 1;
  const easing = alternate ? `steps(${steps}, jump-none)` : `steps(${steps})`;
  // Only the easing is set by script: duration, delay and play state still follow the CSS (a
  // mood change, `.page-hidden`), and this runs again on the next iteration.
  if (effect.getTiming().easing !== easing) effect.updateTiming({ easing });
  const start = animation.startTime;
  if (animation.playState !== 'running' || start === null) return;
  const snapped = Math.round(Number(start) / FRAME_MS) * FRAME_MS;
  if (snapped !== start) animation.startTime = snapped;
}

function fitTarget(event: AnimationEvent) {
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
      fit(animation);
}

/** Back on screen: resumed loops get a new start time; put them on the grid once ready. */
function refit() {
  for (const animation of document.getAnimations())
    animation.ready.then(() => fit(animation)).catch(() => {});
}

let started = false;
/** Puts every looping animation of this page on the office clock, now and as they appear. */
export function startFrameClock() {
  if (started || typeof document === 'undefined' || !document.getAnimations) return;
  started = true;
  document.addEventListener('animationstart', fitTarget, true);
  document.addEventListener('animationiteration', fitTarget, true);
  onPageVisibility(() => requestAnimationFrame(refit));
  for (const animation of document.getAnimations()) fit(animation);
}
