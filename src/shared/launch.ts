import { z } from 'zod';
import type { DuplicateCheck, LaunchPlace } from './types';

/**
 * One launch request from a window (#318): what to start, where, and whether to only look
 * (`probe`) or start it. The main process resolves every session id to its saved folder and
 * conversation itself; a window never sends a path, a command or an executable.
 */

/** Where a launch can go, in the order a launch sheet offers them. */
export const LAUNCH_DESTINATIONS = ['orca', 'tmux', 'terminalApp', 'copy'] as const;
export type LaunchDestinationId = (typeof LAUNCH_DESTINATIONS)[number];
export type LaunchKind = 'new' | 'resume' | 'fork';

const sessionId = z.string().min(1).max(400);
/** The same rule as a tmux/Orca summon name: shown in the office, tmux and the tab title. */
export const launchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[\p{L}\p{N} _-]+$/u);
/** One first message, sent once as the new conversation's first prompt. */
export const launchMessageSchema = z
  .string()
  .max(4000)
  .regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/)
  .default('');

export const launchIntentSchema = z.discriminatedUnion('kind', [
  /** A new conversation in the folder of `at` (any session of that project). */
  z
    .object({
      kind: z.literal('new'),
      at: sessionId,
      provider: z.enum(['claude', 'codex', 'openclaw']),
      name: launchNameSchema,
      initialMessage: launchMessageSchema,
    })
    .strict(),
  /** The saved conversation itself, continued. */
  z.object({ kind: z.literal('resume'), session: sessionId }).strict(),
  /**
   * A new conversation branched off `session` (its context copied, the original untouched), in
   * the original's folder. Never blocked by the original running: it is another conversation.
   */
  z
    .object({
      kind: z.literal('fork'),
      session: sessionId,
      name: launchNameSchema,
      initialMessage: launchMessageSchema,
    })
    .strict(),
]);
export type LaunchIntent = z.input<typeof launchIntentSchema>;

export const launchRequestSchema = z
  .object({
    intent: launchIntentSchema,
    destination: z.enum(LAUNCH_DESTINATIONS),
    action: z.enum(['probe', 'start']),
  })
  .strict();
export type LaunchRequest = z.input<typeof launchRequestSchema>;

/** Whether one destination can take the launch now, and why not. */
export interface LaunchProbe {
  available: boolean;
  /** Why not, in the person's language. */
  reason?: string;
  /** What it would run (the tmux reconnect command, the tab's command, the copied text). */
  command?: string;
  /** tmux: this launch's own session already runs there (starting opens nothing new). */
  running?: boolean;
}

/** `office:launch-options`: every destination probed for one intent. */
export interface LaunchOptions {
  destinations: { id: LaunchDestinationId; probe: LaunchProbe }[];
  /** The remembered choice when available, else Orca, else tmux (a fork: where it runs). */
  default: LaunchDestinationId | null;
  /** The person's last choice (`preferences.launchDestination`), available or not. */
  remembered?: LaunchDestinationId;
  /** A resume: whether it already runs or is open; new and fork: a launch still starting. */
  duplicate: DuplicateCheck;
  /** A fork: where the original conversation runs or is open now, when known. */
  origin?: LaunchPlace;
}

/**
 * What a start did:
 * - `launched`: it started (Orca confirmed the tab, tmux saw the agent alive, Terminal opened).
 * - `running`: this launch's own tmux session already runs; nothing new was started.
 * - `uncertain`: Orca made the tab but its start was not seen yet; it starts once Orca shows it.
 *   Launching it again is refused as "open" for a while meanwhile. Never suggest another place.
 * - `copied`: the command is on the clipboard.
 * - `cancelled`: the person said no in the confirmation.
 * - `refused`: nothing started, with why; `duplicate` when it already runs or changed meanwhile.
 */
export type LaunchResult =
  | { state: 'probed'; destination: LaunchDestinationId; probe: LaunchProbe }
  | {
      state: 'launched' | 'running' | 'uncertain' | 'copied';
      destination: LaunchDestinationId;
      message: string;
      command?: string;
    }
  | { state: 'cancelled'; destination: LaunchDestinationId }
  | {
      state: 'refused';
      destination: LaunchDestinationId;
      reason: string;
      duplicate?: DuplicateCheck;
    };
