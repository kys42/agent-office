import type { ComposerDraftView } from '../../src/shared/types.js';
import { holdsText, readyToType, type ComposerCapabilities, type ComposerState } from './types.js';

/**
 * The composer's state as the card's preview shows it: agent-agnostic, from what the adapter read
 * and what it can do on this host. A suggestion is no draft (the agent offers it; nobody typed
 * it): told by its style, it is shown as the agent's suggestion, offered to send only where the
 * adapter can take it in and all of it shows. One only inferred (no styles) is not shown, and
 * blank rows alone hold nothing to show. Text the screen cannot tell from a suggestion is shown
 * with that said, and only text known whole can be submitted as it is.
 */
export function draftView(
  state: ComposerState,
  agent: string,
  can: ComposerCapabilities,
): ComposerDraftView {
  if (state.kind === 'suggestion' && !state.inferred && state.text.trim())
    return {
      kind: 'suggestion',
      text: state.text,
      agent,
      submittable: !!can.canSubmitSuggestion && !!state.whole,
    };
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
  const maybeSuggestion = state.kind === 'unknown' && !can.canDetectSuggestion;
  return {
    kind: 'draft',
    // As drawn, indents kept: shown so, and the very string [Send as is] hands back to compare.
    text: state.rows ?? state.text,
    agent,
    submittable: !!can.canSubmitDraft && state.whole,
    ...(state.whole && state.logical !== undefined && { logical: state.logical }),
    ...(!state.whole && { partial: true }),
    ...(maybeSuggestion && { maybeSuggestion: true }),
    // One line known whole that may be the suggestion: sent through the accept key, which takes
    // a suggestion in and leaves typed text as it is (`submitSuggestion`).
    ...(maybeSuggestion &&
      !!can.canSubmitDraft &&
      !!can.canSubmitSuggestion &&
      state.whole &&
      !state.text.includes('\n') &&
      (state.rows ?? state.text) === state.text && { acceptsSuggestion: true }),
  };
}
