import { CornerDownLeft, Loader, Terminal } from 'lucide-react';
import type { SendResult, TerminalTarget } from '../shared/types';
import { m } from '../shared/i18n';
import { useI18n } from '../lib/i18n';
import { platformKeys } from '../lib/platform';
import { useComposerSend } from '../lib/useComposerSend';
import { DraftConfirm } from './DraftConfirm';

export const HOSTS = { orca: 'Orca', tmux: 'tmux', codex: 'Codex' } as const;

/** One line naming where the text goes, shared by the card and the bubble quick reply. */
export function targetLine(target: TerminalTarget, privacy: boolean) {
  const host = target.codexRemote
    ? m().federation.codexRemoteRoute
    : target.desktop
      ? 'Codex Desktop'
      : HOSTS[target.kind];
  if (target.remoteOffice)
    return `${privacy ? m().federation.remoteOffice : target.remoteOffice} · ${host}`;
  if (target.desktop) return host;
  if (target.queues) return m().terminal.queueLine(host);
  return privacy || !target.label ? host : `${host} · ${target.label}`;
}

export function targetPlaceholder(target: TerminalTarget) {
  const text = m().terminal.placeholder;
  if (target.desktop) return text.desktop;
  if (target.queues) return text.queues;
  if (target.tabOnly) return text.tabOnly;
  if (!target.canSend) return text.notWaiting;
  // Mid-turn Claude queues what is typed, so a follow-up can steer the work in progress.
  return target.status === 'busy' ? text.busy : text.direct(HOSTS[target.kind]);
}

/**
 * A follow-up typed into the colleague's live terminal, exactly as if typed there.
 * Desktop only, on unless turned off in Settings; the main process re-checks the terminal and its state.
 * The box is always open to writing: whether it can go now (no terminal found, a question on
 * screen) is checked again on send, and a refusal says why while the text stays.
 */
export function TerminalSend({
  target,
  enabled,
  privacy,
  onSend,
  onJump,
  chat = false,
  draftKey,
  remoteOffice,
  onRefresh,
}: {
  /** Where it goes, as last seen; null while none was found (the send looks again). */
  target: TerminalTarget | null;
  enabled: boolean;
  privacy: boolean;
  onSend: (text: string, replaceDraft?: string, allowPartialDraft?: boolean) => Promise<SendResult>;
  /** Brings the session's terminal to the front (offered when its text can't be cleared). */
  onJump?: () => void;
  /** The card's chat box: Enter sends, Shift+Enter breaks the line, and it grows as you type. */
  chat?: boolean;
  /** Stable colleague identity, independent of the terminal's availability or label. */
  draftKey: string;
  remoteOffice?: string;
  onRefresh?: () => void;
}) {
  const { t } = useI18n();
  const reply = useComposerSend(onSend, (sent) => reply.clearText(sent), draftKey);
  const { text, sending, error, draft } = reply;
  const host = target?.desktop
    ? 'Codex Desktop'
    : target
      ? HOSTS[target.kind]
      : t.terminal.terminal;
  if (!enabled)
    return (
      <p className="terminal-send-hint">
        <Terminal size={12} />
        {target?.tabOnly
          ? t.terminal.placeholder.tabOnly
          : t.terminal.offHint(
              target?.desktop
                ? t.terminal.runningDesktop
                : target?.queues
                  ? t.terminal.runningCodex
                  : target
                    ? t.terminal.runningIn(host)
                    : t.terminal.runningSomewhere,
            )}
      </p>
    );
  // Not taking input as last seen (or not found): still written and sent; the desktop app
  // checks again and says why when it cannot.
  const submit = () => {
    if (!remoteOffice || target?.canSend) void reply.submit();
  };
  return (
    <form
      className={`terminal-send ${chat ? 'terminal-send-chat' : ''} ${remoteOffice ? 'terminal-send-remote' : ''}`}
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
        placeholder={`${target ? targetPlaceholder(target) : t.terminal.placeholder.unknown} · ${chat ? t.terminal.replyKeys : platformKeys(t.terminal.sendShortcut)}`}
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
          {remoteOffice
            ? `${remoteOffice} · ${target?.codexRemote ? t.federation.codexRemoteRoute : target?.canSend ? t.federation.sendReady : t.federation.sendUnavailable}`
            : target
              ? targetLine(target, privacy)
              : t.terminal.lookingAgain}
          {target && !target.queues && target.status === 'busy' ? ` · ${t.terminal.busy}` : ''}
        </small>
        <button
          className="button primary"
          type="submit"
          disabled={sending || !text.trim() || (!!remoteOffice && !target?.canSend)}
        >
          {sending ? <Loader size={13} className="now-spin" /> : <CornerDownLeft size={13} />}
          {t.terminal.send}
        </button>
      </div>
      {remoteOffice && !target?.canSend && (
        <small className="terminal-send-unavailable" role="status">
          {target?.codexRemote ? t.federation.codexRemoteUnavailable : t.federation.sendUnavailable}
        </small>
      )}
      {remoteOffice && onRefresh && (
        <button
          className="terminal-send-refresh"
          type="button"
          disabled={sending}
          onClick={onRefresh}
        >
          {t.federation.checkTarget}
        </button>
      )}
      {draft && (
        <DraftConfirm
          draft={draft}
          sending={sending}
          privacy={privacy}
          onJump={target?.canFocus ? onJump : undefined}
          onConfirm={() => void reply.confirm()}
          onSendDraft={() => void reply.sendDraft()}
          onCancel={reply.cancel}
        />
      )}
      {error && (
        <small className="terminal-send-error" role="alert">
          {error}
          {onJump && target?.canFocus && (
            <button type="button" className="terminal-send-jump" onClick={onJump}>
              <Terminal size={11} />
              {t.terminal.openTerminal}
            </button>
          )}
        </small>
      )}
    </form>
  );
}
