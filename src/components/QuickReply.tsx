import { useEffect, useRef } from 'react';
import { CornerDownLeft, Loader, X } from 'lucide-react';
import type { SendResult, TerminalTarget } from '../shared/types';
import { targetLine, targetPlaceholder } from './TerminalSend';
import { DraftConfirm } from './DraftConfirm';
import { useI18n } from '../lib/i18n';
import { useComposerSend } from '../lib/useComposerSend';

/**
 * A short follow-up straight from a desk bubble, without opening the colleague card.
 * Enter sends, Shift+Enter breaks the line, Esc closes. The desktop side re-checks the target;
 * text already in the agent's composer is shown for a decision before anything is typed.
 */
export function QuickReply({
  target,
  name,
  onSend,
  onClose,
}: {
  target: TerminalTarget;
  name: string;
  onSend: (text: string, replaceDraft?: string) => Promise<SendResult>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const reply = useComposerSend(onSend, onClose);
  const { text, sending, error, draft } = reply;
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus({ preventScroll: true }), []);
  const blocked = !target.canSend;
  const submit = () => {
    if (!blocked) void reply.submit();
  };
  return (
    <form
      className="quick-reply"
      data-solid
      aria-label={t.terminal.replyTo(name)}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          e.stopPropagation();
          // Esc first drops an open question about the composer's text, keeping the reply.
          if (draft) {
            reply.cancel();
            field.current?.focus({ preventScroll: true });
          } else onClose();
        }
      }}
    >
      <textarea
        ref={field}
        rows={2}
        maxLength={4000}
        value={text}
        aria-label={t.terminal.replyLabel}
        placeholder={targetPlaceholder(target)}
        onChange={(e) => reply.setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="quick-reply-bar">
        <small>
          {targetLine(target, false)} · {t.terminal.replyKeys}
        </small>
        <button
          type="button"
          className="quick-reply-close"
          aria-label={t.terminal.closeReply}
          onClick={onClose}
        >
          <X size={12} />
        </button>
        <button
          type="submit"
          className="quick-reply-send"
          aria-label={t.terminal.send}
          disabled={sending || blocked || !text.trim()}
        >
          {sending ? <Loader size={12} className="now-spin" /> : <CornerDownLeft size={12} />}
        </button>
      </div>
      {draft && (
        <DraftConfirm
          draft={draft}
          sending={sending}
          blocked={blocked}
          onConfirm={() => void reply.confirm()}
          onCancel={() => {
            reply.cancel();
            field.current?.focus({ preventScroll: true });
          }}
        />
      )}
      {error && (
        <small className="quick-reply-error" role="alert">
          {error}
        </small>
      )}
    </form>
  );
}
