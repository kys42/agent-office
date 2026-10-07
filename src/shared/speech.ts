import type { OfficeEvent, OfficeNotice, Session } from './types';
import { bubbleNotice, isFinalNotice, noticeLabel, unreadNoticeCount } from './notices';
import { activityLabel, sessionActivity } from './activity';

const LIVE = ['work', 'think', 'call', 'error'];
/**
 * What kind of thing a bubble is saying — each kind gets its own bubble shape:
 * mine (the person's own request), thought (thinking), progress (work notes), reply (final
 * answer), attention (needs input), error, message (anything else).
 */
export type BubbleTone =
  'mine' | 'thought' | 'progress' | 'reply' | 'attention' | 'error' | 'message';
export const TONE_LABELS: Record<BubbleTone, string> = {
  mine: '내 요청',
  thought: '생각 중',
  progress: '진행 중',
  reply: '최종 응답',
  attention: '응답 필요',
  error: '확인 필요',
  message: '응답',
};

/** How long a just-sent request plays its arrival (papers landing, envelope). */
export const ARRIVAL_MS = 15_000;

/**
 * The request that just landed on a desk, if any: the newest non-history, not-closed request
 * received within ARRIVAL_MS. Pure — no "already seen" memory — so every view, a hidden
 * window or a re-render all agree.
 */
export function freshRequest(news: OfficeNotice[], now = Date.now()) {
  return news
    .filter(
      (n) =>
        n.kind === 'request' &&
        !n.bootstrap &&
        !n.dismissedAt &&
        now - n.receivedAt < ARRIVAL_MS &&
        n.receivedAt - now < ARRIVAL_MS,
    )
    .sort((a, b) => b.receivedAt - a.receivedAt)[0];
}

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
  const b = bubble;
  // A colleague waiting for the person speaks as a call, whatever its last note was.
  const tone: BubbleTone = b
    ? b.kind === 'request'
      ? 'mine'
      : s.status === 'call'
        ? 'attention'
        : b.kind === 'attention' || b.kind === 'error'
          ? b.kind
          : b.kind === 'progress'
            ? s.status === 'think'
              ? 'thought'
              : 'progress'
            : b.kind === 'reply' && isFinalNotice(b)
              ? 'reply'
              : 'message'
    : s.status === 'call'
      ? 'attention'
      : s.status === 'error'
        ? 'error'
        : activity.kind === 'request'
          ? 'mine'
          : s.status === 'think'
            ? 'thought'
            : activity.kind === 'progress' || s.status === 'work'
              ? 'progress'
              : activity.kind === 'reply'
                ? 'reply'
                : 'message';
  return {
    members,
    news,
    bubble,
    /** A request that just arrived (plays the arrival on the desk). */
    arrival: freshRequest(news, now),
    tone,
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

/**
 * What a desk says right now: a just-arrived request speaks first — the person's own words —
 * then the desk's usual bubble. Every desk view (big office, row, floor) uses this.
 */
export function deskSpeech(s: Session, notices: OfficeNotice[], bubbleHours = 3, now = Date.now()) {
  const usual = stationSpeech(s, notices, bubbleHours, now);
  return usual.arrival ? stationSpeech(s, notices, bubbleHours, now, usual.arrival) : usual;
}
