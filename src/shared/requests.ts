import type { InputRequest, OfficeEvent, Session } from './types';
import { isOpenRequest } from './notices';
import { m } from './i18n';

/** An open request for input that says what it asks. */
export type AskingEvent = OfficeEvent & { request: InputRequest };

/** Tools that ask by their own input (questions, plans): never a permission prompt. */
const ASKING_TOOL = /AskUserQuestion|request_user_input|ExitPlanMode/;

/**
 * What the colleague is asking right now: the newest request for input that is still open —
 * a question or plan with its recorded content, or any other call the live record says waits
 * for permission (only its tool's name: what it would run is read from the screen, never stored).
 */
export function openRequest(s: Pick<Session, 'events'>): AskingEvent | undefined {
  for (let i = s.events.length - 1; i >= 0; i--) {
    const e = s.events[i];
    if (e.kind !== 'tool' || e.intent !== 'request-input' || !isOpenRequest(s.events, e)) continue;
    if (e.request) return e as AskingEvent;
    if (e.tool && !ASKING_TOOL.test(e.tool))
      return { ...e, request: { kind: 'permission', tool: e.tool } };
  }
  return undefined;
}

const first = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? '';
const short = (text: string, limit: number) =>
  text.length > limit ? text.slice(0, limit - 1).trimEnd() + '…' : text;

/**
 * One line for a bubble: the first question's first line, "Plan approval", or "Allow Bash?".
 * In the display language; the agent's own words are kept as written.
 */
export function requestHeadline(r: InputRequest, limit = 120): string {
  const t = m().prompts.headline;
  if (r.kind === 'question') {
    const q = r.questions[0];
    const more = r.questions.length > 1 ? t.more(r.questions.length - 1) : '';
    return short(first(q?.question ?? ''), limit) + more;
  }
  if (r.kind === 'plan') return t.plan;
  return short(t.permission(r.tool), limit);
}
