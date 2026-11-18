import { m } from '../src/shared/i18n/index.js';
import {
  checkSessionTitle,
  renameWhen,
  titleProblemMessage,
  type SessionRenameCommand,
} from '../src/shared/session-rename.js';
import type { SendResult } from '../src/shared/types.js';
import type { ComposerAdapter } from './composer/index.js';
import {
  acceptsInput,
  hostName,
  TerminalInputError,
  type LiveTerminal,
  type TerminalSendOptions,
} from './terminals.js';

/** What renaming needs from main: all of it injected, so tests never reach a terminal. */
export interface SessionRenameDeps {
  /** The agent's composer adapter: whether a line is typed into its terminal at all. */
  composer: ComposerAdapter;
  /** The agent's rename command (src/shared/session-rename.ts), or null when it has none. */
  command: SessionRenameCommand | null;
  /** Its live terminal, looked up afresh; null when none was verified. */
  live(): Promise<LiveTerminal | null>;
  /** Why no terminal was found, when the agent's records can tell. */
  noTerminal(): Promise<string>;
  /** The follow-up send (`sendToTerminal`): every check it makes applies here too. */
  send(live: LiveTerminal, line: string, options: TerminalSendOptions): Promise<SendResult>;
}

/**
 * Types the agent's rename command into its live terminal as one line, then Enter: one send of
 * the ordinary follow-up path. The title is checked first (one line, no control characters, no
 * picker trigger, at most `SESSION_TITLE_MAX`). Refused before anything is typed when the agent has
 * no command, its follow-ups are not typed (a queue), no terminal is verified, or the agent does
 * not take the command in its state. Text already in its input box is never cleared for this: no
 * clipboard backup is given, so the send refuses a draft instead of asking to replace it.
 */
export async function renameSession(title: unknown, deps: SessionRenameDeps): Promise<SendResult> {
  const t = m().inspector.sessionTitle;
  const checked = checkSessionTitle(title);
  if (!checked.ok) throw new TerminalInputError(titleProblemMessage(checked.problem));
  const { composer, command } = deps;
  if (!command) throw new TerminalInputError(t.blocks.unsupported);
  if (composer.capabilities(null).delivery !== 'terminal')
    throw new TerminalInputError(t.notTyped(composer.agent));
  const live = await deps.live();
  if (!live) throw new TerminalInputError(await deps.noTerminal());
  const block = renameWhen(command, live.process.status, acceptsInput(live.process.status));
  if (block === 'busy') throw new TerminalInputError(t.blocks.busy);
  if (block) throw new TerminalInputError(m().desktop.terminal.notReady);
  try {
    return await deps.send(live, command.line(checked.title), { composer });
  } catch (error) {
    if (error instanceof TerminalInputError) throw error;
    // The line may already be in the terminal: never invite a blind resend.
    throw new TerminalInputError(m().desktop.terminal.unconfirmed(hostName(live.host)));
  }
}
