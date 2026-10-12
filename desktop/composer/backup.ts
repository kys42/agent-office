import { drawn } from './claude-code.js';

/** Lines as drawn, blank ones left out: spacing and wrapping never decide a match. */
const lines = (text: string) => text.split('\n').map(drawn).filter(Boolean);

/** `small`'s lines appear in `big` as one run, in order. */
export function containsLines(big: string, small: string): boolean {
  const want = lines(small);
  if (!want.length) return true;
  const have = lines(big);
  for (let i = 0; i + want.length <= have.length; i++)
    if (want.every((line, j) => have[i + j] === line)) return true;
  return false;
}

/**
 * What the clipboard should hold after a backup of `next`, when `previous` was backed up
 * earlier (an interrupted clearing, asked again): never less than before. One that holds the
 * other wins; otherwise the earlier text comes first.
 */
export function mergeBackup(previous: string | undefined, next: string): string {
  if (!previous || containsLines(next, previous)) return next;
  if (containsLines(previous, next)) return previous;
  return `${previous}\n${next}`;
}
