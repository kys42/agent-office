import { useCallback, useEffect, useState } from 'react';
import type { AnswerChoice, PromptView, TerminalTarget } from '../shared/types';
import { api, isDesktop } from './api';
import { isPageHidden, onPageVisibility } from './visibility';

/**
 * The dialog on a calling session's terminal, as the desktop app reads and checks it against
 * the open request (`eventId`). Read when the request or the target changes and every few
 * seconds while the card shows it, so the buttons follow the screen. Null while not asked
 * (web preview, no terminal, demo) or still reading.
 */
export function usePrompt(
  sessionId: string,
  eventId: string | undefined,
  target: TerminalTarget | null,
  enabled: boolean,
) {
  const active = enabled && isDesktop && !!api.prompt && !!eventId && !!target && !target.queues;
  const [view, setView] = useState<{ key: string; view: PromptView } | null>(null);
  const [tick, setTick] = useState(0);
  const key = `${sessionId}\n${eventId ?? ''}`;
  useEffect(() => {
    if (!active) return;
    let valid = true;
    api.prompt!(sessionId)
      .then((found) => {
        if (valid) setView({ key, view: found });
      })
      .catch(() => {
        /* the next look tries again */
      });
    return () => {
      valid = false;
    };
  }, [active, key, target?.status, tick]);
  useEffect(() => {
    if (!active) return;
    const look = () => {
      if (!isPageHidden()) setTick((n) => n + 1);
    };
    const timer = setInterval(look, 5000);
    const stop = onPageVisibility(look);
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [active]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { view: active && view?.key === key ? view.view : null, refresh };
}

/** Sends an answer through the desktop app; the result (or refusal) goes to `notify`. */
export async function answerPrompt(
  sessionId: string,
  choice: AnswerChoice,
  notify: (message: string) => void,
): Promise<boolean> {
  try {
    const result = await api.answer!(sessionId, choice);
    if (result.status === 'answered') notify(result.message);
    return result.status === 'answered';
  } catch (e) {
    notify((e as Error).message);
    return false;
  }
}
