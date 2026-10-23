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
export { parseStyledScreen, sameWrapped, type Screen } from './screen.js';
export { containsLines, mergeBackup } from './backup.js';
export * from './types.js';

/**
 * Codex CLI sessions take follow-ups through `codex queue` (desktop/codex-queue.ts): the
 * message goes to the session's queue, never through the TUI's composer, so whatever is typed
 * there stays untouched. Its composer is not read or cleared, and nothing is typed.
 */
export const codexQueueComposer: ComposerAdapter = {
  agent: 'Codex',
  capabilities: () => ({
    delivery: 'queue',
    canInspect: false,
    canDetectSuggestion: false,
    canClear: false,
  }),
  inspect: async () => ({ kind: 'unsupported' }),
  clear: async () => ({ status: 'failed', state: { kind: 'unsupported' } }),
};

/**
 * Agents with no known composer (OpenClaw, anything new): nothing is sent to them. Should a
 * send path ever reach one, the common flow refuses it as an unsupported agent.
 */
export const unsupportedComposer = (agent: string): ComposerAdapter => ({
  agent,
  capabilities: () => ({
    delivery: 'none',
    canInspect: false,
    canDetectSuggestion: false,
    canClear: false,
  }),
  inspect: async () => ({ kind: 'unsupported' }),
  clear: async () => ({ status: 'failed', state: { kind: 'unsupported' } }),
});

const NAMES: Record<Provider, string> = { claude: 'Claude', codex: 'Codex', openclaw: 'OpenClaw' };

export function composerFor(provider: Provider): ComposerAdapter {
  if (provider === 'claude') return claudeCodeComposer;
  if (provider === 'codex') return codexQueueComposer;
  return unsupportedComposer(NAMES[provider] ?? provider);
}
