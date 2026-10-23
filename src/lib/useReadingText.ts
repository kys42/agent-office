import { useEffect, useSyncExternalStore } from 'react';
import type { Preferences } from '../shared/types';
import { textPrefs, type TextPrefs } from '../shared/text-prefs';

const CACHE_KEY = 'office:reading-text:v1';

/**
 * Bumps whenever reading text may have reflowed without its box resizing — a new size or font,
 * or a web font (Pretendard) finishing loading — so overflow checks (a bubble's unfold control)
 * measure again.
 */
let revision = 0;
const listeners = new Set<() => void>();
function bump() {
  revision++;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** Changes after reading text reflowed; use it as a dependency of an overflow measurement. */
export function useReadingTextRevision() {
  return useSyncExternalStore(subscribe, () => revision);
}
if (typeof document !== 'undefined' && document.fonts?.addEventListener)
  document.fonts.addEventListener('loadingdone', bump);

/** Puts the reading-text size and font on this window's root, where every stylesheet reads it. */
function apply(text: TextPrefs) {
  const root = document.documentElement;
  if (root.dataset.textSize === text.size && root.dataset.readingFont === text.font) return;
  root.style.setProperty('--read-scale', String(text.scale));
  root.style.setProperty('--font-read', text.fontStack);
  // Display headings and tabular timestamps keep their own faces until a font is chosen.
  for (const [name, own] of [
    ['--font-read-display', 'var(--font-display)'],
    ['--font-read-num', 'var(--font-mono)'],
  ])
    root.style.setProperty(name, text.font === 'system' ? own : text.fontStack);
  root.dataset.textSize = text.size;
  root.dataset.readingFont = text.font;
  bump();
}

/** The last choice this window saw, so a new window doesn't flash the default before its snapshot. */
export function bootReadingText() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (cached) apply(textPrefs(cached));
  } catch {
    // A window without storage starts at the default and follows the snapshot.
  }
}

/**
 * #246: every window (big office, dock row/floor/pet, popup card, settings) follows the shared
 * preference, live — a change in the settings window reaches the others with the next snapshot.
 * The demo applies its own choice but never writes the boot cache the real office reads.
 */
export function useReadingText(
  prefs: Pick<Preferences, 'textSize' | 'readingFont'> | undefined,
  ready: boolean,
  demo = false,
) {
  const text = textPrefs(prefs);
  useEffect(() => {
    if (!ready) return;
    apply(text);
    if (demo) return;
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ textSize: text.size, readingFont: text.font }),
      );
    } catch {
      // Only the boot cache is lost.
    }
  }, [ready, demo, text.size, text.font]);
}
