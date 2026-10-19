import type { Screen } from './screen.js';

/**
 * The composer is the agent's own input box: what a follow-up is typed into. Agents differ in
 * how it looks and how it is emptied, so each agent has an adapter behind this one interface;
 * the send flow around it (asking the person, the clipboard backup, re-checking the screen,
 * typing and submitting) exists once, in desktop/terminals.ts.
 */

/** Keys an adapter may press. Hosts translate them (tmux key names, raw bytes for Orca). */
/** Deletion pairs, plus the probe: one 'l' typed and taken back (BSpace) to tell a suggestion. */
export type ComposerKey = 'C-k' | 'C-u' | 'l' | 'BSpace';

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
 *   For both, `whole`: all of the text is known (on screen, or reported apart in full). A box
 *   too short for its text shows only part of it; such a composer needs explicit permission to clear hidden content.
 * - `closed`: no composer on screen (a permission prompt, menu, other view): nothing may be typed.
 * - `unreadable`: the screen could not be read.
 * - `unsupported`: the adapter has no composer to look at (e.g. a queue).
 */
export type ComposerState =
  | { kind: 'empty' }
  | { kind: 'suggestion'; text: string; inferred?: boolean }
  | { kind: 'draft'; text: string; whole: boolean }
  | { kind: 'unknown'; text: string; whole: boolean }
  | { kind: 'closed' }
  | { kind: 'unreadable' }
  | { kind: 'unsupported' };

export interface ComposerCapabilities {
  /**
   * How a follow-up reaches the agent: typed into its terminal (so the composer must be checked
   * first), handed to its own queue (no composer involved), or not at all.
   */
  delivery: 'terminal' | 'queue' | 'none';
  /** The composer can be read on this host. A terminal send needs it. */
  canInspect: boolean;
  /** A suggestion can be told apart from a draft on this host. */
  canDetectSuggestion: boolean;
  /** The adapter can empty the composer and verify it. */
  canClear: boolean;
}

/** Saves the composer's text (the clipboard) before anything of it is deleted. */
export type ComposerBackup = (text: string) => Promise<void>;

/**
 * How a clearing ended. `cleared`: the composer is verified ready for typing (`state` is empty
 * or a suggestion). `failed`: it could not be emptied (`state` is what it holds; `partial` when
 * not all of the text was known, so nothing was deleted; `lost` when Claude stopped being the
 * one at the terminal). `changed`: the composer stopped
 * matching the confirmed text minus what the keys deleted (someone typing meanwhile); it was
 * left alone and must be shown again.
 */
export type ClearResult =
  | { status: 'cleared'; state: ComposerState }
  | { status: 'failed'; state: ComposerState; partial?: boolean; lost?: boolean }
  | { status: 'changed'; text: string; whole: boolean };

export interface ComposerAdapter {
  /** The agent's name as shown to the person ("Claude", "Codex"). A brand, never translated. */
  readonly agent: string;
  /** What this agent supports on this host (`null`: no terminal host, e.g. a queue). */
  capabilities(host: Pick<ComposerHost, 'styled'> | null): ComposerCapabilities;
  inspect(host: ComposerHost): Promise<ComposerState>;
  /**
   * Empties the composer that `from` (a fresh inspection the person confirmed) describes.
   * Readable text is backed up before deletion. With allowPartial, the person also accepted
   * losing hidden content that cannot be fully read or backed up.
   */
  clear(
    host: ComposerHost,
    from: Extract<ComposerState, { kind: 'draft' | 'unknown' }>,
    backup: ComposerBackup,
    /** Asked before every key: false (Claude paused, gone, no longer in front) stops at once. */
    proceed?: () => Promise<boolean>,
    options?: { allowPartial?: boolean },
  ): Promise<ClearResult>;
}

/** Ready to type into: typing replaces a suggestion, and the box is otherwise empty. */
export const readyToType = (state: ComposerState) =>
  state.kind === 'empty' || state.kind === 'suggestion';
/** Holds text the person may still want: never typed into without their confirmation. */
export const holdsText = (
  state: ComposerState,
): state is Extract<ComposerState, { kind: 'draft' | 'unknown' }> =>
  state.kind === 'draft' || state.kind === 'unknown';
