import type {
  AnswerChoice,
  AnswerResult,
  AnswerSetting,
  PromptSubject,
  PromptUnavailable,
  PromptView,
} from '../src/shared/types.js';
import type { AskingEvent } from '../src/shared/requests.js';
import { getLocale, intlLocale, m } from '../src/shared/i18n/index.js';
import { redactStrict } from '../server/adapters/normalize.js';
import { TerminalInputError } from './terminals.js';
import type {
  Dialog,
  DialogState,
  Identified,
  PromptAdapter,
  PromptChoice,
  PromptHost,
  PromptTarget,
} from './prompts/types.js';

/*
 * Answering a calling session's dialog from the app: the common flow around the per-agent
 * prompt adapters (desktop/prompts/). Desktop-only, like typing into terminals: never reachable
 * through OfficeService.call. The opt-in and its native confirmation live in main; everything
 * here assumes the person agreed and pressed a choice. Nothing here knows an agent: the adapter
 * finds the session (`target`), reads its dialogs and presses their keys.
 *
 * The screen is the source of truth. Order: the agent's record says it waits and it is in front
 * of its terminal → the dialog on screen is about exactly one open call of the current turn,
 * the very call the card showed → the adapter presses the fewest keys, re-checking the record
 * before every key and the screen before and after it → the dialog must go and the transcript
 * must show that call's result. Anything unclear stops with nothing more sent.
 */

/** A stored setting: `on`/`off`, or the booleans pre-release builds wrote; else never asked. */
export const decodeSetting = (value: unknown): AnswerSetting =>
  value === 'on' || value === true ? 'on' : value === 'off' || value === false ? 'off' : 'unset';

/** Typed answers for a question's own text row: plain words, at most this long. */
export const MAX_OTHER_LENGTH = 2000;

const isDialog = (s: DialogState): s is Dialog =>
  s.kind === 'question' || s.kind === 'review' || s.kind === 'plan' || s.kind === 'permission';

const unavailable = (agent: string, reason: PromptUnavailable): PromptView => {
  const t = m().prompts.unavailable;
  return {
    status: 'unavailable',
    agent,
    reason,
    message: reason === 'unsupported' ? t.unsupported(agent) : t[reason],
  };
};

/** The screen, read again while it cannot be read (a host busy redrawing). */
async function look(adapter: PromptAdapter, host: PromptHost): Promise<DialogState> {
  let state = await adapter.inspect(host);
  for (let i = 0; i < 3 && state.kind === 'unreadable'; i++) {
    await host.wait(150);
    state = await adapter.inspect(host);
  }
  return state;
}

/**
 * The open call the screen is about, when it is the one `asking` stands for. Questions and plans
 * carry their call in the record. A permission prompt is about whichever open call of the
 * current turn the screen shows (Claude Code asks for the first of several, while the record
 * marks the last): exactly one must match, and an answer must name that very call (`callId`,
 * as the card was shown it).
 */
function sameCall(found: Identified, asking: AskingEvent, callId?: string) {
  if (found.status !== 'one' || found.asked.request.kind !== asking.request.kind) return null;
  const id = found.asked.call.id;
  if (asking.request.kind !== 'permission' && id !== asking.callId) return null;
  if (callId !== undefined && id !== callId) return null;
  return found.asked;
}

/** Why a request can never be checked against a screen (cut at rest, or no call id). */
const uncheckable = (asking: AskingEvent) =>
  asking.request.kind !== 'permission' && (!asking.callId || !!asking.request.truncated);

/** What the card may show of a screen: the same, with secrets hidden (matching keeps the raw). */
function shown(subject: PromptSubject): PromptSubject {
  const hide = (text: string) => redactStrict(text, Infinity, getLocale());
  return {
    title: subject.title,
    ...(subject.command !== undefined ? { command: hide(subject.command) } : {}),
    ...(subject.path !== undefined ? { path: hide(subject.path) } : {}),
    ...(subject.url !== undefined ? { url: hide(subject.url) } : {}),
  };
}

/**
 * What the card may offer for the open request: the dialog's one-shot choices once the screen
 * shows exactly that call, else why not. Read-only: no key is pressed.
 */
