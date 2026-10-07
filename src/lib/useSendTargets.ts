import { useCallback, useEffect, useState } from 'react';
import type { TerminalTarget } from '../shared/types';
import { api, isDesktop } from './api';
import { isPageHidden, onPageVisibility } from './visibility';

type Targets = Record<string, TerminalTarget | null>;
const BATCH = 60;

async function lookup(ids: string[]): Promise<Targets> {
  const parts: Promise<Targets>[] = [];
  for (let i = 0; i < ids.length; i += BATCH) parts.push(api.terminals!(ids.slice(i, i + BATCH)));
  return Object.assign({}, ...(await Promise.all(parts)));
}

/**
 * Where sessions can take a follow-up right now, verified by the desktop app. The colleague
 * card and the office bubbles share this so they never disagree.
 *
 * While a changed list loads, targets already known for the remaining ids stay, so an open
 * reply (and its draft) never blinks away. `stamp` (e.g. the newest `updatedAt`) asks again
 * when records move; `pollBusy` also re-checks every 4s while a target is working, for the card
 * that shows when a turn ends.
 */
export function useSendTargets(
  ids: readonly string[],
  options: { enabled?: boolean; stamp?: number; pollBusy?: boolean } = {},
) {
  const { enabled = true, stamp = 0, pollBusy = true } = options;
  const key = [...new Set(ids)].sort().join('\n');
  const active = enabled && isDesktop && !!api.terminals && key !== '';
  const [targets, setTargets] = useState<Targets>({});
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    let valid = true;
    lookup(key.split('\n'))
      .then((found) => valid && setTargets(found))
      .catch(() => {
        /* keep what is known; the next poll tries again */
      });
    return () => {
      valid = false;
    };
  }, [active, key, stamp, tick]);
  const wanted = new Set(active ? key.split('\n') : []);
  const shown: Targets = {};
  for (const [id, target] of Object.entries(targets)) if (wanted.has(id)) shown[id] = target;
  const waiting = pollBusy && Object.values(shown).some((t) => t && !t.canSend);
  useEffect(() => {
    if (!active) return;
    const check = () => {
      if (!isPageHidden()) setTick((n) => n + 1);
    };
    const timer = setInterval(check, waiting ? 4000 : 15_000);
    const stop = onPageVisibility(check);
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [active, waiting]);
  /** After sending, show the turn as started until the session reports idle again. */
  const markSent = useCallback((id: string) => {
    setTargets((all) => {
      const target = all[id];
      if (!target || target.queues) return all;
      return { ...all, [id]: { ...target, status: 'busy', canSend: false } };
    });
  }, []);
  return { targets: shown, markSent };
}
