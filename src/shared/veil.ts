import type { OfficeNotice, Session } from './types';
import { sessionActivity } from './activity';
import { isFinalNotice } from './notices';
import { isBackground, isHelper } from './residents';

/** The next conversation a hidden colleague comes back for. Progress chatter is not one. */
const isConversation = (n: OfficeNotice) =>
  !n.background &&
  (n.kind === 'request' || isFinalNotice(n) || n.kind === 'attention' || n.kind === 'error');

/**
 * A colleague the person hid stays out of the scenes until their next conversation: a new
 * request, a final answer or a question/error after the hiding time. Scheduled or background
 * runs and helpers sharing a persona do not count (a helper at its own desk speaks for itself).
 * Bringing them back to the office does.
 * The caller keeps anyone who needs the person visible. Nothing is cleared: a newer
 * conversation keeps them shown for good.
 */
export function isVeiled(members: Session[], notices: OfficeNotice[]): boolean {
  const hiddenAt = Math.max(0, ...members.map((m) => m.hiddenAt ?? 0));
  if (!hiddenAt) return false;
  if (members.some((m) => (m.returnedAt ?? 0) > hiddenAt)) return false;
  const talking = members.filter((m) => !isBackground(m) && (members.length === 1 || !isHelper(m)));
  const ids = new Set(talking.map((m) => m.id));
  if (notices.some((n) => ids.has(n.sessionId) && n.at > hiddenAt && isConversation(n)))
    return false;
  return !talking.some((m) => {
    const a = sessionActivity(m);
    return (a.kind === 'request' || a.kind === 'reply') && a.at > hiddenAt;
  });
}

export const VEIL_HINT =
  '다음 대화(새 요청·최종 응답)가 올 때까지 가려요. 확인 요청이나 오류가 생기면 바로 다시 보여요.';
