import type { Screen } from './screen.js';

/**
 * The composer is the agent's own input box: what a follow-up is typed into. Agents differ in
 * how it looks and how it is emptied, so each agent has an adapter behind this one interface;
 * the send flow around it (asking the person, the clipboard backup, re-checking the screen,
 * typing and submitting) exists once, in desktop/terminals.ts.
 */

/** Keys an adapter may press. Hosts translate them (tmux key names, raw bytes for Orca). */
export type ComposerKey = 'C-k' | 'C-u';

/** The terminal a composer is drawn in: tmux or Orca, as seen by an adapter. */
export interface ComposerHost {
  /** The host reports how characters are drawn (faint), not just the characters. */
  readonly styled: boolean;
  /** The screen as shown now, or null when it cannot be read. */
  read(): Promise<Screen | null>;
  press(keys: readonly ComposerKey[]): Promise<void>;
  wait(ms: number): Promise<void>;
}

/**
 * What the composer holds right now.
 * - `empty`: nothing, or a placeholder the agent shows in an empty box.
 * - `suggestion`: text the agent offers (drawn faint); typing replaces it. `inferred` when the
 *   host could not show styles and the text was recognised by surviving the deletion keys.
 * - `draft`: text someone typed or pasted and has not submitted.
 * - `unknown`: text that cannot be told apart from a suggestion on this host (plain screens).
 * - `closed`: no composer on screen (a permission prompt, menu, other view): nothing may be typed.
 * - `unreadable`: the screen could not be read.
 * - `unsupported`: the adapter has no composer to look at (e.g. a queue).
 */
export type ComposerState =
  | { kind: 'empty' }
  | { kind: 'suggestion'; text: string; inferred?: boolean }
  | { kind: 'draft'; text: string }
  | { kind: 'unknown'; text: string }
  | { kind: 'closed' }
  | { kind: 'unreadable' }
  | { kind: 'unsupported' };

export interface ComposerCapabilities {
  /** Sending goes through this composer, so its contents must be checked first. */
  needsComposerCheck: boolean;
  /** A suggestion can be told apart from a draft on this host. */
  canDetectSuggestion: boolean;
  /** The adapter can empty the composer and verify it. */
  canClear: boolean;
}

export interface ComposerAdapter {
  /** The agent's name as shown to the person ("Claude", "Codex"). A brand, never translated. */
  readonly agent: string;
  /** What this agent supports on this host (`null`: no terminal host, e.g. a queue). */
  capabilities(host: Pick<ComposerHost, 'styled'> | null): ComposerCapabilities;
  inspect(host: ComposerHost): Promise<ComposerState>;
  /**
   * Empties the composer and returns what it holds afterwards: `empty` or `suggestion` means
   * verified empty for typing; anything else means it could not be emptied. `from` is what an
   * inspection just found (the text already backed up), so no newer text is cleared unseen.
   */
  clear(host: ComposerHost, from?: ComposerState): Promise<ComposerState>;
}

/** Ready to type into: typing replaces a suggestion, and the box is otherwise empty. */
export const readyToType = (state: ComposerState) =>
  state.kind === 'empty' || state.kind === 'suggestion';
/** Holds text the person may still want: never typed into without their confirmation. */
export const holdsText = (
  state: ComposerState,
): state is Extract<ComposerState, { kind: 'draft' | 'unknown' }> =>
  state.kind === 'draft' || state.kind === 'unknown';
