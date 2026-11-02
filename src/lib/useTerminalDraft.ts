import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComposerDraftView } from '../shared/types';
import { api } from './api';
import { DRAFT_POLL, nextDraftDelay, sameDraftView } from './terminalDraft';
import { isPageShown, onPageVisibility } from './visibility';

/**
 * What sits in a colleague's terminal input box, read by the desktop app while `active` (the
 * card is open, its window shown, sending is on and the terminal takes input): every 2.5 s after
 * a change, slower while nothing changes, never while the window is hidden. Main caches each
 * read briefly, so several windows on the same colleague share one screen read.
 *
 * `submit` sends the box's text as it is (main presses Enter only while the box still holds
 * exactly that text); `onSubmitted` then gets that text as read, and as typed when the screen
 * could tell (`logical`), for the "sent" receipt.
 */
export function useTerminalDraft(
  id: string | null,
  active: boolean,
  options: {
    notify: (message: string) => void;
    onSubmitted: (text: string, startedAt: number, logical?: string) => void;
  },
) {
  const [view, setView] = useState<ComposerDraftView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const refreshRef = useRef<() => void>(() => {});
  /** The view on screen, as the poll last compared it (a submit's own answer counts too). */
  const last = useRef<ComposerDraftView | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const on = active && !!id && !!api.composerDraft;
  useEffect(() => {
    setView(null);
    setNotice('');
    if (!on) return;
    let valid = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let again = false;
    let delay: number = DRAFT_POLL.base;
    last.current = null;
    const stopTimer = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const read = async () => {
      stopTimer();
      // A hidden window reads nothing; showing it again reads at once.
      if (!valid || !isPageShown()) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      let next: ComposerDraftView;
      try {
        next = await api.composerDraft!(id!);
      } catch {
        next = { kind: 'unknown', reason: 'unreadable' };
      }
      running = false;
      if (!valid) return;
      const changed = !sameDraftView(last.current, next);
      last.current = next;
      if (changed) {
        setView(next);
        // The text a refusal was about is gone: so is the note.
        if (next.kind !== 'draft') setNotice('');
      }
      delay = nextDraftDelay(delay, changed, next);
      if (again) {
        again = false;
        delay = DRAFT_POLL.base;
        void read();
        return;
      }
      if (!timer && isPageShown()) timer = setTimeout(() => void read(), delay);
    };
    const now = () => {
      delay = DRAFT_POLL.base;
      void read();
    };
    refreshRef.current = now;
    now();
    const stop = onPageVisibility(() => (isPageShown() ? now() : stopTimer()));
    // Back from the terminal (where the box was edited): read at once.
    window.addEventListener('focus', now);
    return () => {
      valid = false;
      stopTimer();
      stop();
      window.removeEventListener('focus', now);
      refreshRef.current = () => {};
    };
  }, [on, id]);
  const refresh = useCallback(() => refreshRef.current(), []);
  const submit = async () => {
    if (!id || !api.submitDraft || submitting) return;
    if (view?.kind !== 'draft' || !view.submittable) return;
    const { text, logical } = view;
    const startedAt = Date.now();
    setSubmitting(true);
    setNotice('');
    try {
      const result = await api.submitDraft(id, text);
      if (result.status === 'sent') {
        latest.current.notify(result.message);
        latest.current.onSubmitted(text, startedAt, logical);
        last.current = { kind: 'empty' };
        setView(last.current);
      } else {
        setNotice(result.message);
        last.current = result.draft;
        setView(result.draft);
      }
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setSubmitting(false);
      refresh();
    }
  };
  return {
    /** The latest read while active; null while inactive or not read yet. */
    view: on ? view : null,
    submitting,
    /** Why the last [Send as is] did not go (the box changed, a refusal). */
    notice: on ? notice : '',
    submit,
    refresh,
  };
}
