import { useEffect, useState } from 'react';
import { api } from './api';
import type { LaunchSupport } from '../shared/launch';

/**
 * What this computer can launch at all (`office:launch-support`, decided by main's launch
 * core per destination): read once per window. Null until known, and where there is no
 * desktop launch API: the launch sheet's entry points stay hidden then.
 */
let asked: Promise<LaunchSupport | null> | null = null;
let known: LaunchSupport | null | undefined;

export function useLaunchSupport(): LaunchSupport | null {
  const [support, setSupport] = useState<LaunchSupport | null>(known ?? null);
  useEffect(() => {
    if (known !== undefined) return;
    let alive = true;
    asked ??= (api.launch && api.launchSupport ? api.launchSupport() : Promise.resolve(null))
      .catch(() => null)
      .then((value) => (known = value));
    void asked.then((value) => alive && setSupport(value));
    return () => {
      alive = false;
    };
  }, []);
  return support;
}
