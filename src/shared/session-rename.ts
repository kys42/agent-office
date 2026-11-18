import { m } from './i18n';
import type { Provider, TerminalTarget } from './types';

/**
 * Renaming the agent's own conversation (#384): the agent's rename command is typed into its
 * live session as one line, through the same terminal send as a follow-up (desktop/terminals.ts,
 * with all of its checks). The agent then writes the new title itself (Claude: a `custom-title`
 * record; Codex: its thread name) and the office picks it up like any other title. Nothing here
 * writes the agent's files or runs anything else.
 */

/** The longest title typed, in UTF-16 units like an input's `maxLength` (a Korean syllable is 1). */
export const SESSION_TITLE_MAX = 100;

/**
 * Why a title is refused rather than cleaned (the person sees exactly what goes in):
 * - `empty`: nothing left once trimmed.
 * - `tooLong`: over `SESSION_TITLE_MAX`.
 * - `control`: control characters and line breaks would type keystrokes of their own (Enter
 *   submitting half a title, Esc closing the box); bidirectional controls draw the title
 *   differently from what is typed, so the screen check could not match it either.
 * - `picker`: a word starting with `/` or `@` opens the agent's command or file list, where Enter
 *   picks an entry instead of submitting the line.
 * - `backslash`: a trailing `\` turns the Enter after it into a line break (Claude Code).
 */
export type TitleProblem = 'empty' | 'tooLong' | 'control' | 'picker' | 'backslash';

// C0, DEL, C1, line and paragraph separators, and bidirectional marks, embeddings and isolates.
const CONTROL =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const PICKER = /(?:^|\s)[/@]/;

export function checkSessionTitle(
  raw: unknown,
): { ok: true; title: string } | { ok: false; problem: TitleProblem } {
  if (typeof raw !== 'string') return { ok: false, problem: 'empty' };
  // Checked before trimming: a line break at either end is still a keystroke someone pasted.
  if (CONTROL.test(raw)) return { ok: false, problem: 'control' };
  const title = raw.trim();
  if (!title) return { ok: false, problem: 'empty' };
  if (title.length > SESSION_TITLE_MAX) return { ok: false, problem: 'tooLong' };
  if (PICKER.test(title)) return { ok: false, problem: 'picker' };
  if (title.endsWith('\\')) return { ok: false, problem: 'backslash' };
  return { ok: true, title };
}

/** What the person is told about a refused title, in the active language. */
export function titleProblemMessage(problem: TitleProblem): string {
  const problems = m().inspector.sessionTitle.problems;
  return problem === 'tooLong' ? problems.tooLong(SESSION_TITLE_MAX) : problems[problem];
}

/** Each agent's own rename command: what is typed, and when the agent takes it. */
export interface SessionRenameCommand {
  /** The one line typed, Enter not included. `title` passed `checkSessionTitle`. */
  line(title: string): string;
  /**
   * Taken while the agent works. Claude Code runs `/rename` at once even mid-turn (an
   * `immediate` command: never queued behind the turn). Otherwise only while it waits for input.
   */
  whileBusy: boolean;
}

/**
 * The agents' rename commands. The differences between agents stay here; callers only look one
 * up. Claude Code 2.1.327: `/rename [name]` (alias `/name`), immediate. Codex 0.166: `/rename`
 * with the name inline; whether it runs during a turn is unverified, so only at rest. OpenClaw
 * has no terminal command.
 *
 * Typing it also needs a composer the app types into (desktop/composer): a Codex CLI follow-up
 * goes through `codex queue`, which starts a model turn on the server, and the TUI's slash
 * commands never see it. Such a send is refused (`notTyped`), never queued as a prompt.
 */
export const SESSION_RENAME: Record<Provider, SessionRenameCommand | null> = {
  claude: { line: (title) => `/rename ${title}`, whileBusy: true },
  codex: { line: (title) => `/rename ${title}`, whileBusy: false },
  openclaw: null,
};

export const sessionRenameFor = (provider: Provider): SessionRenameCommand | null =>
  SESSION_RENAME[provider] ?? null;

/**
 * Why the rename cannot be sent now, in the order the person can act on:
 * - `unsupported`: the agent has no rename command.
 * - `off`: the desktop setting for typing into terminals is off.
 * - `privacy`: the screen is hidden (the form shows the current title).
 * - `noTerminal`: no live agent process vouches for a terminal (or only its Orca tab was found).
 * - `notTyped`: its follow-ups go to a queue or an app, not typed into a terminal.
 * - `notReady`: the agent does not take input right now (a dialog, a menu, shell mode).
 * - `busy`: it is working and takes this command only at rest.
 */
export type RenameBlock =
  'unsupported' | 'off' | 'privacy' | 'noTerminal' | 'notTyped' | 'notReady' | 'busy';

/** Whether the agent takes the command in its process state (`open`: it takes input at all). */
export function renameWhen(
  command: SessionRenameCommand,
  status: string,
  open: boolean,
): 'notReady' | 'busy' | null {
  if (!open) return 'notReady';
  if (status === 'busy' && !command.whileBusy) return 'busy';
  return null;
}

/** The card menu's view: the send target the card already looked up (`null`: none found). */
export function renameBlock(options: {
  command: SessionRenameCommand | null;
  target: TerminalTarget | null;
  sendOn: boolean;
  privacy: boolean;
}): RenameBlock | null {
  const { command, target } = options;
  if (!command) return 'unsupported';
  if (!options.sendOn) return 'off';
  if (options.privacy) return 'privacy';
  if (!target || target.tabOnly) return 'noTerminal';
  if (target.kind === 'codex' || target.queues || target.desktop) return 'notTyped';
  return renameWhen(command, target.status, target.canSend);
}
