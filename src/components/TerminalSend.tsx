import { CornerDownLeft, Loader, Terminal } from 'lucide-react';
import type { SendResult, TerminalTarget } from '../shared/types';
import { m } from '../shared/i18n';
import { useI18n } from '../lib/i18n';
import { useComposerSend } from '../lib/useComposerSend';
import { DraftConfirm } from './DraftConfirm';

export const HOSTS = { orca: 'Orca', tmux: 'tmux', codex: 'Codex' } as const;

/** One line naming where the text goes, shared by the card and the bubble quick reply. */
export function targetLine(target: TerminalTarget, privacy: boolean) {
  const host = HOSTS[target.kind];
  if (target.queues) return m().terminal.queueLine(host);
  return privacy || !target.label ? host : `${host} · ${target.label}`;
}

export function targetPlaceholder(target: TerminalTarget) {
  const text = m().terminal.placeholder;
  if (target.queues) return text.queues;
  if (!target.canSend) return text.notWaiting;
  // Mid-turn Claude queues what is typed, so a follow-up can steer the work in progress.
  return target.status === 'busy' ? text.busy : text.direct(HOSTS[target.kind]);
}

/**
 * A follow-up typed into the colleague's live terminal, exactly as if typed there.
 * Desktop only, on unless turned off in Settings; the main process re-checks the terminal and its state.
 */
export function TerminalSend({
  target,
  enabled,
  privacy,
  onSend,
  onJump,
  chat = false,
}: {
  target: TerminalTarget;
  enabled: boolean;
  privacy: boolean;
  onSend: (text: string, replaceDraft?: string) => Promise<SendResult>;
  /** Brings the session's terminal to the front (offered when its text can't be cleared). */
  onJump?: () => void;
  /** The card's chat box: Enter sends, Shift+Enter breaks the line, and it grows as you type. */
  chat?: boolean;
}) {
  const { t } = useI18n();
  const reply = useComposerSend(onSend, () => reply.setText(''));
  const { text, sending, error, draft } = reply;
  const host = HOSTS[target.kind];
  if (!enabled)
    return (
      <p className="terminal-send-hint">
        <Terminal size={12} />
        {t.terminal.offHint(target.queues ? t.terminal.runningCodex : t.terminal.runningIn(host))}
      </p>
    );
  const waiting = !target.canSend;
  const submit = () => {
    if (!waiting) void reply.submit();
  };
  return (
    <form
      className={`terminal-send ${chat ? 'terminal-send-chat' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        // Esc drops an open question about the composer's text; the message stays.
        if (e.key === 'Escape' && draft && !e.nativeEvent.isComposing) {
          e.stopPropagation();
          reply.cancel();
        }
      }}
    >
      <textarea
        aria-label={t.terminal.messageLabel(host)}
        rows={chat ? 1 : 2}
        maxLength={4000}
        value={text}
        placeholder={
          waiting
            ? targetPlaceholder(target)
            : `${targetPlaceholder(target)} · ${chat ? t.terminal.replyKeys : t.terminal.sendShortcut}`
        }
        onChange={(e) => reply.setText(e.target.value)}
        onKeyDown={(e) => {
          const sends = chat ? !e.shiftKey : e.metaKey || e.ctrlKey;
          if (e.key === 'Enter' && sends && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="terminal-send-bar">
        <small>
          <Terminal size={11} />
          {targetLine(target, privacy)}
          {!target.queues && target.status === 'busy' ? ` · ${t.terminal.busy}` : ''}
        </small>
        <button
          className="button primary"
          type="submit"
          disabled={waiting || sending || !text.trim()}
        >
          {sending ? <Loader size={13} className="now-spin" /> : <CornerDownLeft size={13} />}
          {t.terminal.send}
        </button>
      </div>
      {draft && (
        <DraftConfirm
          draft={draft}
          sending={sending}
          privacy={privacy}
          blocked={waiting}
          onJump={target.canFocus ? onJump : undefined}
          onConfirm={() => void reply.confirm()}
          onCancel={reply.cancel}
        />
      )}
      {error && (
        <small className="terminal-send-error" role="alert">
          {error}
        </small>
      )}
    </form>
  );
}
