import { m, messagesFor, type Messages } from './i18n';

/**
 * A constant-shaped label map (`LABELS[key]`) that reads the active language on every access,
 * so exported maps keep their name and shape and are never stale after a language switch.
 * Keys come from the English source catalog.
 */
export function liveLabels<T extends Record<string, string>>(pick: (t: Messages) => T): T {
  const out = {} as T;
  for (const key of Object.keys(pick(messagesFor('en'))))
    Object.defineProperty(out, key, { enumerable: true, get: () => pick(m())[key] });
  return out;
}

/**
 * The same for a fixed-length label list (`LIST[i]`, spread, `map`): each index reads the
 * active language on access. The length comes from the English source catalog.
 */
export function liveList<T extends readonly string[]>(pick: (t: Messages) => T): T {
  const out: string[] = [];
  pick(messagesFor('en')).forEach((_, i) =>
    Object.defineProperty(out, i, { enumerable: true, get: () => pick(m())[i] }),
  );
  return Object.freeze(out) as unknown as T;
}
