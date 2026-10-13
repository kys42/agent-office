import type { InputRequest, OfficeEvent, Session } from './types';
import { isOpenRequest } from './notices';
import { m } from './i18n';

/** An open request for input that says what it asks. */
export type AskingEvent = OfficeEvent & { request: InputRequest };

/**
 * What the colleague is asking right now: the newest request for input that is still open and
 * carries its content (a question, a plan, or the call a permission prompt is about).
 */
export function openRequest(s: Pick<Session, 'events'>): AskingEvent | undefined {
  for (let i = s.events.length - 1; i >= 0; i--) {
    const e = s.events[i];
    if (e.request && isOpenRequest(s.events, e)) return e as AskingEvent;
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
 * One line for a bubble: the first question's first line, "Plan approval", or "Allow Bash:
 * <command>". In the display language; the agent's own words are kept as written.
 */
export function requestHeadline(r: InputRequest, limit = 120): string {
  const t = m().prompts.headline;
  if (r.kind === 'question') {
    const q = r.questions[0];
    const more = r.questions.length > 1 ? t.more(r.questions.length - 1) : '';
    return short(first(q?.question ?? ''), limit) + more;
  }
  if (r.kind === 'plan') return t.plan;
  const what = first(r.summary);
  return short(what ? t.permission(r.tool, what) : t.permissionBare(r.tool), limit);
}
