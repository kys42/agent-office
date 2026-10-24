import { useEffect, useId, useRef, useState } from 'react';
import type { Session } from '../shared/types';
import { sessionTitleSchema, type SessionTitleInfo } from '../shared/session-title';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';

/** Inline, explicit source mutation. Opening the editor only checks availability. */
export function SessionTitleEditor({
  session,
  onClose,
  notify,
}: {
  session: Session;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const { t } = useI18n();
  const text = t.inspector.sessionTitle;
  const inputId = useId();
  const [info, setInfo] = useState<SessionTitleInfo>();
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const alive = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (info?.available) input.current?.focus();
  }, [info?.available]);
  useEffect(() => {
    let live = true;
    void api.sessionTitle!(session.id)
      .then((value) => {
        if (live) {
          setInfo(value);
          if (value.available) setTitle(value.title);
        }
      })
      .catch(() => {
        if (live)
          setInfo({
            available: false,
            title: session.title,
            reason: 'connection',
            status: 'ready',
          });
      });
    return () => {
      live = false;
    };
  }, [session.id]);
  return (
    <form
      className="session-title-editor"
      aria-label={text.action}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!info?.available || busy || uncertain || !sessionTitleSchema.safeParse(title).success)
          return;
        setBusy(true);
        try {
          const result = await api.sessionTitle!(session.id, {
            title: title.trim(),
            expected: info.title,
            requestId: crypto.randomUUID(),
          });
          if (!alive.current) return;
          if (result.status === 'renamed') {
            notify(text.saved);
            onClose();
          } else if (result.status === 'uncertain') setUncertain(true);
          else setInfo(result);
        } catch {
          if (alive.current) setUncertain(true);
        } finally {
          if (alive.current) setBusy(false);
        }
      }}
    >
      <label htmlFor={inputId}>{text.action}</label>
      <p>
        {session.remote ? `${session.remote.label} · ` : ''}
        {text.hint}
      </p>
      {session.alias && <p>{text.aliasHint}</p>}
      <input
        ref={input}
        id={inputId}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        maxLength={120}
        disabled={!info?.available || busy || uncertain}
        autoComplete="off"
      />
      <p role="status">
        {uncertain
          ? text.uncertain
          : !info
            ? text.checking
            : !info.available
              ? text[info.reason ?? 'unsupported']
              : text.limit}
      </p>
      <div className="session-title-actions">
        <button type="button" className="button subtle" onClick={onClose} disabled={busy}>
          {text.cancel}
        </button>
        <button
          type="submit"
          className="button primary"
          disabled={
            !info?.available ||
            busy ||
            uncertain ||
            title.trim() === info.title ||
            !sessionTitleSchema.safeParse(title).success
          }
        >
          {busy ? text.saving : text.save}
        </button>
      </div>
    </form>
  );
}
