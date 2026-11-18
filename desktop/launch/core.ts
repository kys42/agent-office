import path from 'node:path';
import { m } from '../../src/shared/i18n/index.js';
import {
  LAUNCH_DESTINATIONS,
  type LaunchDestinationId,
  type LaunchKind,
  type LaunchOptions,
  type LaunchProbe,
  type LaunchResult,
  type LaunchSupport,
} from '../../src/shared/launch.js';
import type { DuplicateCheck, LaunchPlace, Provider, Session } from '../../src/shared/types.js';
import { pendingCheck } from '../launch-guard.js';
import { PendingLaunches, type PendingLaunchTarget } from '../pending-launch.js';
import { agentRefusal, chooseSessionId, validMessage } from './agents.js';
import {
  launchQueue,
  runLaunch,
  type Destination,
  type DestinationProbe,
  type LaunchOutcome,
  type LaunchQueue,
} from './pipeline.js';

/**
 * The launch core (#318): one intent, any destination. Windows (and the older channels, and
 * remote launches) name what to start and where; the core checks the agent, gates duplicates,
 * confirms, starts and remembers the choice. Destinations (desktop/launch/destinations.ts) and
 * agents (desktop/launch/agents.ts) hold every difference; nothing here branches on either.
 */

/** What to start, resolved by the main process from saved sessions (never from a window). */
export interface LaunchTarget {
  kind: LaunchKind;
  provider: Provider;
  /** The folder it runs in: the project's (new), the conversation's (resume, fork). */
  cwd: string;
  /** resume: the conversation; fork: the original it branches off. */
  nativeId?: string;
  /** new / fork: the colleague's name (tmux name, tab title, alias). resume: its alias. */
  name?: string;
  /** resume: the conversation's title, for a tab title when it has no alias. */
  title?: string;
  /** new / fork: the first prompt, sent once. */
  initialMessage?: string;
  /** The person's `tmuxSkipPermissions`. */
  skipPermissions?: boolean;
  /** A remote office's launch: never brings anything to the front of this computer. */
  background?: boolean;
  /** An agent CLI already resolved by the caller (a remote launch). */
  executable?: string;
  /** new / fork: the conversation id chosen for this start where the agent takes one. */
  sessionId?: string;
  /** resume / fork: the saved session itself, for its duplicate check. */
  from?: Session;
}

export type LaunchDestination = Destination<LaunchTarget, unknown, unknown>;

export interface LaunchCoreDeps {
  destinations: Partial<Record<LaunchDestinationId, LaunchDestination>>;
  /** Starts not confirmed yet, read by every duplicate check. */
  pending: PendingLaunches;
  queue?: LaunchQueue;
  /**
   * The whole duplicate-launch check of a saved conversation (desktop/launch-guard.ts: its
   * agent process, Orca tab, own tmux session and this pending record). Without it a resume
   * is checked against the pending record only.
   */
  conversationCheck?: (
    target: LaunchTarget,
  ) => ((fresh: boolean) => Promise<DuplicateCheck>) | undefined;
  /** The person's last choice (`preferences.launchDestination`). */
  remembered?: () => LaunchDestinationId | undefined;
  /** Keeps the choice of a launch that went ahead. Never for a background (remote) launch. */
  remember?: (destination: LaunchDestinationId) => unknown;
}

/** This launch in the pending record: a resume is its conversation, a new or fork its slot. */
export function pendingKey(t: LaunchTarget): PendingLaunchTarget {
  return {
    provider: t.provider,
    nativeId: t.nativeId ?? 'new',
    cwd: t.cwd,
    fresh: t.kind === 'new',
    fork: t.kind === 'fork',
    name: t.name ?? '',
  };
}

/** Why the target itself cannot start anywhere ('' when it can). */
export function targetRefusal(t: LaunchTarget): string {
  const agent = agentRefusal(t);
  if (agent) return agent;
  if (!t.cwd || !path.isAbsolute(t.cwd) || /[\x00-\x1f\x7f]/.test(t.cwd))
    return m().tmux.folderMissing;
  if (t.kind !== 'resume') {
    if (!t.name || !/^[\p{L}\p{N} _-]{1,40}$/u.test(t.name)) return m().tmux.invalidName;
    if (!validMessage(t.initialMessage)) return m().tmux.invalidMessage;
  }
  return '';
}

/**
 * The destination offered first: a fork where its original runs now, else the person's last
 * choice, else Orca, else tmux, else whatever else is available (a copied command at least).
 */
export function defaultDestination(
  probes: { id: LaunchDestinationId; probe: LaunchProbe }[],
  remembered?: LaunchDestinationId,
  origin?: LaunchPlace,
): LaunchDestinationId | null {
  const available = (id: string | undefined) =>
    probes.find((p) => p.id === id && p.probe.available)?.id;
  return (
    available(origin) ??
    available(remembered) ??
    available('orca') ??
    available('tmux') ??
    probes.find((p) => p.probe.available)?.id ??
    null
  );
}

/**
 * Where the duplicate check says a conversation runs or is open, when that is a destination. A
 * tab resting in a sleeping Orca workspace is no place it is now: a fork is offered as usual.
 */
const placeOf = (check: DuplicateCheck): LaunchPlace | undefined =>
  check.state === 'running' || (check.state === 'open' && !check.sleeping)
    ? check.where
    : undefined;

