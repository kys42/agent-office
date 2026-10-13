import { useState } from 'react';
import {
  CheckSquare,
  ClipboardList,
  Loader,
  MessageCircleQuestion,
  ShieldQuestion,
  Square,
} from 'lucide-react';
import type {
  AnswerChoice,
  DialogChoice,
  InputRequest,
  PromptSubject,
  QuestionAnswer,
  Session,
  TerminalTarget,
} from '../shared/types';
import { openRequest } from '../shared/requests';
import { useI18n } from '../lib/i18n';
import { api, isDesktop } from '../lib/api';
import { answerPrompt, usePrompt } from '../lib/usePrompt';
import { BubbleMarkdown } from './BubbleMarkdown';

const OTHER_LIMIT = 2000;

/**
 * What a calling colleague asks, in the card's "now" area: the questions with their options,
 * the plan to approve, or what a permission prompt is about. One component for the work card
 * and the popup card. Where the desktop app can see the same dialog on the session's terminal,
 * the options become buttons that press the dialog's own keys (the main process checks the
 * screen again and asks once before the first answer); otherwise it says why, and the card's
 * jump button takes the person to the terminal. Hidden-screen mode never renders this.
 */
export function RequestCard({
  session,
  target,
  notify,
  demo = false,
}: {
  session: Session;
  /** The live terminal as last seen; null when none was found. */
  target: TerminalTarget | null;
  notify: (message: string) => void;
  demo?: boolean;
}) {
  const asking = openRequest(session);
  if (!asking) return null;
  // A new request starts with nothing picked.
  return (
    <RequestBody
      key={asking.id}
      sessionId={session.id}
      eventId={asking.id}
      request={asking.request}
      target={target}
      notify={notify}
      demo={demo}
    />
  );
}

function RequestBody({
  sessionId,
  eventId,
  request,
  target,
  notify,
  demo,
}: {
  sessionId: string;
  eventId: string;
  request: InputRequest;
  target: TerminalTarget | null;
  notify: (message: string) => void;
  demo: boolean;
}) {
  const { t } = useI18n();
  const c = t.prompts.card;
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const canAsk = !demo && isDesktop && !!api.answer;
  const { view, refresh } = usePrompt(sessionId, eventId, target, canAsk && !sent);
  const ready =
    canAsk &&
    !sent &&
    view?.status === 'ready' &&
    view.kind === request.kind &&
    view.eventId === eventId
      ? view
      : null;
  const send = async (choice: AnswerChoice) => {
    if (sending) return;
    setSending(true);
    const ok = await answerPrompt(sessionId, choice, notify);
    setSending(false);
    if (ok) setSent(true);
    else refresh();
  };
  // Why the buttons are not there: the desktop app's reason, or what is already known here.
  const why = ready
    ? null
    : sent
      ? c.sent
      : !canAsk
        ? demo
          ? null
          : t.prompts.unavailable.web
        : !target
          ? t.prompts.unavailable['no-terminal']
          : target.queues
            ? t.prompts.unavailable.unsupported('Codex')
            : !view
              ? c.checking
              : view.status === 'unavailable'
                ? view.message
                : t.prompts.unavailable.mismatch;
  return (
    <div className={`request-card kind-${request.kind}`} role="group" aria-label={c.region}>
      {request.kind === 'question' ? (
        <Questions
          request={request}
          eventId={eventId}
          ready={!!ready}
          other={ready?.other ?? []}
          sending={sending}
          onAnswer={send}
        />
      ) : request.kind === 'plan' ? (
        <Plan request={request} />
      ) : (
        <Permission tool={request.tool} subject={ready?.subject} />
      )}
      {ready && request.kind !== 'question' && (
        <Choices
          choices={ready.choices}
          sending={sending}
          onPick={(choice) =>
            void send({
              kind: request.kind as 'plan' | 'permission',
              eventId,
              number: choice.number,
              label: choice.label,
            })
          }
        />
      )}
      {ready?.more && <small className="request-status">{c.more}</small>}
      {sending && (
        <small className="request-status" role="status">
          <Loader size={11} className="now-spin" />
          {c.sending}
        </small>
      )}
      {!sending && why && <small className="request-status">{why}</small>}
    </div>
  );
}

