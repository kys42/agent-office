import type { OfficeNotice, Session } from './types';
import { isAttentionNotice, isFinalNotice, isInboxNotice } from './notices';
import { needsAttention } from './residents';
import { isStandingBy } from './presentation';
import { workingFor } from './triage';

/** What is going on with a colleague, from what *I* can do: answer, read a result, wait. */
export type NowState = 'attention' | 'result' | 'working' | 'standby' | 'resting';
export function nowState(s: Session, notices: OfficeNotice[]): NowState {
  const unread = notices.filter((n) => !n.seenAt && isInboxNotice(n));
  if (needsAttention(s) || unread.some(isAttentionNotice)) return 'attention';
  if (unread.some(isFinalNotice)) return 'result';
  if (workingFor(s) !== null) return 'working';
  if (isStandingBy(s)) return 'standby';
  return 'resting';
}
