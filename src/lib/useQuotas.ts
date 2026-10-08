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
    let last = 0;
    const pull = async () => {
      clearTimeout(timer);
      // Out of sight: no timer; showing the window again pulls if one is due.
      if (isPageHidden()) return;
      last = Date.now();
      let wait = QUOTA_PULL_MS;
      try {
        const read: unknown = await api.quotas();
        // Anything but a list of reads is no reading at all (unknown, never "used up").
        const next = Array.isArray(read) ? (read as ProviderQuota[]) : [];
        if (alive) setQuotas(next);
        if (!next.length || next.some((q) => q.state === 'error')) wait = QUOTA_BACKOFF_MS;
      } catch {
        wait = QUOTA_BACKOFF_MS;
      }
      if (alive) timer = setTimeout(pull, wait);
    };
    void pull();
    const stop = onPageVisibility(() => {
      if (!isPageHidden() && Date.now() - last >= QUOTA_PULL_MS) void pull();
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      stop();
    };
  }, [demo, privacy]);
  return quotas;
}
