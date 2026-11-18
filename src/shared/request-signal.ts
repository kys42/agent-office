/** The static half of AbortSignal this helper needs. Either member may be missing in older browsers. */
export interface SignalStatics {
  any?: (signals: AbortSignal[]) => AbortSignal;
  timeout?: (ms: number) => AbortSignal;
}

/**
 * A request signal that aborts when the caller's `signal` aborts or after `ms`, whichever is first.
 *
 * `AbortSignal.any` arrived in iOS Safari 17.4 (and `AbortSignal.timeout` in 16). Calling a missing
 * one throws before `fetch` starts, so on an older iPhone every request failed and the mobile page
 * stayed "disconnected". Without them, one AbortController follows both sources instead.
 */
export function requestSignal(
  ms: number,
  signal?: AbortSignal,
  statics: SignalStatics = AbortSignal,
): AbortSignal {
  if (statics.timeout) {
    if (!signal) return statics.timeout(ms);
    if (statics.any) return statics.any([signal, statics.timeout(ms)]);
  }
  const controller = new AbortController();
  const finish = (reason: unknown) => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', follow);
    controller.abort(reason);
  };
  const follow = () => finish(signal?.reason);
  // Same reason as AbortSignal.timeout, so callers can tell a timeout from a cancellation.
  const timer = setTimeout(() => finish(new DOMException('signal timed out', 'TimeoutError')), ms);
  if (signal?.aborted) finish(signal.reason);
  else signal?.addEventListener('abort', follow, { once: true });
  return controller.signal;
}
