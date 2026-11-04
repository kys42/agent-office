import { randomUUID } from 'node:crypto';
import { m } from '../../src/shared/i18n/index.js';
import type { LaunchKind } from '../../src/shared/launch.js';
import type { Provider } from '../../src/shared/types.js';

/**
 * How each agent is started, shared by every destination (tmux, Orca, Terminal.app, a copied
 * command): its arguments for a new, resumed or forked conversation, whether a new
 * conversation's id can be chosen up front, its permission-skipping flag and the variable that
 * names its home. Destinations only render these words (an argv for tmux, single-quoted shell
 * words for a tab); agent differences never leave this file.
 *
 * - Claude takes `--session-id <uuid>` for a new conversation, and with `--fork-session` for a
 *   fork too (the new branch's id; Claude's own daemon starts its forks the same way), so the
 *   office knows the conversation a launch started before Claude writes it.
 * - Codex picks its own thread id (`codex resume <id>`, `codex fork <id>`): a launched Codex is
 *   recognised later, once its live screen is verified (tmux `adopt`).
 * - OpenClaw has no terminal CLI to launch: every launch is refused with a reason.
 */

/** What to start, in the agent's terms. */
export interface AgentLaunch {
  kind: LaunchKind;
  provider: Provider;
  /** resume: the conversation; fork: the one branched off. */
  nativeId?: string;
  /** new / fork: the id chosen up front where the agent takes one (`newSessionId`). */
  sessionId?: string;
  /** new / fork: the first prompt, sent once. A resume never sends one. */
  initialMessage?: string;
  /** The person's `tmuxSkipPermissions`. */
  skipPermissions?: boolean;
}

/** The agent's words after its executable: options, then the first prompt after `--`. */
export interface AgentWords {
  args: string[];
  /** Passed after `--`, so a prompt starting with `-` is never read as an option. */
  message?: string;
}

export interface AgentLauncher {
  /** Why this agent cannot start `kind`; '' when it can. */
  refusal(kind: LaunchKind): string;
  /** The variable that points the agent at its conversations, when not its default home. */
  home?: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME';
  skipFlag?: string;
  /** A new conversation's id, chosen before launch (only where the agent takes one). */
  newSessionId?(): string;
  words(launch: AgentLaunch, flags: string[]): string[];
}

/** A conversation id as the agents print them; anything else never reaches an argument. */
export const NATIVE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;

const unsupported = () => m().launch.agentUnsupported;
export const AGENT_LAUNCH: Record<Provider, AgentLauncher> = {
  claude: {
    refusal: () => '',
    home: 'CLAUDE_CONFIG_DIR',
    skipFlag: '--dangerously-skip-permissions',
    newSessionId: () => randomUUID(),
    words: (l, flags) => {
      const id = l.sessionId ? ['--session-id', l.sessionId] : [];
      if (l.kind === 'resume') return [...flags, '--resume', l.nativeId!];
      if (l.kind === 'fork') return [...flags, ...id, '--fork-session', '--resume', l.nativeId!];
      return [...flags, ...id];
    },
  },
  codex: {
    refusal: () => '',
    home: 'CODEX_HOME',
    skipFlag: '--dangerously-bypass-approvals-and-sandbox',
    // Codex takes the flags as options of its subcommand.
    words: (l, flags) =>
      l.kind === 'resume'
        ? ['resume', ...flags, l.nativeId!]
        : l.kind === 'fork'
          ? ['fork', ...flags, l.nativeId!]
          : flags,
  },
  openclaw: {
    refusal: (kind) => (kind === 'fork' ? m().launch.forkUnsupported : unsupported()),
    words: () => {
      throw new Error(unsupported());
    },
  },
};

export const agentLauncher = (provider: Provider): AgentLauncher =>
  AGENT_LAUNCH[provider] ?? {
    refusal: unsupported,
    words: () => {
      throw new Error(unsupported());
    },
  };

/** Why the agent cannot start this launch ('' when it can): the agent, then its ids. */
export function agentRefusal(l: Pick<AgentLaunch, 'kind' | 'provider' | 'nativeId'>): string {
  const refusal = agentLauncher(l.provider).refusal(l.kind);
  if (refusal) return refusal;
  if (l.kind !== 'new' && !NATIVE_ID.test(l.nativeId ?? '')) return m().launch.noConversation;
  return '';
}

/** A first prompt as the agents take it: no control characters but line breaks, 4,000 at most. */
export function validMessage(text: string | undefined): boolean {
  return (
    text === undefined ||
    (typeof text === 'string' &&
      text.length <= 4000 &&
      !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
  );
}

/** The agent's words for this launch. Throws (with the reason) what the agent cannot start. */
export function agentWords(l: AgentLaunch): AgentWords {
  const refusal = agentRefusal(l);
  if (refusal) throw new Error(refusal);
  if (l.sessionId !== undefined && !/^[0-9a-f-]{36}$/i.test(l.sessionId))
    throw new Error(m().tmux.unsupported);
  const agent = agentLauncher(l.provider);
  const flags = l.skipPermissions && agent.skipFlag ? [agent.skipFlag] : [];
  const message = l.kind === 'resume' || !l.initialMessage?.trim() ? undefined : l.initialMessage;
  if (!validMessage(message)) throw new Error(m().tmux.invalidMessage);
  return { args: agent.words(l, flags), ...(message !== undefined && { message }) };
}

/** A new conversation's id chosen up front for this launch, when the agent takes one. */
export const chooseSessionId = (l: Pick<AgentLaunch, 'kind' | 'provider'>): string | undefined =>
  l.kind === 'resume' ? undefined : agentLauncher(l.provider).newSessionId?.();