export async function inspectPrompt(
  adapter: PromptAdapter,
  asking: AskingEvent | undefined,
  target: PromptTarget | null,
  setting: AnswerSetting,
): Promise<PromptView> {
  const no = (reason: PromptUnavailable) => unavailable(adapter.agent, reason);
  if (!asking) return no('no-request');
  if (!adapter.answers('tmux').size && !adapter.answers('orca').size) return no('unsupported');
  if (setting === 'off') return no('off');
  if (uncheckable(asking)) return no('unverifiable');
  if (!target) return no('no-terminal');
  if (!adapter.answers(target.host.kind).has(asking.request.kind)) return no('unsupported');
  if (!target.waiting) return no('not-waiting');
  const state = await look(adapter, target.host);
  if (state.kind === 'unreadable') return no('unreadable');
  if (state.kind === 'unsupported') return no('unsupported');
  if (!isDialog(state)) return no('closed');
  const calls = await target.openCalls();
  if (!calls) return no('unverifiable');
  const asked = sameCall(adapter.identify(state, calls), asking);
  if (!asked) return no('mismatch');
  return {
    status: 'ready',
    agent: adapter.agent,
    kind: asking.request.kind,
    eventId: asking.id,
    callId: asked.call.id,
    choices: adapter.choices(state),
    ...(adapter.hasMore(state) ? { more: true } : {}),
    ...(asked.request.kind === 'question'
      ? { other: adapter.takesText(state, asked.request) }
      : {}),
    ...(asked.subject ? { subject: shown(asked.subject) } : {}),
  };
}

/** The choice as the renderer sent it, checked against the request; throws on anything else. */
export function readChoice(asking: AskingEvent, value: unknown): PromptChoice {
  const t = m().prompts.result;
  const c = value as AnswerChoice;
  if (
    !c ||
    typeof c !== 'object' ||
    c.eventId !== asking.id ||
    c.kind !== asking.request.kind ||
    typeof c.callId !== 'string' ||
    !c.callId
  )
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

/**
 * Presses the dialog's keys for `value` (the person's choice), after verifying everything the
 * module comment lists. Resolves with what to tell the person; refusals throw a
 * TerminalInputError whose message says what happened (and whether keys were already pressed).
 */
export async function answerRequest(
  adapter: PromptAdapter,
  asking: AskingEvent,
  target: PromptTarget,
  value: unknown,
): Promise<AnswerResult> {
  const t = m().prompts.result;
  const where = target.where;
  const choice = readChoice(asking, value);
  if (!adapter.answers(target.host.kind).has(asking.request.kind))
    throw new TerminalInputError(t.unsupported(adapter.agent));
  if (uncheckable(asking)) throw new TerminalInputError(t.unverifiable);
  if (!target.waiting) throw new TerminalInputError(t.notWaiting);
  if (!(await target.stillThere())) throw new TerminalInputError(t.notOwner);
  const state = await look(adapter, target.host);
  if (state.kind === 'unreadable') throw new TerminalInputError(t.unreadable(where));
  const calls = isDialog(state) ? await target.openCalls() : null;
  const asked =
    isDialog(state) && calls
      ? sameCall(adapter.identify(state, calls), asking, (value as AnswerChoice).callId)
      : null;
  if (!asked) throw new TerminalInputError(t.changed);
  const outcome = await adapter.answer(target.host, asked, choice, () => target.stillThere());
  if (outcome.status === 'refused') {
    const reasons: Record<typeof outcome.reason, string> = {
      changed: outcome.pressed ? t.stateChanged : t.changed,
      lost: t.notOwner,
      partial: t.partial,
      ambiguous: t.ambiguous,
      'bad-choice': t.badChoice,
      unreadable: t.unreadable(where),
      unverified: t.notVerified,
      unsupported: t.unsupported(adapter.agent),
    };
    const message = reasons[outcome.reason];
    throw new TerminalInputError(
      outcome.pressed && message !== t.stateChanged ? `${message} ${t.pressedSome}` : message,
    );
  }
  // The dialog must go. A screen that cannot be read is not a closed dialog: read again.
  let seen = false;
  let open = true;
  for (let i = 0; i < 12 && (open || !seen); i++) {
    await target.host.wait(150);
    const now = await adapter.inspect(target.host);
    if (now.kind === 'unreadable') continue;
    seen = true;
    open = isDialog(now) && adapter.identify(now, [asked.call]).status === 'one';
  }
  if (!seen) return { status: 'answered', message: t.unconfirmedScreen(where) };
  if (open) throw new TerminalInputError(t.stillOpen);
  // And the transcript must hold that call's result. An allowed command writes it when it ends.
  let recorded: boolean | null = false;
  for (let i = 0; i < 15 && recorded === false; i++) {
    recorded = await target.hasResult(asked.call.id);
    if (recorded === false) await target.host.wait(200);
  }
  return {
    status: 'answered',
    message: recorded ? t.answered(where) : t.answeredUnconfirmed(where),
  };
}
