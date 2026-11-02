import { useState } from 'react';
import type { SendResult } from '../shared/types';
import { useComposerDraft } from './useComposerDraft';
import { useComposerImages } from './useComposerImages';
import { importDraft } from './terminalDraft';

export type DraftPrompt = Extract<SendResult, { status: 'needs-confirm' }>;

/**
 * What every follow-up box shares (the work card's and the bubble's quick reply): the text being
 * written, sending, the error, and the agent's composer text waiting for a decision. A send that
 * finds text in the composer comes back with it; nothing was typed, the reply stays as written,
 * and [Clear & send] sends again with that exact text to clear. Cancel only drops the question.
 */
export type ComposerSender = (
  text: string,
  replaceDraft?: string,
  allowPartialDraft?: boolean,
  /** Attached image ids, in order (absent: none). */
  images?: string[],
) => Promise<SendResult>;

export function useComposerSend(
  onSend: ComposerSender,
  onSent: (sent: string) => void,
  draftKey?: string,
) {
  const { text, setText, clearText } = useComposerDraft(draftKey);
  const attached = useComposerImages(draftKey);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<DraftPrompt | null>(null);
  /**
   * The terminal box's text the person took into this box to edit ([Edit in card]). The next
   * send replaces it: main clears exactly that text (to the clipboard) before typing, so the
   * edited version never lands next to the original. Changed there meanwhile, they are asked.
   */
  const [replaces, setReplaces] = useState<string | undefined>(undefined);
  /** `instead`: the composer's own text goes out in place of the reply, which then stays. */
  const send = async (replaceDraft?: string, instead?: string, allowPartialDraft?: boolean) => {
    const message = instead ?? text;
    // The composer's own text, sent as is, goes without the images: they stay for the reply.
    const ids = instead === undefined ? attached.images.map((image) => image.id) : [];
    if ((!message.trim() && !ids.length) || sending || attached.uploading) return;
    setSending(true);
    setError('');
    try {
      const result = await onSend(
        message,
        replaceDraft,
        allowPartialDraft,
        ids.length ? ids : undefined,
      );
      if (result.status === 'needs-confirm') {
        setDraft(result);
        setSending(false);
        return;
      }
      setDraft(null);
      setSending(false);
      if (instead === undefined) {
        attached.clearSent(ids);
        setReplaces(undefined);
        onSent(message);
      }
    } catch (e) {
      setError((e as Error).message);
      setDraft(null);
      setSending(false);
    }
  };
  return {
    text,
    setText,
    clearText,
    attached,
    /** Something to send: text, or images alone. */
    ready: !!text.trim() || attached.images.length > 0,
    sending,
    error,
    draft,
    submit: () => send(replaces),
    /** The terminal box's text this box took in to edit, until it is sent. */
    replaces,
    /** Takes the terminal box's text in to edit; sending then replaces it there. */
    importDraft: (boxText: string) => {
      setText(importDraft(text, boxText));
      setReplaces(boxText);
    },
    confirm: () => (draft ? send(draft.draft, undefined, draft.partial === true) : undefined),
    /** The composer's text, sent as it is (typed over itself after the same clearing). */
    sendDraft: () => (draft ? send(draft.draft, draft.draft) : undefined),
    cancel: () => setDraft(null),
  };
}
