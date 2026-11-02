import path from 'node:path';

/**
 * Launches that may still start on their own: Orca made the tab and queued the command, but its
 * terminal had not appeared when we stopped looking (it starts once Orca mounts the tab). Until
 * then neither a process nor an Orca terminal shows it, so the duplicate-launch check
 * (desktop/launch-guard.ts) reads this record as "open in Orca" for a while instead of letting
 * the same conversation start a second time. Main-process memory only; nothing is stored.
 */
export const PENDING_LAUNCH_MS = 120_000;

/** What a launch starts: a saved conversation, or a fresh summon (agent, folder and name). */
export interface PendingLaunchTarget {
  provider: string;
  nativeId: string;
  cwd: string | null;
  fresh?: boolean;
  /** A fresh summon's name (its tab title / tmux name). */
  name?: string;
}

export function pendingLaunchKey(s: PendingLaunchTarget): string {
  return s.fresh
    ? `new:${s.provider}:${path.resolve(s.cwd ?? '')}:${s.name ?? ''}`
    : `${s.provider}:${s.nativeId}`;
}

export class PendingLaunches {
  private until = new Map<string, number>();
  constructor(
    private ttl = PENDING_LAUNCH_MS,
    private now: () => number = Date.now,
  ) {}
  add(target: PendingLaunchTarget) {
    this.until.set(pendingLaunchKey(target), this.now() + this.ttl);
  }
  clear(target: PendingLaunchTarget) {
    this.until.delete(pendingLaunchKey(target));
  }
  has(target: PendingLaunchTarget): boolean {
    const key = pendingLaunchKey(target);
    const until = this.until.get(key);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.until.delete(key);
    return false;
  }
}
