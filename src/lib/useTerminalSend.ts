import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/**
 * The desktop opt-in for typing into terminals, and the send used by quick replies. Shared by
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
  const toggle = async () => {
    try {
      setEnabled(await api.terminalSend!(!enabled));
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const on = enabled && !demo;
  const sendReply =
    on && api.send
      ? async (id: string, text: string) => {
          try {
            notify(await api.send!(id, text));
          } catch (e) {
            // Also shown in the reply box; the toast survives if the box is gone.
            notify((e as Error).message);
            throw e;
          }
        }
      : undefined;
  return { enabled: on, available: !!api.terminalSend && !demo, toggle, reload, sendReply };
}
