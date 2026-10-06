import { useState } from 'react';
import { CornerDownLeft, Loader, Terminal } from 'lucide-react';
import type { TerminalTarget } from '../shared/types';

const HOSTS = { orca: 'Orca', tmux: 'tmux' } as const;

/**
 * A follow-up typed into the colleague's live terminal, exactly as if typed there.
 * Desktop only and opt-in; the main process re-checks the terminal and its idle state.
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
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const host = HOSTS[target.kind];
  if (!enabled)
    return (
      <p className="terminal-send-hint">
        <Terminal size={12} />
        {host} 터미널에서 실행 중이에요. 설정에서 ‘터미널로 보내기’를 켜면 여기서 바로 이어서 말할
        수 있어요.
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
        aria-label={`${host} 터미널로 보낼 내용`}
        rows={2}
        maxLength={4000}
        value={text}
        placeholder={
          waiting
            ? target.status === 'busy'
              ? '작업 중이에요 · 끝나면 보낼 수 있어요'
              : '지금은 입력을 기다리지 않아요'
            : `${host} 터미널에 바로 입력돼요 · ⌘↵ 보내기`
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
          {privacy || !target.label ? host : `${host} · ${target.label}`}
          {waiting && target.status === 'busy' ? ' · 작업 중' : ''}
        </small>
        <button
          className="button primary"
          type="submit"
          disabled={waiting || sending || !text.trim()}
        >
          {sending ? <Loader size={13} className="now-spin" /> : <CornerDownLeft size={13} />}
          보내기
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
