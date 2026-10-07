import { useState } from 'react';
import { CornerDownLeft, Loader, Terminal } from 'lucide-react';
import type { TerminalTarget } from '../shared/types';
import { m } from '../shared/i18n';
import { useI18n } from '../lib/i18n';

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
  if (!target.canSend) return target.status === 'busy' ? text.busy : text.notWaiting;
  return text.direct(HOSTS[target.kind]);
}

/**
 * A follow-up typed into the colleague's live terminal, exactly as if typed there.
 * Desktop only, on unless turned off in Settings; the main process re-checks the terminal and its idle state.
 */
export function TerminalSend({
  target,
  enabled,
  privacy,
  onSend,
}: {
  target: TerminalTarget;
  enabled: boolean;
  privacy: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const host = HOSTS[target.kind];
  if (!enabled)
    return (
      <p className="terminal-send-hint">
        <Terminal size={12} />
        {t.terminal.offHint(target.queues ? t.terminal.runningCodex : t.terminal.runningIn(host))}
      </p>
    );
  const waiting = !target.canSend;
  const submit = async () => {
    if (!text.trim() || waiting || sending) return;
    setSending(true);
    setError('');
    try {
      await onSend(text);
      setText('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      className="terminal-send"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        aria-label={t.terminal.messageLabel(host)}
        rows={2}
        maxLength={4000}
        value={text}
        placeholder={
          waiting
            ? targetPlaceholder(target)
            : `${targetPlaceholder(target)} · ${t.terminal.sendShortcut}`
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="terminal-send-bar">
        <small>
          <Terminal size={11} />
          {targetLine(target, privacy)}
          {waiting && target.status === 'busy' ? ` · ${t.terminal.busy}` : ''}
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
      {error && (
        <small className="terminal-send-error" role="alert">
          {error}
        </small>
      )}
    </form>
  );
}
