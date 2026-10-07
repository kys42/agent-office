import type { NoticeAction, NoticeKind, OfficeEvent, OfficeNotice, Session } from './types';
import { conversationKind } from './conversation';
import { messageExcerpt, sessionActivity } from './activity';
import { LOCALES, m, messagesFor, type Locale } from './i18n';
import { liveLabels } from './labels';
export const NOTICE_LABELS: Record<NoticeKind, string> = liveLabels((t) => t.shared.notice.label);
export const noticeVersion = (text: string) => {
  let n = 2166136261;
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
  return (n >>> 0).toString(16) + ':' + text.length;
};
// Versions hash the original (Korean) wording of text the office generates itself, so a
// language switch or an upgrade never turns an already-read notice into a new one.
const ORIGIN: Locale = 'ko';
function versionText(kind: NoticeKind, text: string) {
  const origin = messagesFor(ORIGIN).shared;
  if (kind === 'attention') return origin.notice.attention;
  let out = text;
  for (const locale of Object.keys(LOCALES) as Locale[]) {
    if (locale === ORIGIN) continue;
    const redaction = messagesFor(locale).shared.redaction;
    for (const key of Object.keys(redaction) as (keyof typeof redaction)[])
      out = out.replaceAll(redaction[key], origin.redaction[key]);
  }
  return out;
}
/** Content version of a notice; independent of the display language. */
export const noticeContentVersion = (kind: NoticeKind, text: string, at: number) =>
  noticeVersion(`${kind}:${versionText(kind, text)}:${at}`);
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
    const text = kind === 'attention' ? m().shared.notice.attention : messageExcerpt(e.text, 800);
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
/** Text the office wrote itself is shown in the active language, whenever it was stored. */
export const localizeNotice = (n: OfficeNotice): OfficeNotice =>
  n.kind === 'attention' ? { ...n, text: m().shared.notice.attention } : n;
