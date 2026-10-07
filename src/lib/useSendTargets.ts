import { useCallback, useEffect, useState } from 'react';
import type { TerminalTarget } from '../shared/types';
import { api, isDesktop } from './api';

type Targets = Record<string, TerminalTarget | null>;

/**
 * Where sessions can take a follow-up right now, verified by the desktop app. The colleague
 * card and the office bubbles share this so they never disagree. A working session becomes
 * sendable without a new record line, so busy targets are looked at again while the page is
 * on screen; `stamp` (e.g. the record's `updatedAt`) asks again when the record moves.
 */
export function useSendTargets(ids: readonly string[], enabled = true, stamp = 0) {
  const key = [...new Set(ids)].sort().join('\n');
  const active = enabled && isDesktop && !!api.terminals && key !== '';
  const [state, setState] = useState<{ key: string; targets: Targets }>({ key: '', targets: {} });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    let valid = true;
    api.terminals!(key.split('\n'))
      .then((targets) => valid && setState({ key, targets }))
      .catch(() => valid && setState({ key, targets: {} }));
    return () => {
      valid = false;
    };
  }, [active, key, stamp, tick]);
  const targets: Targets = active && state.key === key ? state.targets : {};
  const waiting = Object.values(targets).some((t) => t && !t.canSend);
  useEffect(() => {
    if (!active) return;
    const check = () => {
      if (!document.hidden) setTick((n) => n + 1);
    };
    const timer = setInterval(check, waiting ? 4000 : 15_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [active, waiting]);
  /** After sending, show the turn as started until the session reports idle again. */
  const markSent = useCallback((id: string) => {
    setState((s) => {
      const target = s.targets[id];
      if (!target || target.queues) return s;
      return {
        ...s,
        targets: { ...s.targets, [id]: { ...target, status: 'busy', canSend: false } },
      };
    });
  }, []);
  return { targets, markSent };
}
