import { useEffect } from 'react';
import type { Preferences } from '../shared/types';
import { textPrefs, type TextPrefs } from '../shared/text-prefs';

const CACHE_KEY = 'office:reading-text:v1';

/** Puts the reading-text size and font on this window's root, where every stylesheet reads it. */
function apply(text: TextPrefs) {
  const root = document.documentElement;
  root.style.setProperty('--read-scale', String(text.scale));
  root.style.setProperty('--font-read', text.fontStack);
  root.dataset.textSize = text.size;
  root.dataset.readingFont = text.font;
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
 */
export function useReadingText(
  prefs: Pick<Preferences, 'textSize' | 'readingFont'> | undefined,
  ready: boolean,
) {
  const text = textPrefs(prefs);
  useEffect(() => {
    if (!ready) return;
    apply(text);
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ textSize: text.size, readingFont: text.font }),
      );
    } catch {
      // Only the boot cache is lost.
    }
  }, [ready, text.size, text.font]);
}
