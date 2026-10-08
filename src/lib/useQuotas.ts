import { useEffect, useState } from 'react';
import { api } from './api';
import { isPageHidden, onPageVisibility } from './visibility';
import type { ProviderQuota } from '../shared/types';

/** How often a shown window reads the usage limits for the desk lights (#29). */
export const QUOTA_PULL_MS = 5 * 60_000;
/** After a failed read, wait longer: the providers rate-limit these calls. */
export const QUOTA_BACKOFF_MS = 15 * 60_000;

/**
 * Usage limits for the desk lights: one slow pull per window while it is shown, never per
 * desk, through the same service call (and its one-minute cache) as the usage panel. Hidden
 * windows rest and catch up when shown again. The demo has none (its desks never go dark), and
 * privacy mode neither reads nor keeps any, like the usage panel (nothing is claimed then).
 * `privacy` is `null` until the preferences are known: no read before that.
 */
export function useQuotas(demo: boolean, privacy: boolean | null): ProviderQuota[] {
  const [quotas, setQuotas] = useState<ProviderQuota[]>([]);
  useEffect(() => {
    setQuotas([]);
    if (demo || privacy !== false) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The earliest next read: the pace after a success, the back-off after a failure. Timers
    // and showing the window again both wait for it.
    let next = 0;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(pull, Math.max(0, next - Date.now()));
    };
    const pull = async () => {
      clearTimeout(timer);
      // Out of sight: no timer; showing the window again reads if one is due.
      if (isPageHidden()) return;
      if (Date.now() < next) return schedule();
      next = Date.now() + QUOTA_PULL_MS; // one read at a time
      let wait = QUOTA_PULL_MS;
      try {
        const read: unknown = await api.quotas();
        // Anything but a list of reads is no reading at all (unknown, never "used up").
        const got = Array.isArray(read) ? (read as ProviderQuota[]) : [];
        if (alive) setQuotas(got);
        if (!got.length || got.some((q) => q.state === 'error')) wait = QUOTA_BACKOFF_MS;
      } catch {
        // A failed read leaves nothing claimed, like a provider error.
        if (alive) setQuotas([]);
        wait = QUOTA_BACKOFF_MS;
      }
      next = Date.now() + wait;
      if (alive) schedule();
    };
    void pull();
    const stop = onPageVisibility(() => {
      if (!isPageHidden()) void pull();
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      stop();
    };
  }, [demo, privacy]);
  return quotas;
}
