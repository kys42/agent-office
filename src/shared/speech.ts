import type { OfficeEvent, OfficeNotice, Session } from './types';
import { bubbleNotice, isFinalNotice, noticeLabel, unreadNoticeCount } from './notices';
import { activityLabel, messageExcerpt, sessionActivity } from './activity';
import { isBackground, isHelper } from './residents';
import { liveLabels } from './labels';
import { m } from './i18n';

const LIVE = ['work', 'think', 'call', 'error'];
/**
 * What kind of thing a bubble is saying — each kind gets its own bubble shape:
 * mine (the person's own request), thought (thinking), progress (work notes), reply (final
 * answer), attention (needs input), error, message (anything else).
 */
export type BubbleTone =
  'mine' | 'thought' | 'progress' | 'reply' | 'attention' | 'error' | 'message';
export const TONE_LABELS: Record<BubbleTone, string> = liveLabels((t) => t.shared.tone);

/** How long a just-sent request plays its arrival (papers landing, envelope). */
export const ARRIVAL_MS = 15_000;

/** Collection may trail the request itself (scan interval, a busy collector) by this much. */
export const ARRIVAL_LAG_MS = 60_000;

/**
 * The request that just landed on a desk, if any: the newest of the person's own requests
 * (not history, not a background run, not closed) that the office received within ARRIVAL_MS
 * and that was itself sent recently — so requests collected late (after a restart or a paused
 * collector) never replay as new. Pure — no "already seen" memory — so every view, a hidden
 * window or a re-render all agree.
 */
export function freshRequest(news: OfficeNotice[], now = Date.now()) {
  const latest = news
    .filter(
      (n) =>
        n.kind === 'request' &&
        !n.bootstrap &&
        !n.background &&
        Math.abs(now - n.receivedAt) < ARRIVAL_MS &&
        now - n.at < ARRIVAL_MS + ARRIVAL_LAG_MS,
    )
    .sort((a, b) => b.receivedAt - a.receivedAt)[0];
  // Closing the newest one ends the arrival; it never brings back an earlier request.
  return latest?.dismissedAt ? undefined : latest;
}

/** When the current arrivals end (re-render then so every view drops them together). */
export const arrivalEnds = (notices: OfficeNotice[], now = Date.now()) =>
  notices
    .filter((n) => n.kind === 'request' && !n.bootstrap && n.receivedAt + ARRIVAL_MS > now)
    .map((n) => n.receivedAt + ARRIVAL_MS);

/** The person's request quoted above a bubble (from a request notice or a retained event). */
export interface QuotedRequest {
  id: string;
  eventId: string;
  at: number;
  text: string;
}

/** Bubbles render this much of the original message (code blocks dropped). */
const MARKDOWN_LIMIT = 1500;

/**
 * The compact snapshot keeps the last few events plus the message the desk is speaking, so
 * a bubble can show the original wording and style instead of the stored plain excerpt — and
 * the person's last two requests, so a quoted request can show its full original text.
 */
