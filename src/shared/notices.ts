import type { NoticeAction, NoticeKind, OfficeEvent, OfficeNotice, Session } from './types';
import { conversationKind } from './conversation';
import { messageExcerpt, sessionActivity } from './activity';
import { getLocale, m, messagesFor, type Locale } from './i18n';
import { liveLabels } from './labels';
import { CANONICAL, canonical, localizeText } from './canonical';
export const NOTICE_LABELS: Record<NoticeKind, string> = liveLabels((t) => t.shared.notice.label);
export const noticeVersion = (text: string) => {
  let n = 2166136261;
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
  return (n >>> 0).toString(16) + ':' + text.length;
};
/**
 * Content version of a notice. Notices are built from canonical session text and stored
 * canonical (localized on read), so versions never depend on the display language.
 */
export const noticeContentVersion = (kind: NoticeKind, text: string, at: number) =>
  noticeVersion(`${kind}:${text}:${at}`);
/** Notice candidates in canonical wording; readers show them through `localizeNotice`. */
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
      kind === 'attention' ? canonical().shared.notice.attention : messageExcerpt(e.text, 800);
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
      version: noticeContentVersion(kind, text, e.at),
      seenAt: null,
      viewedAt: null,
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
  // One current message, never a queue. Closing/expiring it must not reveal history.
  const latest = [...notices].sort((a, b) => b.at - a.at || b.receivedAt - a.receivedAt)[0];
  if (!latest || latest.dismissedAt) return;
  if (['attention', 'error'].includes(latest.kind) && latest.resolvedAt) return;
  if (now - latest.receivedAt >= hours * 3600_000 && !isAttentionNotice(latest)) return;
  return latest;
}
export function applyNoticeReceipt(
  notices: OfficeNotice[],
  receipts: { id: string; version: string }[],
  action: NoticeAction,
  now = Date.now(),
) {
  const versions = new Map(receipts.map((r) => [r.id, r.version]));
  return notices.map((n) =>
    versions.get(n.id) !== n.version
      ? n
      : {
          ...n,
          ...(action === 'view'
            ? { viewedAt: n.viewedAt ?? now }
            : action === 'read'
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
export const isInboxNotice = (n: OfficeNotice) =>
  isAttentionNotice(n) || (!n.background && isFinalNotice(n));
export const unreadNoticeCount = (notices: OfficeNotice[]) =>
  notices.filter((n) => !n.seenAt && isInboxNotice(n)).length;
export const noticeLabel = (n: OfficeNotice) =>
  n.kind === 'reply' && !isFinalNotice(n)
    ? m().shared.notice.unclassifiedReply
    : NOTICE_LABELS[n.kind];
export const noticeExposure = (n: OfficeNotice) => {
  const t = m().shared.notice;
  return n.seenAt ? t.read : n.viewedAt ? t.viewed : t.fresh;
};
/** A stored (canonical) notice in `locale`: its own cue text, or placeholders in an excerpt. */
export const localizeNotice = (n: OfficeNotice, locale: Locale = getLocale()): OfficeNotice =>
  n.kind === 'attention'
    ? { ...n, text: messagesFor(locale).shared.notice.attention }
    : locale === CANONICAL
      ? n
      : { ...n, text: localizeText(n.text, locale) };
