import type { Provider } from '../../src/shared/types.js';
import { claudeCodePrompts } from './claude-code.js';
import type { PromptAdapter } from './types.js';

export { claudeCodePrompts, parseDialog } from './claude-code.js';
export * from './types.js';

/**
 * Agents whose dialogs cannot be answered from here: Codex CLI (its approvals and questions
 * live in the TUI, and no public path answers them from outside — `codex queue` only adds
 * messages), OpenClaw and anything new. Their requests are shown; answering goes to the terminal.
 */
export const unsupportedPrompts = (agent: string): PromptAdapter => ({
  agent,
  capabilities: () => ({ canAnswer: false }),
  inspect: async () => ({ kind: 'unsupported' }),
  matches: () => false,
  choices: () => [],
  takesText: () => false,
  answer: async () => ({ status: 'refused', reason: 'changed', pressed: false }),
});

const NAMES: Record<Provider, string> = { claude: 'Claude', codex: 'Codex', openclaw: 'OpenClaw' };

export function promptsFor(provider: Provider): PromptAdapter {
  if (provider === 'claude') return claudeCodePrompts;
  return unsupportedPrompts(NAMES[provider] ?? provider);
}
