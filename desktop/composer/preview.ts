import type { ComposerDraftView } from '../../src/shared/types.js';
import { holdsText, readyToType, type ComposerCapabilities, type ComposerState } from './types.js';

/**
 * The composer's state as the card's preview shows it: agent-agnostic, from what the adapter read
 * and what it can do on this host. A suggestion is no draft (the agent offers it; nobody typed
 * it) and blank rows alone hold nothing to show. Text the screen cannot tell from a suggestion is
 * shown with that said, and only text known whole can be submitted as it is.
 */
export function draftView(
  state: ComposerState,
  agent: string,
  can: ComposerCapabilities,
): ComposerDraftView {
  if (!holdsText(state)) {
    if (readyToType(state)) return { kind: 'empty' };
    return {
      kind: 'unknown',
      reason:
        state.kind === 'closed'
          ? 'closed'
          : state.kind === 'unreadable'
            ? 'unreadable'
            : 'unsupported',
    };
  }
  if (!state.text.trim()) return { kind: 'empty' };
  return {
    kind: 'draft',
    // As drawn, indents kept: shown so, and the very string [Send as is] hands back to compare.
    text: state.rows ?? state.text,
    agent,
    submittable: !!can.canSubmitDraft && state.whole,
    ...(state.whole && state.logical !== undefined && { logical: state.logical }),
    ...(!state.whole && { partial: true }),
    ...(state.kind === 'unknown' && !can.canDetectSuggestion && { maybeSuggestion: true }),
  };
}
