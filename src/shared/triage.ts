import type { OfficeNotice, Session } from './types';
import { isAttentionNotice, isInboxNotice } from './notices';
import { isStandingBy, isWorking } from './presentation';
import { needsAttention } from './residents';
import { taskStart } from './lifecycle';

/** What the person should do next, not how the session feels. Seats never depend on this. */
export type TriageGroup = 'attention' | 'results' | 'working' | 'standby' | 'resting';
export const TRIAGE_ORDER: TriageGroup[] = [
  'attention',
  'results',
  'working',
  'standby',
  'resting',
];
export const TRIAGE_LABELS: Record<TriageGroup, string> = {
  attention: '나를 기다려요',
  results: '확인할 결과',
  working: '일하는 중',
  standby: '대기 중',
  resting: '쉬는 중',
};

export const memberIds = (s: Session) => s.resident?.sessionIds ?? [s.id];

/** Unread notices that count toward the inbox badge for this colleague (all member runs). */
export function unreadInbox(s: Session, notices: OfficeNotice[]) {
  const ids = new Set(memberIds(s));
  return notices
    .filter((n) => ids.has(n.sessionId) && !n.seenAt && isInboxNotice(n))
    .sort((a, b) => b.at - a.at);
}

export function triageGroup(
  s: Session,
  notices: OfficeNotice[],
  now = Date.now(),
  unread = unreadInbox(s, notices),
): TriageGroup {
  if (needsAttention(s) || unread.some(isAttentionNotice)) return 'attention';
  if (unread.length) return 'results';
  if (isWorking(s, now)) return 'working';
  if (isStandingBy(s, now)) return 'standby';
  return 'resting';
}

/** Stable grouping: the incoming order (the user's chosen sort) is kept inside each group. */
export function triage(sessions: Session[], notices: OfficeNotice[], now = Date.now()) {
  const groups = new Map<TriageGroup, Session[]>(TRIAGE_ORDER.map((g) => [g, []]));
  for (const s of sessions) groups.get(triageGroup(s, notices, now))!.push(s);
  return TRIAGE_ORDER.map((group) => ({ group, sessions: groups.get(group)! }));
}

/** Elapsed time of the current observed task, only while there is recent working evidence. */
export function workingFor(s: Session, now = Date.now()): number | null {
  if (!isWorking(s, now)) return null;
  const start = taskStart(s);
  return start && start <= now ? now - start : null;
}

export const durationShort = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? '방금 시작' : m < 60 ? `${m}분째` : `${Math.floor(m / 60)}시간 ${m % 60}분째`;
};

/**
 * What arrived while the person was away. Bootstrap notices (first collection) are history,
 * not news, so they never appear here.
 */
export function awayDigest(notices: OfficeNotice[], since: number, until = Infinity) {
  const fresh = notices.filter(
    (n) =>
      !n.bootstrap &&
      !n.seenAt &&
      n.receivedAt > since &&
      n.receivedAt <= until &&
      isInboxNotice(n),
  );
  const attention = fresh.filter(isAttentionNotice);
  return {
    results: fresh.length - attention.length,
    attention: attention.length,
    sessionIds: [...new Set(fresh.sort((a, b) => b.at - a.at).map((n) => n.sessionId))],
  };
}
