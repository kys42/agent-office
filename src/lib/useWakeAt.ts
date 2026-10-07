import { useEffect } from 'react';

/**
 * Wake once at the earliest future moment in `times` (e.g. when a desk's arrival ends), so a
 * coarse clock still drops time-boxed effects on time in every view.
 */
export function useWakeAt(times: number[], wake: () => void) {
  const now = Date.now();
  const next = Math.min(...times.filter((t) => t > now));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(wake, Math.max(0, next - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [next]);
}
