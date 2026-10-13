import { open } from 'node:fs/promises';
import type {
  AnswerChoice,
  AnswerResult,
  OfficeEvent,
  PromptUnavailable,
  PromptView,
} from '../src/shared/types.js';
import type { AskingEvent } from '../src/shared/requests.js';
import { intlLocale, m } from '../src/shared/i18n/index.js';
import {
  defaultTerminalDeps,
  findClaudeProcess,
  hostName,
  ownsTerminal,
  promptHost,
  TerminalInputError,
  type LiveTerminal,
  type TerminalDeps,
} from './terminals.js';
import type { Dialog, DialogState, PromptAdapter, PromptChoice } from './prompts/types.js';

/*
 * Answering a calling session's dialog from the app: the common flow around the per-agent
 * prompt adapters (desktop/prompts/). Desktop-only, like typing into terminals: these never
 * become reachable through OfficeService.call. The opt-in and its native confirmation live in
 * main; everything here assumes the person already agreed and pressed a choice.
 *
 * Order: live record (same pid, still waiting) and terminal foreground → the dialog on screen
 * must ask exactly what the record asked → the adapter presses the fewest keys, re-checking the
 * record and the foreground before every key and the screen after it → the dialog must close
 * and the transcript show the call's result. Anything unexpected stops with nothing more sent.
 */

/** Typed answers for a question's own text row: plain words, at most this long. */
export const MAX_OTHER_LENGTH = 2000;

export interface AnswerDeps extends TerminalDeps {
  /** The end of a transcript (to see the call's result arrive). */
  readTail?: (file: string) => Promise<string>;
}

const unavailable = (agent: string, reason: PromptUnavailable): PromptView => {
  const t = m().prompts.unavailable;
  return {
    status: 'unavailable',
    agent,
    reason,
    message: reason === 'unsupported' ? t.unsupported(agent) : t[reason],
  };
};

/**
 * What the card may offer for the open request: the dialog's choices once the screen shows the
 * same request, else why not. Read-only: no key is pressed.
 */
export async function inspectPrompt(
  adapter: PromptAdapter,
  asking: AskingEvent | undefined,
  live: LiveTerminal | null,
  deps: TerminalDeps = defaultTerminalDeps(),
): Promise<PromptView> {
  if (!asking) return unavailable(adapter.agent, 'no-request');
  if (!live) return unavailable(adapter.agent, 'no-terminal');
  const io = promptHost(live.host, deps);
  if (!adapter.capabilities(io).canAnswer) return unavailable(adapter.agent, 'unsupported');
  if (live.process.status !== 'waiting') return unavailable(adapter.agent, 'not-waiting');
  const state = await adapter.inspect(io);
  if (state.kind === 'unreadable') return unavailable(adapter.agent, 'unreadable');
  if (state.kind === 'unsupported') return unavailable(adapter.agent, 'unsupported');
  if (state.kind === 'closed' || state.kind === 'unknown')
    return unavailable(adapter.agent, 'closed');
  if (!adapter.matches(state, asking.request)) return unavailable(adapter.agent, 'mismatch');
  return {
    status: 'ready',
    agent: adapter.agent,
    kind: asking.request.kind,
    eventId: asking.id,
    choices: adapter.choices(state),
    ...(adapter.takesText(state) ? { other: true } : {}),
  };
}

/** The choice as the renderer sent it, checked against the request; throws on anything else. */
export function readChoice(asking: AskingEvent, value: unknown): PromptChoice {
  const t = m().prompts.result;
  const c = value as AnswerChoice;
  if (!c || typeof c !== 'object' || c.eventId !== asking.id || c.kind !== asking.request.kind)
    throw new TerminalInputError(t.changed);
  if (c.kind === 'question') {
    const request = asking.request;
    if (request.kind !== 'question' || !Array.isArray(c.answers))
      throw new TerminalInputError(t.badChoice);
    if (c.answers.length !== request.questions.length) throw new TerminalInputError(t.badChoice);
    const answers = c.answers.map((a, i) => {
      if (a && typeof a === 'object' && 'other' in a) {
        if (typeof a.other !== 'string') throw new TerminalInputError(t.badChoice);
        const text = a.other.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
        if (!text) throw new TerminalInputError(t.otherEmpty);
        if (text.length > MAX_OTHER_LENGTH)
          throw new TerminalInputError(
            t.otherTooLong(MAX_OTHER_LENGTH.toLocaleString(intlLocale())),
          );
        if (request.questions[i].multiSelect) throw new TerminalInputError(t.badChoice);
        return { other: text };
      }
      const options = (a as { options?: unknown })?.options;
      if (
        !Array.isArray(options) ||
        !options.length ||
        options.some(
          (o) => !Number.isInteger(o) || o < 0 || o >= request.questions[i].options.length,
        ) ||
        (!request.questions[i].multiSelect && options.length !== 1)
      )
        throw new TerminalInputError(t.badChoice);
      return { options: options as number[] };
    });
    return { kind: 'question', answers };
  }
  if (
    !Number.isInteger(c.number) ||
    c.number < 1 ||
    c.number > 20 ||
    typeof c.label !== 'string' ||
    !c.label.trim() ||
    c.label.length > 500
  )
    throw new TerminalInputError(t.badChoice);
  return { kind: c.kind, number: c.number, label: c.label };
}

