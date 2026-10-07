import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, Loader, X } from 'lucide-react';
import type { TerminalTarget } from '../shared/types';
import { targetLine, targetPlaceholder } from './TerminalSend';

/**
 * A short follow-up straight from a desk bubble, without opening the colleague card.
 * Enter sends, Shift+Enter breaks the line, Esc closes. The desktop side re-checks the target.
 */
export function QuickReply({
  target,
  name,
  onSend,
  onClose,
}: {
  target: TerminalTarget;
  name: string;
  onSend: (text: string) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus({ preventScroll: true }), []);
  const submit = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      await onSend(text);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSending(false);
    }
  };
  return (
    <form
      className="quick-reply"
      aria-label={`${name}에게 바로 답장`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <textarea
        ref={field}
        rows={2}
        maxLength={4000}
        value={text}
        aria-label="답장 내용"
        placeholder={targetPlaceholder(target)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="quick-reply-bar">
        <small>{targetLine(target, false)} · ↵ 보내기 · ⇧↵ 줄바꿈</small>
        <button
          type="button"
          className="quick-reply-close"
          aria-label="답장 닫기"
          onClick={onClose}
        >
          <X size={12} />
        </button>
        <button
          type="submit"
          className="quick-reply-send"
          aria-label="보내기"
          disabled={sending || !text.trim()}
        >
          {sending ? <Loader size={12} className="now-spin" /> : <CornerDownLeft size={12} />}
        </button>
      </div>
      {error && (
        <small className="quick-reply-error" role="alert">
          {error}
        </small>
      )}
    </form>
  );
}
