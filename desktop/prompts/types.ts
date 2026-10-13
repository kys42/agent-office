import type { DialogChoice, InputRequest, QuestionAnswer } from '../../src/shared/types.js';
import type { Screen } from '../composer/screen.js';

/**
 * A dialog the agent draws in its terminal to ask the person something: a question with
 * options, a plan to approve, or a permission prompt. Agents differ in how it is drawn and which
 * keys answer it, so each agent has an adapter behind this one interface; the flow around it
 * (the opt-in, the live record, terminal ownership, matching the recorded request, verifying the
 * outcome) exists once, in desktop/answers.ts.
 */

/**
 * Keys an adapter may press. Hosts translate them (tmux key names, raw bytes for Orca). Never
 * Esc, Tab, digits or control keys: each of those does something else in some dialog (cancel,
 * amend, pick-and-submit), measured on Claude Code 2.1.296 (docs/development/TERMINAL.md).
 */
export type PromptKey = 'Up' | 'Down' | 'Right' | 'Enter' | 'Space';

/** The terminal a dialog is drawn in: tmux or Orca, as an adapter sees it. */
export interface PromptHost {
  readonly styled: boolean;
  /** The screen as shown now, or null when it cannot be read. */
  read(): Promise<Screen | null>;
  press(keys: readonly PromptKey[]): Promise<void>;
  /** Puts plain text where the cursor is (a text row of the dialog), without submitting it. */
  type(text: string): Promise<void>;
  wait(ms: number): Promise<void>;
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
  | { kind: 'permission'; title: string; body: string; ask: string; rows: DialogRow[] };

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

/** What the person picked: options of each question, or one of the dialog's own choices. */
export type PromptChoice =
  | { kind: 'question'; answers: QuestionAnswer[] }
  | { kind: 'plan' | 'permission'; number: number; label: string };

/**
 * How answering ended. `submitted`: the final key went in after the dialog was verified to hold
 * exactly the choice. Otherwise nothing more was pressed: `changed` the dialog stopped matching
 * the request, `partial` it was already partly answered there, `unverified` a key did not do
 * what it should, `lost` Claude stopped being the one at the terminal, `bad-choice` the choice is
 * not on the dialog, `unreadable` the screen could not be read.
 */
export type AnswerOutcome =
  | { status: 'submitted' }
  | {
      status: 'refused';
      reason: 'changed' | 'partial' | 'unverified' | 'lost' | 'bad-choice' | 'unreadable';
      /** Some keys were already pressed (the dialog may show a partial answer). */
      pressed: boolean;
    };

export interface PromptCapabilities {
  /** The adapter can read this agent's dialogs and answer them by keys on this host. */
  canAnswer: boolean;
}

export interface PromptAdapter {
  /** The agent's name as shown to the person ("Claude", "Codex"). A brand, never translated. */
  readonly agent: string;
  capabilities(host: Pick<PromptHost, 'styled'> | null): PromptCapabilities;
  inspect(host: PromptHost): Promise<DialogState>;
  /** The dialog asks exactly what `request` recorded: same kind and the same words. */
  matches(dialog: Dialog, request: InputRequest): boolean;
  /** Plan approval and permission prompts: the choices as drawn, for the person to pick from. */
  choices(dialog: Dialog): DialogChoice[];
  /** Questions: the dialog offers a row for typed words (single-select questions only). */
  takesText(dialog: Dialog): boolean;
  /**
   * Presses the keys for `choice`, verifying the screen after every step. `proceed` is asked
   * before every key: false (Claude paused, gone, no longer waiting) stops at once.
   */
  answer(
    host: PromptHost,
    request: InputRequest,
    choice: PromptChoice,
    proceed: () => Promise<boolean>,
  ): Promise<AnswerOutcome>;
}