async function tail(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/** The transcript has the call's result (Claude Code writes it right after the answer). */
async function resultWritten(deps: AnswerDeps, file: string, callId: string) {
  try {
    const text = await (deps.readTail ?? tail)(file);
    return text.includes(`"tool_use_id":"${callId}"`);
  } catch {
    return false;
  }
}

/**
 * Presses the dialog's keys for `value` (the person's choice), after verifying everything the
 * module comment lists. Resolves with what to tell the person; refusals throw a
 * TerminalInputError whose message says what happened (and whether keys were already pressed).
 */
export async function answerRequest(
  adapter: PromptAdapter,
  asking: AskingEvent & Pick<OfficeEvent, 'callId'>,
  live: LiveTerminal,
  value: unknown,
  options: { sourcePath?: string; deps?: AnswerDeps } = {},
): Promise<AnswerResult> {
  const deps = options.deps ?? defaultTerminalDeps();
  const t = m().prompts.result;
  const host = hostName(live.host);
  const where = live.host.kind === 'orca' ? 'Orca' : `tmux ${live.host.label}`;
  const io = promptHost(live.host, deps);
  if (!adapter.capabilities(io).canAnswer)
    throw new TerminalInputError(t.unsupported(adapter.agent));
  const choice = readChoice(asking, value);
  /** The same process, still waiting on this session, and in front of its terminal. */
  const current = async () => {
    const now = await findClaudeProcess(live.process.sessionId, deps, true);
    return (
      now?.pid === live.process.pid &&
      now.status === 'waiting' &&
      (await ownsTerminal(now.pid, deps))
    );
  };
  if (live.process.status !== 'waiting') throw new TerminalInputError(t.notWaiting);
  if (!(await ownsTerminal(live.process.pid, deps))) throw new TerminalInputError(t.notOwner);
  const state = await adapter.inspect(io);
  if (state.kind === 'unreadable') throw new TerminalInputError(t.unreadable(host));
  const isDialog = (s: DialogState): s is Dialog =>
    s.kind === 'question' || s.kind === 'review' || s.kind === 'plan' || s.kind === 'permission';
  if (!isDialog(state) || !adapter.matches(state, asking.request))
    throw new TerminalInputError(t.changed);
  const outcome = await adapter.answer(io, asking.request, choice, current);
  if (outcome.status === 'refused') {
    const after = outcome.pressed ? ` ${t.pressedSome}` : '';
    const message =
      outcome.reason === 'changed'
        ? outcome.pressed
          ? t.stateChanged
          : t.changed
        : outcome.reason === 'lost'
          ? t.notOwner
          : outcome.reason === 'partial'
            ? t.partial
            : outcome.reason === 'bad-choice'
              ? t.badChoice
              : outcome.reason === 'unreadable'
                ? t.unreadable(host)
                : t.notVerified;
    throw new TerminalInputError(message === t.stateChanged ? message : `${message}${after}`);
  }
  // The dialog closes (or moves on to another request), and the transcript records the answer.
  let open = true;
  for (let i = 0; i < 12 && open; i++) {
    await deps.wait(150);
    const now = await adapter.inspect(io);
    open = isDialog(now) && adapter.matches(now, asking.request);
  }
  if (open) throw new TerminalInputError(t.stillOpen);
  let recorded = !asking.callId || !options.sourcePath;
  for (let i = 0; i < 10 && !recorded; i++) {
    recorded = await resultWritten(deps, options.sourcePath!, asking.callId!);
    if (!recorded) await deps.wait(200);
  }
  // An allowed command writes its result only when it ends: a closed prompt is the answer.
  const allowed =
    asking.request.kind === 'permission' &&
    choice.kind === 'permission' &&
    !/^No\b/i.test(choice.label);
  return {
    status: 'answered',
    message: recorded || allowed ? t.answered(where) : t.answeredUnconfirmed(where),
  };
}
