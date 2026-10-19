import type { Activity, Mood, OfficeEvent, Session } from './types.js';
import { getLocale, m, messagesFor, type Locale } from './i18n/index.js';

// Display an excerpt of public messages; never turn tool names into invented task descriptions.
export function messageExcerpt(text: string, limit = 220): string {
  const plain = text
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > limit ? plain.slice(0, limit - 1).trimEnd() + '…' : plain;
}

/**
 * The start of a message for a folded view: about `limit` characters, never cutting through a
 * markdown link (a link cut in half shows its raw markup and loses its target).
 */
export function clipMarkdown(text: string, limit: number, lines = 12): string {
  let end = Math.min(text.length, limit);
  // [label](dest): dest bare (one level of parentheses allowed, "b(1).md") or in <…> (paths
  // with spaces), with an optional "title".
  const LINK =
    /!?\[[^\]\n]*\]\((?:<[^>\n]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+"[^"\n]*")?\)/g;
  for (const m of text.matchAll(LINK)) {
    const start = m.index!;
    if (start >= end) break;
    if (start + m[0].length > end) {
      // The link is short enough to keep whole; a very long one goes to the next fold (unless
      // it is all there is to show).
      end = m[0].length <= 600 || start === 0 ? start + m[0].length : start;
      break;
    }
  }
  const clipped = text.slice(0, end).split('\n').slice(0, lines).join('\n');
  return clipped.length < text.length ? clipped + '…' : clipped;
}

export function summarizeActivity(
  events: OfficeEvent[],
  status: Mood,
  updatedAt: number,
  locale: Locale = getLocale(),
): Activity {
  // A new turn must not inherit an old answer as its current intention.
  const boundary = events.findLastIndex((e) => e.kind === 'user' || e.lifecycle === 'started');
  const current = events.slice(Math.max(0, boundary));
  const assistant = current.findLast((e) => e.kind === 'assistant' && messageExcerpt(e.text));
  const request = current.findLast((e) => e.kind === 'user' && messageExcerpt(e.text));
  const tool = current.findLast((e) => e.kind === 'tool' && e.tool);
  const source = assistant ?? request;
  const t = messagesFor(locale).shared.activity;
  const fallback: Partial<Record<Mood, string>> = t.fallback;
  return {
    text: source ? messageExcerpt(source.text) : (fallback[status] ?? t.noProgress),
    kind: assistant
      ? assistant.phase === 'commentary'
        ? 'progress'
        : assistant.phase === 'final'
          ? 'reply'
          : 'message'
      : request
        ? 'request'
        : 'status',
    at: source?.at ?? updatedAt,
    eventId: source?.id,
    ...(tool ? { tool: { name: tool.tool!, at: tool.at } } : {}),
  };
}

export const sessionActivity = (s: Session): Activity =>
  s.activity ?? summarizeActivity(s.events, s.observedStatus ?? s.status, s.updatedAt);

export function activityLabel(s: Session, now = Date.now()): string {
  const a = sessionActivity(s);
  const t = m().shared.activity.label;
  if (a.kind === 'request') return t.request;
  if (a.kind === 'status') return t.status;
  if (a.kind === 'reply') return t.reply;
  const old = now - a.at > 120_000 || !['work', 'think', 'call'].includes(s.status);
  return a.kind === 'progress' ? (old ? t.lastProgress : t.progress) : t.message;
}

export function toolLabel(name: string): string {
  const short = name.replace(/^.*[._]{2}/, '');
  const t = m().shared.activity.tool;
  if (/^(exec|exec_command|Bash|bash|shell_command|shell)$/i.test(short)) return t.terminal;
  if (/^(apply_patch|Edit|MultiEdit|Write)$/i.test(short)) return t.edit;
  if (/^(Read|read_file|read_files)$/i.test(short)) return t.read;
  if (/^(Grep|Glob|search_files)$/i.test(short)) return t.search;
  if (/^(web|web_search|webfetch|web__run)$/i.test(short)) return t.web;
  if (/request_user_input|AskUserQuestion/i.test(short)) return t.input;
  if (/^ExitPlanMode$/i.test(short)) return t.plan;
  if (/^(wait|write_stdin|sleep)$/i.test(short)) return t.check;
  return short.length > 26 ? short.slice(0, 25) + '…' : short;
}
