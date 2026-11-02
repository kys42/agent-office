import path from 'node:path';
import type { LaunchPlace } from '../src/shared/types.js';

/**
 * Launches that may still start on their own, or may have started unseen: Orca made the tab and
 * queued the command, but its terminal had not appeared when we stopped looking (it starts once
 * Orca mounts the tab); Terminal or tmux was cut off by our time limit after it may already have
 * taken the command. Until a process shows it, the duplicate-launch check
 * (desktop/launch-guard.ts) reads this record as "open" where it went, for a while, instead of
 * letting the same conversation start a second time. Main-process memory only.
 */
export const PENDING_LAUNCH_MS = 120_000;

/**
 * What a launch starts: a saved conversation, a fresh summon (agent, folder and name), or a
 * fork of a conversation (`fork`: its original in `nativeId`, plus folder and name). A fork is
 * a new conversation, so it is never the original's record: only the same fork is held back.
 */
export interface PendingLaunchTarget {
  provider: string;
  nativeId: string;
  cwd: string | null;
  fresh?: boolean;
  fork?: boolean;
  /** A fresh summon's or a fork's name (its tab title / tmux name). */
  name?: string;
}

export function pendingLaunchKey(s: PendingLaunchTarget): string {
  if (s.fork)
    return `fork:${s.provider}:${s.nativeId}:${path.resolve(s.cwd ?? '')}:${s.name ?? ''}`;
  return s.fresh
    ? `new:${s.provider}:${path.resolve(s.cwd ?? '')}:${s.name ?? ''}`
    : `${s.provider}:${s.nativeId}`;
}

export class PendingLaunches {
  private until = new Map<string, { until: number; where: LaunchPlace }>();
  constructor(
    private ttl = PENDING_LAUNCH_MS,
    private now: () => number = Date.now,
  ) {}
  /** `where`: the place it may be starting in (an Orca tab unless said otherwise). */
  add(target: PendingLaunchTarget, where: LaunchPlace = 'orca') {
    this.until.set(pendingLaunchKey(target), { until: this.now() + this.ttl, where });
  }
  clear(target: PendingLaunchTarget) {
    this.until.delete(pendingLaunchKey(target));
  }
  /** Where a launch of it may still be starting; `undefined` when none is. */
  where(target: PendingLaunchTarget): LaunchPlace | undefined {
    const key = pendingLaunchKey(target);
    const entry = this.until.get(key);
    if (entry === undefined) return undefined;
    if (entry.until > this.now()) return entry.where;
    this.until.delete(key);
    return undefined;
  }
  has(target: PendingLaunchTarget): boolean {
    return this.where(target) !== undefined;
  }
}
