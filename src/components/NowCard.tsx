import { useState } from 'react';
import { Check, CircleAlert, Hand, Hourglass, Inbox, Loader, Moon, Terminal } from 'lucide-react';
import type { OfficeNotice, Session } from '../shared/types';
import { isAttentionNotice, isFinalNotice, isInboxNotice } from '../shared/notices';
import { needsAttention } from '../shared/residents';
import { isStandingBy } from '../shared/presentation';
import { durationShort, workingFor } from '../shared/triage';
import { ago } from '../lib/format';
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
  const [open, setOpen] = useState(false);
  const state = nowState(s, notices);
  const unread = notices.filter((n) => !n.seenAt && isInboxNotice(n)).sort((a, b) => b.at - a.at);
  const result = unread.find(isFinalNotice);
  const ask = unread.find(isAttentionNotice);
  const elapsed = workingFor(s);
  const receipts = (list: OfficeNotice[]) => list.map(({ id, version }) => ({ id, version }));
  if (privacy)
    return (
      <section className={`now-card tone-${state}`} aria-label="지금 상태">
        <div className="now-title">
          <b>내용을 숨기고 있어요</b>
        </div>
      </section>
    );
  return (
    <section className={`now-card tone-${state}`} aria-label="지금 상태">
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
              ? '확인이 필요해요'
              : '답변을 기다리고 있어요'
            : state === 'result'
              ? `새 결과가 도착했어요${unread.length > 1 ? ` · ${unread.length}건` : ''}`
              : state === 'working'
                ? `작업 중 · ${elapsed !== null ? durationShort(elapsed) : '진행 중'}`
                : state === 'standby'
                  ? '대기 중 · 방금 일을 마쳤어요'
                  : '지금은 조용해요'}
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
              {open ? '접기' : '더 보기'}
            </button>
          )}
          <div className="now-actions">
            <button className="button primary" onClick={() => onReceipt(receipts(unread), 'read')}>
              <Check size={14} />
              {unread.length > 1 ? `${unread.length}건 모두 읽음` : '읽음으로 표시'}
            </button>
            <button className="button subtle" onClick={onShowNews}>
              소식에서 보기
            </button>
          </div>
          <small className="now-note">
            최종 응답은 이번 답변의 끝이에요. 업무 전체의 성공과는 달라요.
          </small>
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
                    확인했어요
                  </button>
                )}
              </div>
              <small className="now-note">
                {canType
                  ? typeQueues
                    ? '승인 요청은 원래 앱에서 답해 주세요. 아래에서 보낸 말은 지금 작업이 끝난 뒤 처리돼요.'
                    : '승인 요청은 원래 앱에서 답해 주세요. 쉬는 중이면 아래에서 바로 이어서 말할 수 있어요.'
                  : '답변과 승인은 원래 앱에서 해 주세요. Agent Office는 기록을 읽기만 해요.'}
              </small>
            </>
          )}
        </>
      )}
    </section>
  );
}