export function snapshotEvents(s: Session, recent = 4): OfficeEvent[] {
  const tail = s.events.slice(-recent);
  const id = s.activity?.eventId;
  const kept = new Set(tail.map((e) => e.id));
  const extra: OfficeEvent[] = [];
  const asked = s.events.filter((e) => e.kind === 'user').slice(-2);
  for (const e of [...asked, ...(id ? s.events.filter((e) => e.id === id) : [])])
    if (!kept.has(e.id)) {
      kept.add(e.id);
      extra.push(e);
    }
  return [...extra.sort((a, b) => a.at - b.at), ...tail];
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
  // The request a bubble answers: sent no later than it, from the speaking run first. Candidates
  // are request notices plus the requests the snapshot retained (a conversation first collected
  // as history keeps only its last notice; nothing is stored or notified for these). Nothing is
  // quoted over a background run's words, nor from a background run or a helper.
  const answered = (at: number) => !bubble || at <= bubble.at;
  // One pass (desks can hold thousands of old requests): skip repeats, keep the best so far.
  let best:
    { id: string; eventId: string; at: number; sessionId: string; text: () => string } | undefined;
  const seen = new Set<string>();
  const consider = (c: NonNullable<typeof best>) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    const same = (x: typeof c) => Number(x.sessionId === bubble?.sessionId);
    if (!best || same(c) - same(best) > 0 || (same(c) === same(best) && c.at > best.at)) best = c;
  };
  for (const n of news)
    if (n.kind === 'request' && !n.background && answered(n.at))
      consider({
        id: n.id,
        eventId: n.eventId,
        at: n.at,
        sessionId: n.sessionId,
        text: () => n.text,
      });
  if (!isBackground(s) && !isHelper(s))
    for (const e of s.events)
      if (e.kind === 'user' && answered(e.at))
        consider({
          id: `${s.id}::${e.id}`,
          eventId: e.id,
          at: e.at,
          sessionId: s.id,
          text: () => messageExcerpt(e.text, 800),
        });
  const quoted: QuotedRequest | undefined =
    best && !bubble?.background
      ? { id: best.id, eventId: best.eventId, at: best.at, text: best.text() }
      : undefined;
  return {
    members,
    news,
    bubble,
    /** A request that just arrived (plays the arrival on the desk). */
    arrival: freshRequest(news, now),
    /**
     * With no bubble (closed, expired or resolved), the last thing the desk said — shown only
     * while the person points at the desk (`shownSpeech`).
     */
    peek: bubble
      ? undefined
      : [...news].sort((a, b) => b.at - a.at || b.receivedAt - a.receivedAt)[0],
    /**
     * The person's latest own request to this desk (closed ones too; not background runs),
     * quoted above the bubble while pointed at — unless the bubble already is that request.
     */
    request: quoted && quoted.id !== bubble?.id && tone !== 'mine' ? quoted : undefined,
    /** The quoted request's full original words when the desk still has them (else the excerpt). */
    requestText: quoted
      ? (s.events.find((e) => e.id === quoted.eventId)?.text ?? quoted.text)
      : undefined,
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
 * The bubble a desk shows: its current one (live progress too when `revealed`), or — while the
 * cursor is on the desk (`pointing`) — the last thing it said, even if that bubble was closed
 * or has expired.
 */
export function shownSpeech(
  s: Session,
  notices: OfficeNotice[],
  bubbleHours: number,
  now: number,
  speech: StationSpeech,
  revealed: boolean,
  pointing = revealed,
): { speech: StationSpeech; peek: boolean } | undefined {
  if (speech.shows(revealed)) return { speech, peek: false };
  if (!pointing || !speech.peek) return;
  const last = stationSpeech(s, notices, bubbleHours, now, speech.peek);
  // A call or error that was already answered reads as settled, not as calling again.
  const settled = ['attention', 'error'].includes(speech.peek.kind) && !!speech.peek.resolvedAt;
  return {
    speech: settled ? { ...last, tone: 'message', label: m().shared.settled(last.label) } : last,
    peek: true,
  };
}

/** A desk waiting for the person: a call or error outranks any arrival (bubble and pose). */
export const needsPerson = (s: Session, speech: Pick<StationSpeech, 'bubble'>) =>
  s.status === 'call' ||
  s.status === 'error' ||
  speech.bubble?.kind === 'attention' ||
  speech.bubble?.kind === 'error';

/**
 * What a desk says right now: a just-arrived request speaks first — the person's own words —
 * then the desk's usual bubble. A desk that needs the person keeps saying so (the papers still
 * land). Every desk view (big office, row, floor) uses this.
 */
export function deskSpeech(s: Session, notices: OfficeNotice[], bubbleHours = 3, now = Date.now()) {
  const usual = stationSpeech(s, notices, bubbleHours, now);
  const urgent = needsPerson(s, usual);
  const speech =
    usual.arrival && !urgent ? stationSpeech(s, notices, bubbleHours, now, usual.arrival) : usual;
  /** The colleague hops for the papers unless it is waiting for the person. */
  return { ...speech, hop: !!usual.arrival && !urgent };
}

/** The hop plays only for a view that is there as the papers land (late views stay still). */
export const HOP_MS = 2500;
export const hopping = (speech: { hop: boolean; arrival?: OfficeNotice }, now = Date.now()) =>
  speech.hop && !!speech.arrival && now - speech.arrival.receivedAt < HOP_MS;
