import type { OfficeNotice, Session } from './types';
import { bubbleNotice, noticeLabel, unreadNoticeCount } from './notices';
import { activityLabel, sessionActivity } from './activity';

const LIVE = ['work', 'think', 'call', 'error'];

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
  return {
    members,
    news,
    bubble,
    activity,
    unread: unreadNoticeCount(news),
    text: bubble?.text ?? activity.text,
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
