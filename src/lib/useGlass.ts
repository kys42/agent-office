import { useEffect } from 'react';
import type { Preferences } from '../shared/types';
import { glassLevel } from '../shared/glass';

const CACHE_KEY = 'office:window-glass:v1';

/** Marks this window's root with the chosen glass, which the stylesheets read. */
function apply(level: number | null) {
  const root = document.documentElement;
  if (level === null) {
    delete root.dataset.glass;
    root.style.removeProperty('--glass-fill');
  } else {
    root.dataset.glass = String(level);
    root.style.setProperty('--glass-fill', `${100 - level}%`);
  }
}

/** The last choice this window saw, so a new card window doesn't flash the old look. */
export function bootGlass() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    apply(glassLevel({ windowGlass: cached }));
  } catch {
    // Without storage the window starts at the default and follows the snapshot.
  }
}

/** Every window follows the shared preference, live (the main process swaps the material). */
export function useGlass(
  prefs: Pick<Preferences, 'windowGlass'> | undefined,
  ready: boolean,
  demo = false,
) {
  const level = glassLevel(prefs);
  useEffect(() => {
    if (!ready) return;
    apply(level);
    if (demo) return;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(level));
    } catch {
      // Only the boot cache is lost.
    }
  }, [ready, demo, level]);
}
