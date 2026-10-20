import { useCallback, useEffect, useState } from 'react';
import type { ReplySender, SendResult } from '../shared/types';
import { m } from '../shared/i18n';
import { api } from './api';
import { followDesktopSettings } from './desktop-settings';

/**
 * Sends a follow-up through the desktop app and reports a finished send (and, when the agent's
 * composer text was cleared for it, that the text is on the clipboard). Text found in the
 * composer comes back as `needs-confirm` for the reply box to ask about; nothing was typed.
 */
export async function sendFollowUp(
  id: string,
  text: string,
  replaceDraft: string | undefined,
  notify: (message: string) => void,
  allowPartialDraft?: boolean,
): Promise<SendResult> {
  let result: SendResult;
  try {
    result = await api.send!(
      id,
      text,
      replaceDraft === undefined
        ? undefined
        : { replaceDraft, ...(allowPartialDraft && { allowPartialDraft: true }) },
    );
  } catch (error) {
    // A failed paste/submit or an older refusal may have left text in the composer. Reading
    // it again offers a manual decision, never a blind resend or an automatic clearing.
    const draft = await api.inspectDraft?.(id).catch(() => null);
    if (!draft) throw error;
    return { ...draft, reason: (error as Error).message };
  }
  if (result.status === 'sent')
    notify(
      result.cleared
        ? `${result.message} · ${result.partialBackup ? m().terminal.partialClearedToClipboard : m().terminal.clearedToClipboard}`
        : result.message,
    );
  return result;
}

/**
 * The desktop setting (on by default) for typing into terminals, and the send used by quick replies. Shared by
 * the big office and the dock card so both read the same setting the same way. The setting
 * lives in the desktop profile (office:terminal-send), never in the shared preferences.
 */
export function useTerminalSend(demo: boolean, notify: (message: string) => void) {
  const [enabled, setEnabled] = useState(false);
  const reload = useCallback(() => {
    api
      .terminalSend?.()
      .then(setEnabled)
      .catch(() => setEnabled(false));
  }, []);
  useEffect(reload, [reload]);
  // A change from another window (or a first answer from a card) shows here too.
  useEffect(() => followDesktopSettings(api, window, reload), [reload]);
  const toggle = async () => {
    try {
      setEnabled(await api.terminalSend!(!enabled));
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const on = enabled && !demo;
  const sendReply: ReplySender | undefined =
    on && api.send
      ? async (id, text, replaceDraft, allowPartialDraft) => {
          try {
            return await sendFollowUp(id, text, replaceDraft, notify, allowPartialDraft);
          } catch (e) {
            // Also shown in the reply box; the toast survives if the box is gone.
            notify((e as Error).message);
            throw e;
          }
        }
      : undefined;
  return { enabled: on, available: !!api.terminalSend && !demo, toggle, reload, sendReply };
}
