import type { Bookmark, BookmarkLine, OfficeEvent, Session } from './types';

/** The copy of the bookmarked message itself. */
export const BOOKMARK_TEXT = 32_000;
/** The copy of the request that led to it. */
export const REQUEST_TEXT = 8_000;
/** Each message on the way. */
export const PROGRESS_TEXT = 2_000;
/** Messages on the way kept: the first and the last ones of the stretch. */
export const PROGRESS_HEAD = 4;
export const PROGRESS_TAIL = 8;
export const BOOKMARK_NOTE = 1_000;
export const BOOKMARK_PAGE = 50;
/** A bookmark being opened: its colleague's conversation at its message (`key` per opening). */
export interface BookmarkFocus {
  sessionId: string;
  eventId: string;
  at: number;
  key: number;
}
export const BOOKMARK_PAGE_MAX = 200;

/** `text` cut to `max` characters, never inside a surrogate pair. */
function clip(text: string, max: number): { text: string; truncated?: boolean } {
  if (text.length <= max) return { text };
  const end = /[\ud800-\udbff]/.test(text[max - 1]) ? max - 1 : max;
  return { text: text.slice(0, end), truncated: true };
}
export function bookmarkLine(e: OfficeEvent, max: number): BookmarkLine {
  return {
    eventId: e.id,
    kind: e.kind,
    ...(e.phase ? { phase: e.phase } : {}),
    at: e.at,
    ...clip(e.text, max),
    ...(e.excerpt ? { excerpt: true } : {}),
  };
}
/** Another form of the same message, as the conversation folds it (`conversationEvents`). */
const twin = (e: OfficeEvent, target: OfficeEvent) =>
  (e.kind === 'user' || e.kind === 'assistant') &&
  e.kind === target.kind &&
  e.phase === target.phase &&
  e.text === target.text &&
  Math.abs(e.at - target.at) < 3000;
/**
 * How `target` came about, from the conversation events before index `end` (where it is, or
 * would be): the person's last request before it and the colleague's messages since, tool calls
 * only counted. A request itself has none. Another form of the same message is not context.
 */
export function bookmarkContext(
  conversation: OfficeEvent[],
  end: number,
  target: OfficeEvent,
): Bookmark['context'] {
  const context: Bookmark['context'] = { progress: [], omitted: 0, tools: 0 };
  if (target.kind === 'user') return context;
  const said: OfficeEvent[] = [];
  for (let i = end - 1; i >= 0; i--) {
    const e = conversation[i];
    if (twin(e, target)) continue;
    if (e.kind === 'user') {
      context.request = bookmarkLine(e, REQUEST_TEXT);
      break;
    }
    if (e.kind === 'assistant') said.push(e);
    else if (e.kind === 'tool' || e.kind === 'result') context.tools++;
  }
  said.reverse();
  const kept =
    said.length > PROGRESS_HEAD + PROGRESS_TAIL
      ? [...said.slice(0, PROGRESS_HEAD), ...said.slice(-PROGRESS_TAIL)]
      : said;
  context.omitted = said.length - kept.length;
  context.progress = kept.map((e) => bookmarkLine(e, PROGRESS_TEXT));
  return context;
}
/**
 * A bookmark of `eventId` in `session`, read from `conversation` (the session's events with the
 * retained notice excerpts, as the conversation tab shows them). Null when there is no such
 * message to keep (unknown, or a lifecycle marker).
 */
export function makeBookmark(
  session: Session,
  conversation: OfficeEvent[],
  eventId: string,
  id: string,
  now: number,
  note = '',
): Bookmark | null {
  let index = conversation.findIndex((e) => e.id === eventId);
  // A duplicate form the conversation folds away is still the same moment of it.
  const event = conversation[index] ?? session.events.find((e) => e.id === eventId);
  if (!event || event.kind === 'lifecycle' || !event.text.trim()) return null;
  if (index < 0) {
    index = conversation.findIndex((e) => e.at > event.at);
    if (index < 0) index = conversation.length;
  }
  return {
    id,
    sessionId: session.id,
    ...bookmarkLine(event, BOOKMARK_TEXT),
    createdAt: now,
    note: note.slice(0, BOOKMARK_NOTE),
    source: {
      provider: session.provider,
      title: session.title,
      alias: session.alias,
      project: session.project,
      ...(session.agentName ? { agentName: session.agentName } : {}),
      branch: session.branch,
      cwd: session.cwd,
    },
    context: bookmarkContext(conversation, index, event),
    anchor: {
      nativeId: session.nativeId,
      ...(session.sessionKey ? { sessionKey: session.sessionKey } : {}),
      sourcePath: session.sourcePath,
      sourceRef: event.sourceRef,
      ...(event.legacyId ? { legacyId: event.legacyId } : {}),
      index,
    },
  };
}
/** Whether every one of `words` (case aside) appears in what the bookmark kept or whose it was. */
export function bookmarkMatches(b: Bookmark, words: string): boolean {
  const terms = words.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const kept = [
    b.text,
    b.note,
    b.context.request?.text ?? '',
    b.source.title,
    b.source.alias,
    b.source.project,
    b.source.agentName ?? '',
  ]
    .join('\n')
    .toLowerCase();
  return terms.every((t) => kept.includes(t));
}
/** Bookmark list order: newest bookmarked first, then by id. */
export const bookmarkOrder = (a: Bookmark, b: Bookmark) =>
  b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
