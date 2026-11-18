import type { Session } from '../shared/types';
import { arrivedAt } from '../shared/presentation';

/** The walk-in's length (commute-in in effects.css), with a little slack. */
const WALK_MS = 2_400;
/** Each arrival this window has started walking in, and when. */
const walked = new Map<string, number>();

/**
 * Whether this desk draws its walk-in now: once per arrival in this window, so a desk drawn
 * again (another view, a size switch, a reorder) during the commuting minute does not walk in
 * a second time. A later arrival (brought back again) walks anew.
 */
export function walksIn(s: Session, commuting: boolean, now = Date.now()) {
  if (!commuting) return false;
  const key = `${s.id}:${arrivedAt(s)}`;
  const start = walked.get(key);
  if (start === undefined) {
    walked.set(key, now);
    return true;
  }
  return now - start < WALK_MS;
}
