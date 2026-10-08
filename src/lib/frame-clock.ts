/**
 * The office draws at its own frame rate, like a pixel game, not at the display's (60–120Hz).
 *
 * Every looping animation advances in steps of one office frame (FRAME_MS), and all of them
 * share one clock (start time 0 on the document timeline), so whatever changes changes at the
 * same instants. Between those instants nothing on screen differs, and the browser has nothing
 * to paint or composite: about 1000 / FRAME_MS frames a second however many colleagues move.
 *
 * Looping durations and delays in the stylesheets are multiples of FRAME_MS (tested), so the
 * steps land on the shared grid. One-shot effects (arrivals, entrances) stay smooth.
 */
export const FRAME_MS = 125;
/** Short-lived loading spinners read better smooth and are not part of the scene. */
const SMOOTH = new Set(['spin']);

function fit(animation: Animation) {
  if (typeof CSSAnimation === 'undefined' || !(animation instanceof CSSAnimation)) return;
  if (SMOOTH.has(animation.animationName)) return;
  const effect = animation.effect;
  if (!effect) return;
  const timing = effect.getComputedTiming();
  const duration = Number(timing.duration);
  if (timing.iterations !== Infinity || !duration) return;
  // Only the easing is set by script: duration, delay and play state still follow the CSS (a
  // mood change, `.page-hidden`, reduced motion), and this runs again on the next iteration.
  const easing = `steps(${Math.max(1, Math.round(duration / FRAME_MS))})`;
  if (effect.getTiming().easing !== easing) effect.updateTiming({ easing });
  if (animation.playState === 'running' && animation.startTime !== 0) animation.startTime = 0;
}

function fitTarget(event: AnimationEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  for (const animation of target.getAnimations({ subtree: true }))
    if (
      animation instanceof CSSAnimation &&
      animation.animationName === event.animationName &&
      ((animation.effect as KeyframeEffect | null)?.pseudoElement ?? '') ===
        (event.pseudoElement ?? '')
    )
      fit(animation);
}

let started = false;
/** Puts every looping animation of this page on the office clock, now and as they appear. */
export function startFrameClock() {
  if (started || typeof document === 'undefined' || !document.getAnimations) return;
  started = true;
  document.addEventListener('animationstart', fitTarget, true);
  document.addEventListener('animationiteration', fitTarget, true);
  for (const animation of document.getAnimations()) fit(animation);
}
