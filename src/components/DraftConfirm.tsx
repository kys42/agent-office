import { Eraser, Loader } from 'lucide-react';
import type { DraftPrompt } from '../lib/useComposerSend';
import { useI18n } from '../lib/i18n';

/**
 * The agent's composer already holds text: show it, then [Clear & send] or [Cancel]. Shared by
 * the work card and the bubble quick reply. Clearing puts the text on the clipboard first (the
 * desktop app does that), so no append option exists: mixing two instructions is never offered.
 * Focus stays where it was: a second Enter in the reply box only asks again, never clears.
 */
export function DraftConfirm({
  draft,
  sending,
  privacy = false,
  blocked = false,
  onConfirm,
  onCancel,
}: {
  draft: DraftPrompt;
  sending: boolean;
  privacy?: boolean;
  /** The target is not taking input right now (waiting for an answer, gone): no clearing. */
  blocked?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    // A status region read once, as its text: no label repeating the heading.
    <div className="draft-confirm" role="status">
      <strong>{t.terminal.draftFound(draft.agent)}</strong>
      {draft.changed && <small>{t.terminal.draftChanged}</small>}
      {draft.clipboard && <small>{t.terminal.draftPartlySaved}</small>}
      <pre className="draft-confirm-text">{privacy ? t.terminal.draftHidden : draft.draft}</pre>
      {draft.maybeSuggestion && <small>{t.terminal.draftMaybeSuggestion}</small>}
      <div className="draft-confirm-bar">
        <button
          type="button"
          className="draft-confirm-cancel"
          onClick={onCancel}
          disabled={sending}
        >
          {t.terminal.cancelClear}
        </button>
        <button
          type="button"
          className="draft-confirm-clear"
          onClick={onConfirm}
          disabled={sending || blocked}
        >
          {sending ? <Loader size={12} className="now-spin" /> : <Eraser size={12} />}
          {t.terminal.clearAndSend}
        </button>
      </div>
    </div>
  );
}
