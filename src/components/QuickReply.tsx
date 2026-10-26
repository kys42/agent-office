import { useEffect, useRef } from 'react';
import { CornerDownLeft, Loader, X } from 'lucide-react';
import type { SendResult, TerminalTarget } from '../shared/types';
import { targetLine, targetPlaceholder } from './TerminalSend';
import { DraftConfirm } from './DraftConfirm';
import { useI18n } from '../lib/i18n';
import { useComposerSend, type ComposerSender } from '../lib/useComposerSend';
import { api } from '../lib/api';
import { imageBlock } from '../shared/attachments';
import { ImageAttachButton, ImageStrip, useImageInput } from './ComposerImages';

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
  onJump,
}: {
  target: TerminalTarget;
  name: string;
  onSend: ComposerSender;
  /** Brings the session's terminal to the front (offered when its text can't be cleared). */
  onJump?: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const reply = useComposerSend(onSend, onClose);
  const { text, sending, error, draft, attached } = reply;
  const block = imageBlock(target, { desktop: !!api.attachImage });
  const asPaths = target.images === 'path';
  const dropping = useImageInput(attached, block);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus({ preventScroll: true }), []);
  // Not taking input as last seen: still sent; the desktop app checks again and says why.
  const submit = () => void reply.submit();
  return (
    <form
      className={`quick-reply ${dropping.over ? 'composer-drop' : ''}`}
      onPaste={dropping.onPaste}
      onDragOver={dropping.onDragOver}
      onDragLeave={dropping.onDragLeave}
      onDrop={dropping.onDrop}
      tabIndex={-1}
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
          } else if (
            e.target instanceof HTMLElement &&
            e.target.closest('input, textarea, select')
          ) {
            // Leave the input first, keeping an unfinished reply. The next Esc closes it.
            // Keep focus inside this form so the next Esc reaches onClose in every scene.
            e.currentTarget.focus({ preventScroll: true });
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
      {/* Quick replies open only with screen content shown: thumbnails are visible. */}
      <ImageStrip attached={attached} privacy={false} block={block} asPaths={asPaths} />
      <div className="quick-reply-bar">
        <small>
          {targetLine(target, false)} · {t.terminal.replyKeys}
        </small>
        <ImageAttachButton
          attached={attached}
          block={block}
          asPaths={asPaths}
          disabled={sending}
          className="quick-reply-attach"
        />
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
          aria-label={target.canPrepare ? t.federation.connectAndSend : t.terminal.send}
          disabled={sending || !reply.ready || attached.uploading}
        >
          {sending ? <Loader size={12} className="now-spin" /> : <CornerDownLeft size={12} />}
        </button>
      </div>
      {target.canPrepare && <small role="status">{t.federation.codexConnectHint}</small>}
      {draft && (
        <DraftConfirm
          draft={draft}
          sending={sending}
          onJump={target.canFocus ? onJump : undefined}
          onConfirm={() => void reply.confirm()}
          onSendDraft={() => void reply.sendDraft()}
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
