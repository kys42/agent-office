import type { LaunchDestinationId, LaunchProbe } from '../../src/shared/launch.js';
import type { DuplicateCheck, LaunchPlace } from '../../src/shared/types.js';
import { confirmLaunch, DuplicateLaunchError } from '../launch-guard.js';
import { PendingLaunches, type PendingLaunchTarget } from '../pending-launch.js';

/**
 * The one way anything is launched (#318), whatever the destination:
 *
 *   probe → duplicate check → confirm → duplicate check again → probe again → start
 *         → a start not confirmed (`uncertain`) is kept pending for a while
 *
 * all on one queue, so two launches (of any destination) never interleave: a tmux start waits
 * for an Orca start still looking for its tab, and the second one then sees the first.
 * Destinations only probe and start; nothing here knows tmux, Orca or an agent.
 */

/** A probe with what its destination needs to start (never sent to a window). */
export interface DestinationProbe<D = unknown> extends LaunchProbe {
  /** What to tell when `running` (its own session is already there). */
  message?: string;
  detail?: D;
}

export interface StartContext<D = unknown> {
  /** The probe taken right before this start (its `detail`). */
  probe: DestinationProbe<D>;
  /** Called at the last moment before anything starts (a revoked permission throws). */
  authorized?: () => void;
  /**
   * Holds this launch as pending (where this destination is) while a start that was not
   * confirmed is looked for, or once it may have started unseen.
   */
  hold(): void;
}

/**
 * `uncertain`: the destination may have taken the command without our seeing it start (Orca's
 * tab not mounted yet, Terminal or tmux cut off by our time limit after accepting it). Never a
 * refusal: launching it again would start it twice, so it is kept pending for a while.
 */
export interface DestinationStart<R = unknown> {
  state: 'launched' | 'uncertain' | 'copied';
  message?: string;
  command?: string;
  /** The destination's own answer (the legacy channels return it as they did). */
  detail?: R;
}

export interface Destination<T, D = unknown, R = unknown> {
  readonly id: LaunchDestinationId;
  /** false: nothing starts there (a copied command): no confirmation and nothing pending. */
  readonly launches: boolean;
  /** Where a launch of it runs, as the duplicate check names it (`other` when left out). */
  readonly place?: LaunchPlace;
  /**
   * Its `launched` proves only that it took the command (a Terminal window, an Orca tab), not
   * that the agent runs where the duplicate check can see it: the launch is then reserved
   * (pending, `starting`) for the usual window instead of cleared, so a second start before
   * the agent shows up is cautioned. Once it runs, `running` beats the reservation.
   */
  readonly reserves?: boolean;
  /** Read-only. `fresh`: no cached answer (right before and after a confirmation). */
  probe(target: T, fresh: boolean): Promise<DestinationProbe<D>>;
  /** Starts it; a refusal throws with its reason. */
  start(target: T, context: StartContext<D>): Promise<DestinationStart<R>>;
}

export type LaunchOutcome<D = unknown, R = unknown> =
  | (DestinationStart<R> & { probe: DestinationProbe<D> })
  | { state: 'running' | 'cancelled'; probe: DestinationProbe<D> }
  | {
      state: 'refused';
      reason: string;
      /** What was thrown: rethrown as is by the older channels. */
      error: Error;
      duplicate?: DuplicateCheck;
      probe?: DestinationProbe<D>;
    };

/** One queue for every launch of the app (and one per test fixture). */
export class LaunchQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
/** The app's queue: every destination, the older channels and remote launches share it. */
export const launchQueue = new LaunchQueue();

export interface RunOptions<D> {
  queue?: LaunchQueue;
  /** Where a start not confirmed is kept; a launch without one keeps nothing. */
  pending?: PendingLaunches;
  /** This launch in the pending record (`pendingLaunchKey`). */
  key?: PendingLaunchTarget;
  /**
   * The fresh duplicate-launch check (desktop/launch-guard.ts): for a resume the whole check,
   * for a new conversation or a fork only a launch of the same one still starting.
   */
  check?: (fresh: boolean) => Promise<DuplicateCheck>;
  /** Asks the person (a native dialog); never asked for a destination that launches nothing. */
  confirm(probe: DestinationProbe<D>, check: DuplicateCheck): Promise<boolean>;
  authorized?: () => void;
}

const refused = (error: unknown, probe?: DestinationProbe): LaunchOutcome => {
  const e = error instanceof Error ? error : new Error(String(error));
  return {
    state: 'refused',
    reason: e.message,
    error: e,
    ...(e instanceof DuplicateLaunchError && { duplicate: e.check }),
    ...(probe && { probe }),
  };
};

export function runLaunch<T, D, R>(
  destination: Destination<T, D, R>,
  target: T,
  options: RunOptions<D>,
): Promise<LaunchOutcome<D, R>> {
  const { pending, key } = options;
  return (options.queue ?? launchQueue).run(async () => {
    let probe: DestinationProbe<D> | undefined;
    try {
      probe = await destination.probe(target, true);
      if (!probe.available) return refused(new Error(probe.reason ?? ''), probe);
      // Its own session already runs there (a tmux slot): nothing to start, nothing to ask.
      if (probe.running) return { state: 'running', probe };
      const first = probe;
      if (destination.launches) {
        if (!(await confirmLaunch(options.check, (check) => options.confirm(first, check))))
          return { state: 'cancelled', probe };
      } else if (options.check) {
        // Nothing starts, but a running conversation is still never handed out to start again.
        const check = await options.check(true);
        if (check.state === 'running') throw new DuplicateLaunchError(check);
      }
      // The confirmation can stay open for minutes: the destination is looked at again.
      probe = await destination.probe(target, true);
      if (!probe.available) return refused(new Error(probe.reason ?? ''), probe);
      if (probe.running) return { state: 'running', probe };
      const hold = () => {
        if (pending && key) pending.add(key, destination.place ?? 'other');
      };
      const result = await destination.start(target, {
        probe,
        authorized: options.authorized,
        hold,
      });
      if (pending && key && destination.launches) {
        // Still unseen: the guard runs its full window from now. Handed over: reserved while the
        // agent starts. Seen running (tmux checks its pane): nothing is pending.
        if (result.state === 'uncertain') pending.add(key, destination.place ?? 'other');
        else if (destination.reserves) pending.add(key, destination.place ?? 'other', true);
        else pending.clear(key);
      }
      return { ...result, probe };
    } catch (error) {
      return refused(error, probe) as LaunchOutcome<D, R>;
    }
  }) as Promise<LaunchOutcome<D, R>>;
}

/** The older channels' shape: a refusal throws what was thrown. */
export async function startOrThrow<D, R>(
  outcome: Promise<LaunchOutcome<D, R>>,
): Promise<Exclude<LaunchOutcome<D, R>, { state: 'refused' }>> {
  const result = await outcome;
  if (result.state === 'refused') throw result.error;
  return result;
}
