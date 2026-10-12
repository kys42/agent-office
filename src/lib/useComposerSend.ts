import { useState } from 'react';
import type { SendResult } from '../shared/types';

export type DraftPrompt = Extract<SendResult, { status: 'needs-confirm' }>;

/**
 * What every follow-up box shares (the work card's and the bubble's quick reply): the text being
 * written, sending, the error, and the agent's composer text waiting for a decision. A send that
 * finds text in the composer comes back with it; nothing was typed, the reply stays as written,
 * and [Clear & send] sends again with that exact text to clear. Cancel only drops the question.
 */
export function useComposerSend(
  onSend: (text: string, replaceDraft?: string) => Promise<SendResult>,
  onSent: () => void,
) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<DraftPrompt | null>(null);
  const send = async (replaceDraft?: string) => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      const result = await onSend(text, replaceDraft);
      if (result.status === 'needs-confirm') {
        setDraft(result);
        setSending(false);
        return;
      }
      setDraft(null);
      setSending(false);
      onSent();
    } catch (e) {
      setError((e as Error).message);
      setDraft(null);
      setSending(false);
    }
  };
  return {
    text,
    setText,
    sending,
    error,
    draft,
    submit: () => send(),
    confirm: () => (draft ? send(draft.draft) : undefined),
    cancel: () => setDraft(null),
  };
}
