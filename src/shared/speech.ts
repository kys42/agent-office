import type { OfficeEvent, OfficeNotice, Session } from './types';
import { bubbleNotice, noticeLabel, unreadNoticeCount } from './notices';
import { activityLabel, sessionActivity } from './activity';

const LIVE = ['work', 'think', 'call', 'error'];
/** Bubbles render this much of the original message (code blocks dropped). */
const MARKDOWN_LIMIT = 1500;

/**
 * The compact snapshot keeps the last few events plus the message the desk is speaking, so
 * a bubble can show the original wording and style instead of the stored plain excerpt.
 */
export function snapshotEvents(s: Session, recent = 4): OfficeEvent[] {
  const tail = s.events.slice(-recent);
  const id = s.activity?.eventId;
  const spoken =
    id && !tail.some((e) => e.id === id) ? s.events.find((e) => e.id === id) : undefined;
  return spoken ? [spoken, ...tail] : tail;
}

/** The original public message for a bubble, when the desk still has it. */
function sourceMarkdown(s: Session, eventId: string | undefined) {
  const text = eventId ? s.events.find((e) => e.id === eventId)?.text : undefined;
  if (!text) return null;
  const clean = text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .trim()
    .slice(0, MARKDOWN_LIMIT);
  return clean || null;
}

/**
 * What a desk says: the current notice bubble if there is one, otherwise the public progress
 * excerpt. Shared by the big office and the desk row so both speak the same words.
 */
export function stationSpeech(
  s: Session,
  notices: OfficeNotice[],
  bubbleHours = 3,
  now = Date.now(),
  /** Speak this notice instead of the desk's current bubble (e.g. what woke the pet). */
  focus?: OfficeNotice,
) {
  const members = s.resident?.sessionIds ?? [s.id];
  const news = notices.filter((n) => members.includes(n.sessionId));
  const bubble = focus ?? bubbleNotice(news, bubbleHours, now);
  const activity = sessionActivity(s);
  // Questions/errors speak a fixed sentence; public messages can show their own words.
  const markdown = bubble
    ? ['attention', 'error'].includes(bubble.kind)
      ? null
      : sourceMarkdown(s, bubble.eventId)
    : activity.kind === 'status'
      ? null
      : sourceMarkdown(s, activity.eventId);
  return {
    members,
    news,
    bubble,
    activity,
    unread: unreadNoticeCount(news),
    text: bubble?.text ?? activity.text,
    /** Original markdown of the spoken message, or null to fall back to the plain `text`. */
    markdown,
    label: bubble ? noticeLabel(bubble) : activityLabel(s),
    /**
     * A notice bubble always shows. Without any news, live progress shows while the colleague
     * is busy or calling, or when the person reveals it (hover / selection).
     */
    shows: (revealed: boolean) =>
      !!bubble || (!news.length && (revealed || LIVE.includes(s.status))),
  };
}
export type StationSpeech = ReturnType<typeof stationSpeech>;
