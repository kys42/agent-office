import type { Provider } from '../../src/shared/types.js';
import { claudeCodeComposer } from './claude-code.js';
import type { ComposerAdapter } from './types.js';

export {
  claudeCodeComposer,
  classifyPrompt,
  drawn,
  promptHolds,
  readPrompt,
} from './claude-code.js';
export { parseStyledScreen, type Screen } from './screen.js';
export * from './types.js';

/**
 * Codex CLI sessions take follow-ups through `codex queue` (desktop/codex-queue.ts): the
 * message goes to the session's queue, never through the TUI's composer, so whatever is typed
 * there stays untouched. There is nothing to check or clear.
 */
export const codexQueueComposer: ComposerAdapter = {
  agent: 'Codex',
  capabilities: () => ({ needsComposerCheck: false, canDetectSuggestion: false, canClear: false }),
  inspect: async () => ({ kind: 'unsupported' }),
  clear: async () => ({ kind: 'unsupported' }),
};

/**
 * Agents with no known composer (OpenClaw, anything new): nothing is typed into them. Should a
 * send path ever reach one, the common flow sees a composer it must check but cannot read or
 * clear, and refuses.
 */
export const unsupportedComposer = (agent: string): ComposerAdapter => ({
  agent,
  capabilities: () => ({ needsComposerCheck: true, canDetectSuggestion: false, canClear: false }),
  inspect: async () => ({ kind: 'unsupported' }),
  clear: async () => ({ kind: 'unsupported' }),
});

const NAMES: Record<Provider, string> = { claude: 'Claude', codex: 'Codex', openclaw: 'OpenClaw' };

export function composerFor(provider: Provider): ComposerAdapter {
  if (provider === 'claude') return claudeCodeComposer;
  if (provider === 'codex') return codexQueueComposer;
  return unsupportedComposer(NAMES[provider] ?? provider);
}
