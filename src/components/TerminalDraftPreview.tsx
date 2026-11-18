import { useState } from 'react';
import { CornerDownLeft, Loader, PencilLine, Sparkles, Terminal } from 'lucide-react';
import type { ComposerDraftView } from '../shared/types';
import { useI18n } from '../lib/i18n';
import { draftIsLong } from '../lib/terminalDraft';

/**
 * What sits in the colleague's terminal input box, typed there and not sent: shown above the
 * card's chat box with [Send as is] (Enter only, after main checks the box still holds exactly
 * this) and [Edit in card] (takes it into the chat box; sending then replaces it there). The
 * agent's own suggestion (nothing typed) is shown as that, never as the person's draft, with
 * [Send suggestion] when main can take it in. Draws only: the reads, the checks and the agent's
 * rules live in `useTerminalDraft` and main.
 */
export function TerminalDraftPreview({
  view,
  notice,
  submitting,
  imported,
  onSubmit,
  onImport,
  onJump,
}: {
  /** The latest read; nothing is drawn unless it holds text (or a refusal is to be told). */
  view: ComposerDraftView | null;
  notice: string;
  submitting: boolean;
  /** The chat box holds this very text, taken in to edit. */
  imported: boolean;
  onSubmit: () => void;
  onImport: () => void;
  /** Brings the terminal to the front (offered when not all of the text can be seen). */
  onJump?: () => void;
}) {
  const { t } = useI18n();
  const p = t.terminal.preview;
  const [open, setOpen] = useState(false);
  if (view?.kind === 'suggestion') {
    const s = p.suggestion;
    const title = s.title(view.agent);
    return (
      <section className="draft-preview is-suggestion" aria-label={title}>
        <div className="draft-preview-head">
          <Sparkles size={11} />
          <strong>{title}</strong>
          <small>{p.where(view.agent)}</small>
        </div>
        <pre className="draft-preview-text">{view.text}</pre>
        <small>{view.submittable ? s.hint(view.agent) : s.partial}</small>
        {notice && (
          <small className="draft-preview-notice" role="alert">
            {notice}
          </small>
        )}
        <div className="draft-preview-bar">
          {view.submittable ? (
            <button
              type="button"
              className="draft-preview-send"
              title={s.sendTitle}
              onClick={onSubmit}
              disabled={submitting}
            >
              {submitting ? (
                <Loader size={12} className="now-spin" />
              ) : (
                <CornerDownLeft size={12} />
              )}
              {s.send}
            </button>
          ) : (
            onJump && (
              <button type="button" onClick={onJump}>
                <Terminal size={12} />
                {t.terminal.openTerminal}
              </button>
            )
          )}
        </div>
      </section>
    );
  }
  const draft = view?.kind === 'draft' ? view : null;
  if (!draft)
    return notice ? (
      <small className="draft-preview-notice draft-preview-alone" role="alert">
        {notice}
      </small>
    ) : null;
  const long = draftIsLong(draft.text);
  return (
    <section className="draft-preview" aria-label={p.title}>
      <div className="draft-preview-head">
        <Terminal size={11} />
        <strong>{p.title}</strong>
        <small>{p.where(draft.agent)}</small>
      </div>
      <pre className={`draft-preview-text ${long && !open ? 'is-clamped' : ''}`}>{draft.text}</pre>
      {long && (
        <button
          type="button"
          className="draft-preview-more"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? p.collapse : p.expand}
        </button>
      )}
      {draft.partial && (
        <small>{draft.maybeSuggestion ? p.partialMaybeSuggestion : p.partial}</small>
      )}
      {!draft.partial && draft.maybeSuggestion && (
        <small>{draft.acceptsSuggestion ? p.maybeSuggestionSend : p.maybeSuggestion}</small>
      )}
      {imported && <small>{p.imported}</small>}
      {!draft.partial && draft.logical === undefined && <small>{p.notImportable}</small>}
      {notice && (
        <small className="draft-preview-notice" role="alert">
          {notice}
        </small>
      )}
      <div className="draft-preview-bar">
        {draft.partial ? (
          onJump && (
            <button type="button" onClick={onJump}>
              <Terminal size={12} />
              {t.terminal.openTerminal}
            </button>
          )
        ) : (
          <>
            {!imported && (
              <button
                type="button"
                title={p.importTitle}
                onClick={onImport}
                disabled={submitting || draft.logical === undefined}
              >
                <PencilLine size={12} />
                {p.import}
              </button>
            )}
            <button
              type="button"
              className="draft-preview-send"
              title={draft.acceptsSuggestion ? p.sendMaybeSuggestionTitle : p.sendTitle}
              onClick={onSubmit}
              disabled={submitting || !draft.submittable}
            >
              {submitting ? (
                <Loader size={12} className="now-spin" />
              ) : (
                <CornerDownLeft size={12} />
              )}
              {p.send}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
