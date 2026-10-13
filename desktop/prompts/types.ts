import type {
  DialogChoice,
  InputRequest,
  PromptSubject,
  QuestionAnswer,
  SessionIdentity,
} from '../../src/shared/types.js';
import type { Screen } from '../composer/screen.js';

/**
 * A dialog the agent draws in its terminal to ask the person something: a question with
 * options, a plan to approve, or a permission prompt. Agents differ in how it is drawn, which
 * keys answer it, how their process and transcript are checked; each agent has an adapter behind
 * this one interface, and the flow around it (the opt-in, identifying the open call, verifying
 * the outcome) exists once, in desktop/answers.ts. The screen is the source of truth: a key is
 * pressed only when the dialog on it is unambiguous.
 */

/**
 * Keys an adapter may press. Hosts translate them (tmux key names, raw bytes for Orca). Never
 * Esc, Tab, digits or control keys: each of those does something else in some dialog (cancel,
 * amend, pick-and-submit), measured on Claude Code 2.1.296 (docs/development/TERMINAL.md).
 */
export type PromptKey = 'Up' | 'Down' | 'Right' | 'Enter' | 'Space';

/** The terminal a dialog is drawn in: tmux or Orca, as an adapter sees it. */
export interface PromptHost {
  readonly kind: 'tmux' | 'orca';
  /** The screen as shown now, or null when it cannot be read. */
  read(): Promise<Screen | null>;
  press(keys: readonly PromptKey[]): Promise<void>;
  /** Puts plain text where the cursor is (a text row of the dialog), without submitting it. */
  type(text: string): Promise<void>;
  wait(ms: number): Promise<void>;
}

/** A tool call the agent made in its current turn that has no result yet. */
export interface OpenCall {
  /** The native call id (Claude `tool_use.id`): what the answer's result will carry. */
  id: string;
  tool: string;
  /** The call's input, as written: kept in memory for one check, never stored. */
  input: Record<string, unknown>;
  /** Where the agent was when it made the call (resolves relative paths a dialog shows). */
  cwd?: string;
}

/**
 * A live session an adapter can answer: its terminal and what the agent's own state says. All
 * of it is re-checked per action; nothing here is cached by the common flow.
 */
export interface PromptTarget {
  host: PromptHost;
  /** Where answers go, as told to the person ("Orca", "tmux work:1.0"). */
  where: string;
  /** The agent's own record says it waits for the person right now. */
  waiting: boolean;
  /** The same process, still waiting, still in front of its terminal: asked before every key. */
  stillThere(): Promise<boolean>;
  /** The open calls of the current turn, from the agent's transcript; null when unreadable. */
  openCalls(): Promise<OpenCall[] | null>;
  /** The transcript holds a result for exactly this call id; null when unreadable. */
  hasResult(callId: string): Promise<boolean | null>;
}

/** One numbered row of a dialog, as drawn. */
export interface DialogRow {
  number: number;
  /** The row's text; a text row shows what was typed there instead of its hint. */
  label: string;
  /** Lines drawn under the row (an option's description, a hint), joined. */
  description: string;
  /** The row's text with the lines under it read as its continuation (a long label wraps). */
  wrapped?: string;
  /** The `❯` marker is on this row. */
  cursor: boolean;
  /** Multi-select rows: `[✔]` drawn. */
  checked?: boolean;
  /** A row that takes typed words ("Type something.", "Tell Claude what to change"). */
  input?: boolean;
  /** Below the dialog's inner rule ("Chat about this"): never an answer. */
  aside?: boolean;
}

