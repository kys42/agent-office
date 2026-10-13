import type { InputRequest, Provider } from '../../src/shared/types.js';
import { claudeCodeDialogs } from './claude-code.js';
import { findClaudeTarget } from './claude-target.js';
import type { PromptAdapter } from './types.js';

export { claudeCodeDialogs, parseDialog, subjectOf, callShows } from './claude-code.js';
export { claudeTarget, openCallsIn, resultIn, type ClaudeTargetDeps } from './claude-target.js';
export * from './types.js';

const ALL: ReadonlySet<InputRequest['kind']> = new Set(['question', 'plan', 'permission']);
const NONE: ReadonlySet<InputRequest['kind']> = new Set();

/**
 * Claude Code in Orca or tmux. Every kind was answered end to end on both hosts (measured,
 * docs/development/TERMINAL.md).
 */
export const claudeCodePrompts: PromptAdapter = {
  ...claudeCodeDialogs,
  answers: () => ALL,
  target: findClaudeTarget,
};

/**
 * Agents whose dialogs cannot be answered from here: Codex CLI (its approvals and questions
 * live in the TUI, and no public path answers them from outside — `codex queue` only adds
 * messages), OpenClaw and anything new. Their requests are shown; answering goes to the terminal.
 */
export const unsupportedPrompts = (agent: string): PromptAdapter => ({
  agent,
  answers: () => NONE,
  target: async () => null,
  inspect: async () => ({ kind: 'unsupported' }),
  identify: () => ({ status: 'none' }),
  choices: () => [],
  hasMore: () => false,
  takesText: () => [],
  answer: async () => ({ status: 'refused', reason: 'unsupported', pressed: false }),
});

const NAMES: Record<Provider, string> = { claude: 'Claude', codex: 'Codex', openclaw: 'OpenClaw' };

export function promptsFor(provider: Provider): PromptAdapter {
  if (provider === 'claude') return claudeCodePrompts;
  return unsupportedPrompts(NAMES[provider] ?? provider);
}
