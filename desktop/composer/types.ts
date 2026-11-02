import type { ImageDelivery } from '../../src/shared/attachments.js';
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
  /** The agent's submit key (Enter): tmux `send-keys Enter`, Orca's own `--enter`. */
  submit(): Promise<void>;
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
 *   `width`: the most cells a row of text in the box can take, when the box was read from the
 *   screen (an overestimate); absent when the host reports the text apart (Orca's `draft`).
 *   `rows`: the box's rows as drawn with only its frame taken off, indents kept (`text` trims
 *   each row): what [Send as is] compares, so an indent changed after the preview is a change.
 *   `logical`: the text as typed — its own line breaks and indents, none of the box's wrapping —
 *   when that can be told for sure: the host reports it apart (Orca's `draft`), or every row
 *   break on screen falls where no wrap could have (see `typedLines`). Absent otherwise.
 * - `closed`: no composer on screen (a permission prompt, menu, other view): nothing may be typed.
 * - `unreadable`: the screen could not be read.
 * - `unsupported`: the adapter has no composer to look at (e.g. a queue).
 */
export type ComposerState =
  | { kind: 'empty' }
  | { kind: 'suggestion'; text: string; inferred?: boolean }
  | { kind: 'draft'; text: string; whole: boolean; width?: number; rows?: string; logical?: string }
  | {
      kind: 'unknown';
      text: string;
      whole: boolean;
      width?: number;
      rows?: string;
      logical?: string;
    }
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
  /**
   * How images reach the agent: attached as images, or only as file paths in the text. Absent:
   * not at all, and a send with images is refused before anything is typed.
   */
  images?: ImageDelivery;
  /**
   * What sits in the composer can be shown as a preview and submitted as it is (`submitDraft`):
   * only Enter is pressed, nothing typed. Off for a queue and for agents with no known composer.
   */
  canSubmitDraft?: boolean;
}

/** Saves the composer's text (the clipboard) before anything of it is deleted. */
export type ComposerBackup = (text: string) => Promise<void>;

/**
 * How a clearing ended. `cleared`: the composer is verified ready for typing (`state` is empty
 * or a suggestion). `failed`: it could not be emptied (`state` is what it holds; `partial` when
 * not all of the text was known, so nothing was deleted; `lost` when Claude stopped being the
 * one at the terminal). `changed`: the composer stopped
 * matching the confirmed text minus what the keys deleted (someone typing meanwhile); it was
 * left alone and must be shown again. `hidden`: the box looked empty, yet one more (lossless)
 * deletion step brought text into view that was out of sight: not all of it was ever shown.
 */
export type ClearResult =
  | { status: 'cleared'; state: ComposerState }
  | { status: 'failed'; state: ComposerState; partial?: boolean; lost?: boolean }
  | { status: 'changed'; text: string; whole: boolean; hidden?: boolean };

/**
 * How submitting the composer's own text ended (`submitDraft`). `submitted`: Enter went in
 * right after the box was seen holding exactly the expected text, all of it (`state`: that last
 * look). Otherwise nothing was pressed: `changed` the box holds something else now (`state`); `partial` not all of its text
 * is known; `lost` the agent stopped being the one at the terminal; `closed` a dialog or menu
 * replaced the box; `unreadable` the screen could not be read; `unsupported` no such adapter.
 */
export type DraftSubmitOutcome =
  | { status: 'submitted'; state: ComposerState }
  | { status: 'changed'; state: ComposerState }
  | { status: 'refused'; reason: 'partial' | 'lost' | 'closed' | 'unreadable' | 'unsupported' };

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
  /**
   * Submits what the composer holds, exactly as it is: the box is read, then (after `proceed`)
   * read once more right before the key, and the submit key goes in only while both reads show
   * exactly `expected`, all of it. Nothing is typed or deleted. Absent: not offered.
   */
  submitDraft?(
    host: ComposerHost,
    expected: string,
    proceed: () => Promise<boolean>,
  ): Promise<DraftSubmitOutcome>;
}

/** Ready to type into: typing replaces a suggestion, and the box is otherwise empty. */
export const readyToType = (state: ComposerState) =>
  state.kind === 'empty' || state.kind === 'suggestion';
/** Holds text the person may still want: never typed into without their confirmation. */
export const holdsText = (
  state: ComposerState,
): state is Extract<ComposerState, { kind: 'draft' | 'unknown' }> =>
  state.kind === 'draft' || state.kind === 'unknown';
