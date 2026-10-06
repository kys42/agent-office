import type { OfficeNotice, Session } from './types';
import { sessionActivity } from './activity';

/**
 * A colleague the person hid stays out of the scenes until their next public conversation
 * (a request, progress or reply after the hiding time). The caller keeps anyone who needs
 * the person visible. Nothing is cleared: a newer conversation keeps them shown for good.
 */
export function isVeiled(members: Session[], notices: OfficeNotice[]): boolean {
  const hiddenAt = Math.max(0, ...members.map((m) => m.hiddenAt ?? 0));
  if (!hiddenAt) return false;
  const ids = new Set(members.map((m) => m.id));
  if (notices.some((n) => ids.has(n.sessionId) && n.at > hiddenAt)) return false;
  return !members.some((m) => {
    const a = sessionActivity(m);
    return a.kind !== 'status' && a.at > hiddenAt;
  });
}

export const VEIL_HINT =
  '다음 대화가 올 때까지 가려요. 확인 요청이나 오류가 생기면 바로 다시 보여요.';