function Questions({
  request,
  eventId,
  ready,
  other,
  sending,
  onAnswer,
}: {
  request: Extract<InputRequest, { kind: 'question' }>;
  eventId: string;
  ready: boolean;
  /** Per question: typed words can be sent (never for multi-select). */
  other: boolean[];
  sending: boolean;
  onAnswer: (choice: AnswerChoice) => Promise<void>;
}) {
  const { t } = useI18n();
  const c = t.prompts.card;
  const qs = request.questions;
  const [picks, setPicks] = useState<number[][]>(() => qs.map(() => []));
  const [typed, setTyped] = useState<(string | null)[]>(() => qs.map(() => null));
  // One single-choice question answers on the first click; anything else collects, then sends.
  const instant = qs.length === 1 && !qs[0].multiSelect;
  const answers: (QuestionAnswer | null)[] = qs.map((_, i) =>
    typed[i] !== null
      ? typed[i]!.trim()
        ? { other: typed[i]!.trim() }
        : null
      : picks[i].length
        ? { options: picks[i] }
        : null,
  );
  const complete = answers.every(Boolean);
  const submit = (list: (QuestionAnswer | null)[]) =>
    void onAnswer({ kind: 'question', eventId, answers: list as QuestionAnswer[] });
  const pick = (q: number, o: number) => {
    if (instant) return submit([{ options: [o] }]);
    setTyped((all) => all.map((v, i) => (i === q ? null : v)));
    setPicks((all) =>
      all.map((list, i) =>
        i !== q
          ? list
          : qs[q].multiSelect
            ? list.includes(o)
              ? list.filter((x) => x !== o)
              : [...list, o].sort((a, b) => a - b)
            : [o],
      ),
    );
  };
  return (
    <>
      {qs.map((q, qi) => (
        <section className="request-question" key={qi}>
          <div className="request-head">
            <MessageCircleQuestion size={13} />
            {q.header && <span className="request-chip">{q.header}</span>}
            {q.multiSelect && <span className="request-chip multi">{c.multi}</span>}
            {qs.length > 1 && <small>{`${qi + 1}/${qs.length}`}</small>}
          </div>
          <p className="request-text">{q.question}</p>
          {q.options.length > 0 && (
            <ul className="request-options">
              {q.options.map((o, oi) => {
                const on = picks[qi].includes(oi) && typed[qi] === null;
                const body = (
                  <>
                    {q.multiSelect &&
                      (on ? (
                        <CheckSquare size={13} aria-hidden />
                      ) : (
                        <Square size={13} aria-hidden />
                      ))}
                    <span>
                      <b>{o.label}</b>
                      {o.description && <small>{o.description}</small>}
                    </span>
                  </>
                );
                return (
                  <li key={oi}>
                    {ready ? (
                      <button
                        type="button"
                        className={`request-option ${on ? 'on' : ''}`}
                        role={q.multiSelect ? 'checkbox' : instant ? undefined : 'radio'}
                        aria-checked={instant ? undefined : on}
                        disabled={sending}
                        onClick={() => pick(qi, oi)}
                      >
                        {body}
                      </button>
                    ) : (
                      <div className="request-option static">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {ready && other[qi] && !q.multiSelect && (
            <div className="request-other">
              {typed[qi] === null ? (
                <button
                  type="button"
                  className="request-option other"
                  disabled={sending}
                  onClick={() => {
                    setTyped((all) => all.map((v, i) => (i === qi ? '' : v)));
                    setPicks((all) => all.map((list, i) => (i === qi ? [] : list)));
                  }}
                >
                  {c.other}
                </button>
              ) : (
                <textarea
                  aria-label={c.otherLabel(qi + 1)}
                  placeholder={c.otherPlaceholder}
                  rows={2}
                  maxLength={OTHER_LIMIT}
                  autoFocus
                  value={typed[qi]!}
                  disabled={sending}
                  onChange={(e) =>
                    setTyped((all) => all.map((v, i) => (i === qi ? e.target.value : v)))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                      e.stopPropagation();
                      setTyped((all) => all.map((v, i) => (i === qi ? null : v)));
                    }
                  }}
                />
              )}
            </div>
          )}
        </section>
      ))}
      {ready && (!instant || typed[0] !== null) && (
        <div className="request-submit">
          <button
            type="button"
            className="button primary"
            disabled={sending || !complete}
            onClick={() => submit(answers)}
          >
            {c.submit}
          </button>
        </div>
      )}
    </>
  );
}

function Plan({ request }: { request: Extract<InputRequest, { kind: 'plan' }> }) {
  const { t } = useI18n();
  const c = t.prompts.card;
  const [open, setOpen] = useState(false);
  return (
    <section className="request-plan">
      <div className="request-head">
        <ClipboardList size={13} />
        <b>{c.plan}</b>
        <button
          type="button"
          className="now-more"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? c.hidePlan : c.showPlan}
        </button>
      </div>
      <div className={`request-plan-body bubble-markdown ${open ? 'open' : ''}`}>
        <BubbleMarkdown text={request.plan} />
      </div>
      {request.planFile && <small className="request-file">{c.planFile(request.planFile)}</small>}
    </section>
  );
}

/**
 * A permission prompt: the tool by name and, once the desktop app has read it, what the
 * screen says the call does. The call's input is never stored, so nothing else is shown.
 */
function Permission({ tool, subject }: { tool: string; subject?: PromptSubject }) {
  const { t } = useI18n();
  const c = t.prompts.card;
  const what = subject?.command ?? subject?.path ?? subject?.url;
  return (
    <section className="request-permission">
      <div className="request-head">
        <ShieldQuestion size={13} />
        <b>{c.permission(tool)}</b>
      </div>
      {subject && what && (
        <>
          <small className="request-file">
            {subject.title} · {c.onScreen}
          </small>
          <pre className="request-command">{what}</pre>
        </>
      )}
    </section>
  );
}

/** The dialog's one-shot choices, as drawn (allow once, deny, approve with edits asked). */
function Choices({
  choices,
  sending,
  onPick,
}: {
  choices: DialogChoice[];
  sending: boolean;
  onPick: (choice: DialogChoice) => void;
}) {
  return (
    <div className="request-choices">
      {choices.map((choice) => (
        <button
          key={choice.number}
          type="button"
          className={`button request-choice role-${choice.role} ${choice.role === 'allow' ? 'primary' : 'subtle'}`}
          disabled={sending}
          onClick={() => onPick(choice)}
        >
          <span className="request-choice-number">{choice.number}</span>
          {choice.label}
        </button>
      ))}
    </div>
  );
}