export type Dialog =
  | {
      kind: 'question';
      /** The tab bar (several questions, or a multi-select one): each header and whether answered. */
      tabs: { label: string; done: boolean }[];
      question: string;
      multi: boolean;
      rows: DialogRow[];
      /** Multi-select: the unnumbered "Submit" row, and whether the cursor is on it. */
      submit?: { cursor: boolean };
      /** The pane's height, when the host reports it. */
      height?: number;
    }
  | {
      kind: 'review';
      /** No "You have not answered all questions" warning. */
      complete: boolean;
      /** Each question and the answer the dialog will send, as drawn. */
      answers: { question: string; answer: string }[];
      rows: DialogRow[];
    }
  | { kind: 'plan'; plan: string; planFile?: string; rows: DialogRow[] }
  | {
      kind: 'permission';
      /** The heading ("Bash command", "Create file", "Edit file", "Fetch"). */
      title: string;
      /** Lines between the heading and the first fence (a file path, a description, a tip). */
      lines: string[];
      /** The first fenced block (`╌`), wrapped lines rejoined: a command, a diff, a fetch. */
      fence: string | null;
      ask: string;
      rows: DialogRow[];
    };

/**
 * What the terminal shows. `closed`: no dialog (the prompt, output, another view).
 * `unknown`: something dialog-like this adapter does not know; nothing is pressed there.
 */
export type DialogState =
  | Dialog
  | { kind: 'closed' }
  | { kind: 'unknown' }
  | { kind: 'unreadable' }
  | { kind: 'unsupported' };

/** The open call the dialog asks about, with what it asks. */
export interface Asked {
  call: OpenCall;
  /** What the call asks: questions and plans from its input; permission by tool name only. */
  request: InputRequest;
  /** Permission prompts: what the screen says the call does. */
  subject?: PromptSubject;
}

/**
 * Which open call a dialog is about: `one` only when exactly one call equals what the screen
 * shows; `none` when none does; `many` when the screen cannot tell them apart.
 */
export type Identified = { status: 'one'; asked: Asked } | { status: 'none' | 'many' };

/** What the person picked: options of each question, or one of the dialog's own choices. */
export type PromptChoice =
  | { kind: 'question'; answers: QuestionAnswer[] }
  | { kind: 'plan' | 'permission'; number: number; label: string };

/**
 * How answering ended. `submitted`: the final key went in after the dialog was verified to hold
 * exactly the choice. Otherwise nothing more was pressed: `changed` the dialog stopped being
 * this call's, `partial` it was already partly answered there, `ambiguous` the screen could not
 * tell options or questions apart, `unverified` a key did not do what it should, `lost` the
 * agent stopped being the one at the terminal, `bad-choice` the choice is not a one-shot choice
 * on the dialog, `unreadable` the screen could not be read, `unsupported` no adapter answers here.
 */
export type AnswerOutcome =
  | { status: 'submitted' }
  | {
      status: 'refused';
      reason:
        | 'changed'
        | 'partial'
        | 'ambiguous'
        | 'unverified'
        | 'lost'
        | 'bad-choice'
        | 'unreadable'
        | 'unsupported';
      /** Some keys were already pressed (the dialog may show a partial answer). */
      pressed: boolean;
    };

export interface PromptAdapter {
  /** The agent's name as shown to the person ("Claude", "Codex"). A brand, never translated. */
  readonly agent: string;
  /** Request kinds this adapter answers on this host (measured end to end there). */
  answers(host: PromptHost['kind']): ReadonlySet<InputRequest['kind']>;
  /** The live session to answer in, or null (none found, or this agent has none). */
  target(session: SessionIdentity, fresh: boolean): Promise<PromptTarget | null>;
  inspect(host: PromptHost): Promise<DialogState>;
  /** Which of the open calls the dialog is about (exact, see Identified). */
  identify(dialog: Dialog, calls: readonly OpenCall[]): Identified;
  /** Plan approval and permission prompts: the one-shot choices as drawn, for the person. */
  choices(dialog: Dialog): DialogChoice[];
  /** The dialog draws choices that are not offered here (they keep applying, or take words). */
  hasMore(dialog: Dialog): boolean;
  /** Questions: whether typed words can be sent, per question of the request. */
  takesText(dialog: Dialog, request: InputRequest): boolean[];
  /**
   * Presses the keys for `choice`, verifying the screen before and after every key. `proceed` is
   * asked before every key: false (paused, gone, no longer waiting) stops at once.
   */
  answer(
    host: PromptHost,
    asked: Asked,
    choice: PromptChoice,
    proceed: () => Promise<boolean>,
  ): Promise<AnswerOutcome>;
}
