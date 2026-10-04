import type { NoticeKind, OfficeEvent, OfficeNotice, Session } from './types';
import { conversationKind } from './conversation';
import { messageExcerpt, sessionActivity } from './activity';
export const NOTICE_LABELS: Record<NoticeKind, string> = {
  request: '새 요청',
  progress: '진행 소식',
  reply: '최종 응답',
  message: '기타 응답',
  attention: '응답 필요',
  error: '확인 필요',
};
export const noticeVersion = (text: string) => {
  let n = 2166136261;
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
  return (n >>> 0).toString(16) + ':' + text.length;
};
export function noticeCandidates(s: Session, now = Date.now(), bootstrap = false): OfficeNotice[] {
  const events = [...s.events];
  const a = sessionActivity(s);
  if (a.eventId && !events.some((e) => e.id === a.eventId) && a.kind !== 'status')
    events.push({
      id: a.eventId,
      at: a.at,
      kind: a.kind === 'request' ? 'user' : 'assistant',
      text: a.text,
      phase: a.kind === 'progress' ? 'commentary' : a.kind === 'reply' ? 'final' : undefined,
      sourceRef: s.sourcePath,
    });
  const candidates: OfficeNotice[] = [];
  for (const e of events.sort((a, b) => a.at - b.at)) {
    const category = conversationKind(e);
    const kind: NoticeKind | null =
      category !== 'work'
        ? category
        : e.kind === 'tool' && e.intent === 'request-input'
          ? 'attention'
          : null;
    if (!kind) continue;
    const text =
      kind === 'attention'
        ? '원래 앱에서 질문이나 입력 요청을 확인해 주세요.'
        : messageExcerpt(e.text, 800);
    if (!text) continue;
    // Some sources expose both public message and public event forms.
    if (candidates.some((n) => n.kind === kind && n.text === text && Math.abs(n.at - e.at) < 3000))
      continue;
    const id = `${s.id}::${e.id}`;
    candidates.push({
      id,
      sessionId: s.id,
      eventId: e.id,
      kind,
      phase: e.phase,
      text,
      at: e.at,
      receivedAt: now,
      version: noticeVersion(`${kind}:${text}:${e.at}`),
      seenAt: null,
      dismissedAt: null,
      resolvedAt: null,
      bootstrap,
    });
  }
  return candidates;
}
export function bubbleNotice(
  notices: OfficeNotice[],
  hours = 3,
  now = Date.now(),
): OfficeNotice | undefined {
  const eligible = notices.filter(
    (n) =>
      !n.dismissedAt &&
      (now - n.receivedAt < hours * 3600_000 ||
        (!n.resolvedAt && ['attention', 'error'].includes(n.kind))),
  );
  const rank = (n: OfficeNotice) =>
    !n.resolvedAt && ['attention', 'error'].includes(n.kind)
      ? 0
      : !n.seenAt && isFinalNotice(n)
        ? 1
        : !n.seenAt
          ? 2
          : 3;
  return eligible.sort((a, b) => rank(a) - rank(b) || b.at - a.at)[0];
}
export function applyNoticeReceipt(
  notices: OfficeNotice[],
  receipts: { id: string; version: string }[],
  action: 'read' | 'dismiss' | 'unread',
  now = Date.now(),
) {
  const versions = new Map(receipts.map((r) => [r.id, r.version]));
  return notices.map((n) =>
    versions.get(n.id) !== n.version
      ? n
      : {
          ...n,
          ...(action === 'read'
            ? { seenAt: now }
            : action === 'unread'
              ? { seenAt: null }
              : { dismissedAt: now }),
        },
  );
}

export const isFinalNotice = (n: OfficeNotice) => n.kind === 'reply' && n.phase === 'final';
export const isAttentionNotice = (n: OfficeNotice) =>
  !n.resolvedAt && (n.kind === 'attention' || n.kind === 'error');
export const isInboxNotice = (n: OfficeNotice) => isFinalNotice(n) || isAttentionNotice(n);
export const unreadNoticeCount = (notices: OfficeNotice[]) =>
  notices.filter((n) => !n.seenAt && isInboxNotice(n)).length;
export const noticeLabel = (n: OfficeNotice) =>
  n.kind === 'reply' && !isFinalNotice(n) ? '응답 · 구분 없음' : NOTICE_LABELS[n.kind];