export class LaunchCore {
  private queue: LaunchQueue;
  constructor(private deps: LaunchCoreDeps) {
    this.queue = deps.queue ?? launchQueue;
  }
  get pending() {
    return this.deps.pending;
  }
  /**
   * The duplicate gate of this launch. A resume: the conversation's whole check. A new
   * conversation or a fork: only the same launch still starting (a fork is another
   * conversation, so its original running never blocks it).
   */
  guard(target: LaunchTarget): (fresh: boolean) => Promise<DuplicateCheck> {
    const whole = target.kind === 'resume' ? this.deps.conversationCheck?.(target) : undefined;
    if (whole) return whole;
    const key = pendingKey(target);
    return pendingCheck(() => this.deps.pending.state(key));
  }
  private destination(id: LaunchDestinationId): LaunchDestination {
    const destination = this.deps.destinations[id];
    if (!destination) throw new Error(m().launch.agentUnsupported);
    return destination;
  }
  /** What `platform` can ever do: whether any destination works there, and which open. */
  support(platform: string = process.platform): LaunchSupport {
    const ids = LAUNCH_DESTINATIONS.filter((id) => {
      const d = this.deps.destinations[id];
      return !!d && (d.supports?.(platform) ?? true);
    });
    return {
      supported: ids.length > 0,
      opens: ids.filter((id) => this.deps.destinations[id]!.opens?.(platform) ?? false),
    };
  }
  /** Read-only: whether `id` can take this launch now, and why not. */
  async probe(target: LaunchTarget, id: LaunchDestinationId, fresh = false): Promise<LaunchProbe> {
    const refusal = targetRefusal(target);
    if (refusal) return { available: false, reason: refusal };
    const destination = this.deps.destinations[id];
    if (!destination) return { available: false, reason: m().launch.agentUnsupported };
    try {
      return publicProbe(await destination.probe(target, fresh));
    } catch (error) {
      return { available: false, reason: (error as Error).message };
    }
  }
  /** Every destination probed, the duplicate state, and which one to offer first. */
  async options(target: LaunchTarget): Promise<LaunchOptions> {
    const ids = LAUNCH_DESTINATIONS.filter((id) => this.deps.destinations[id]);
    // A fork defaults to where its original is now (its check, as if resuming it).
    const original =
      target.kind === 'fork' ? this.deps.conversationCheck?.({ ...target, kind: 'resume' }) : null;
    const [destinations, duplicate, origin] = await Promise.all([
      Promise.all(ids.map(async (id) => ({ id, probe: await this.probe(target, id) }))),
      this.guard(target)(false).catch((): DuplicateCheck => ({ state: 'unknown' })),
      original ? original(false).then(placeOf, () => undefined) : Promise.resolve(undefined),
    ]);
    const remembered = this.deps.remembered?.();
    return {
      destinations,
      default: defaultDestination(destinations, remembered, origin),
      ...(remembered && { remembered }),
      duplicate,
      ...(origin && { origin }),
    };
  }
  /**
   * Starts the launch at `id` through the pipeline (desktop/launch/pipeline.ts). A new
   * conversation's id is chosen here once, so the confirmation shows the command that runs.
   */
  async start(
    target: LaunchTarget,
    id: LaunchDestinationId,
    options: {
      confirm: (probe: DestinationProbe, check: DuplicateCheck) => Promise<boolean>;
      authorized?: () => void;
    },
  ): Promise<LaunchOutcome & { sessionId?: string }> {
    const refusal = targetRefusal(target);
    if (refusal) return { state: 'refused', reason: refusal, error: new Error(refusal) };
    let destination: LaunchDestination;
    try {
      destination = this.destination(id);
    } catch (error) {
      return { state: 'refused', reason: (error as Error).message, error: error as Error };
    }
    const chosen = target.sessionId ? target : { ...target, sessionId: chooseSessionId(target) };
    const outcome = await runLaunch(destination, chosen, {
      queue: this.queue,
      pending: this.deps.pending,
      key: pendingKey(chosen),
      check: this.guard(chosen),
      confirm: options.confirm,
      authorized: options.authorized,
    });
    if (
      !target.background &&
      ['launched', 'uncertain', 'running', 'copied'].includes(outcome.state)
    )
      await Promise.resolve(this.deps.remember?.(id)).catch(() => undefined);
    return { ...outcome, ...(chosen.sessionId && { sessionId: chosen.sessionId }) };
  }
}

/** What a window may see of a probe: never its destination's private plan. */
export function publicProbe(probe: DestinationProbe): LaunchProbe {
  return {
    available: probe.available,
    ...(probe.reason && { reason: probe.reason }),
    ...(probe.command && { command: probe.command }),
    ...(probe.running && { running: true }),
  };
}

/** The window's answer for an outcome. */
export function launchResult(
  destination: LaunchDestinationId,
  outcome: LaunchOutcome,
): LaunchResult {
  switch (outcome.state) {
    case 'refused':
      return {
        state: 'refused',
        destination,
        reason: outcome.reason,
        ...(outcome.duplicate && { duplicate: outcome.duplicate }),
      };
    case 'cancelled':
      return { state: 'cancelled', destination };
    case 'running':
      return {
        state: 'running',
        destination,
        message: outcome.probe.message ?? '',
        ...(outcome.probe.command && { command: outcome.probe.command }),
      };
    default:
      return {
        state: outcome.state,
        destination,
        message: outcome.message ?? '',
        ...((outcome.command ?? outcome.probe.command) && {
          command: outcome.command ?? outcome.probe.command,
        }),
      };
  }
}
