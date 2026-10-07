import { useState } from 'react';
import { Check, CircleAlert, Hand, Hourglass, Inbox, Loader, Moon, Terminal } from 'lucide-react';
import type { OfficeNotice, Session } from '../shared/types';
import { isAttentionNotice, isFinalNotice, isInboxNotice } from '../shared/notices';
import { needsAttention } from '../shared/residents';
import { isStandingBy } from '../shared/presentation';
import { durationShort, workingFor } from '../shared/triage';
import { ago } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { ActivitySummary } from './ActivitySummary';
import type { ReceiptHandler } from './News';

export type NowState = 'attention' | 'result' | 'working' | 'standby' | 'resting';
export function nowState(s: Session, notices: OfficeNotice[]): NowState {
  const unread = notices.filter((n) => !n.seenAt && isInboxNotice(n));
  if (needsAttention(s) || unread.some(isAttentionNotice)) return 'attention';
  if (unread.some(isFinalNotice)) return 'result';
  if (workingFor(s) !== null) return 'working';
  if (isStandingBy(s)) return 'standby';
  return 'resting';
}

/**
 * The first thing in a colleague's card: what is going on and what *I* can do about it.
 * Answers and approvals always happen in the original tool; this card only routes there.
 */
export function NowCard({
  session: s,
  notices,
  privacy,
  onReceipt,
  onResume,
  resumeLabel,
  canResume,
  canType = false,
  typeQueues = false,
  onShowNews,
}: {
  session: Session;
  notices: OfficeNotice[];
  privacy: boolean;
  onReceipt: ReceiptHandler;
  onResume: () => void;
  resumeLabel: string;
  canResume: boolean;
  /** The live terminal accepts follow-ups typed from this card. */
  canType?: boolean;
  /** Follow-ups wait for the current turn instead of needing an idle session (Codex CLI). */
  typeQueues?: boolean;
  onShowNews: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const state = nowState(s, notices);
  const unread = notices.filter((n) => !n.seenAt && isInboxNotice(n)).sort((a, b) => b.at - a.at);
  const result = unread.find(isFinalNotice);
  const ask = unread.find(isAttentionNotice);
  const elapsed = workingFor(s);
  const receipts = (list: OfficeNotice[]) => list.map(({ id, version }) => ({ id, version }));
  if (privacy)
    return (
      <section className={`now-card tone-${state}`} aria-label={t.now.region}>
        <div className="now-title">
          <b>{t.now.hidden}</b>
        </div>
      </section>
    );
  return (
    <section className={`now-card tone-${state}`} aria-label={t.now.region}>
      <div className="now-title">
        {state === 'attention' ? (
          s.status === 'error' && !ask ? (
            <CircleAlert size={15} />
          ) : (
            <Hand size={15} />
          )
        ) : state === 'result' ? (
          <Inbox size={15} />
        ) : state === 'working' ? (
          <Loader size={15} className="now-spin" />
        ) : state === 'standby' ? (
          <Hourglass size={15} />
        ) : (
          <Moon size={15} />
        )}
        <b>
          {state === 'attention'
            ? s.status === 'error' && !ask
              ? t.now.needsLook
              : t.now.waitingReply
            : state === 'result'
              ? t.now.newResult(unread.length)
              : state === 'working'
                ? t.now.working(elapsed !== null ? durationShort(elapsed) : t.now.inProgress)
                : state === 'standby'
                  ? t.now.standby
                  : t.now.quiet}
        </b>
        <time>{ago(state === 'result' && result ? result.at : s.updatedAt)}</time>
      </div>
      {state === 'result' && result ? (
        <>
          <p className={`now-result ${open ? 'expanded' : ''}`}>{result.text}</p>
          {result.text.length > 220 && (
            <button
              className="now-more"
              onClick={() => {
                if (!open) onReceipt(receipts([result]), 'view');
                setOpen(!open);
              }}
            >
              {open ? t.now.less : t.now.more}
            </button>
          )}
          <div className="now-actions">
            <button className="button primary" onClick={() => onReceipt(receipts(unread), 'read')}>
              <Check size={14} />
              {unread.length > 1 ? t.now.markAllRead(unread.length) : t.now.markRead}
            </button>
            <button className="button subtle" onClick={onShowNews}>
              {t.now.viewUpdate}
            </button>
          </div>
          <small className="now-note">{t.now.finalNote}</small>
        </>
      ) : (
        <>
          <ActivitySummary session={s} />
          {state === 'attention' && (
            <>
              <div className="now-actions">
                <button className="button primary" onClick={onResume} disabled={!canResume}>
                  <Terminal size={14} />
                  {resumeLabel}
                </button>
                {ask && (
                  <button
                    className="button subtle"
                    onClick={() => onReceipt(receipts([ask]), 'read')}
                  >
                    <Check size={14} />
                    {t.now.ack}
                  </button>
                )}
              </div>
              <small className="now-note">
                {canType ? (typeQueues ? t.now.typeQueuedNote : t.now.typeNote) : t.now.replyNote}
              </small>
            </>
          )}
        </>
      )}
    </section>
  );
}
