import { useCallback, useEffect, useState } from 'react';
import type { AnswerSettings } from '../shared/types';
import { api } from './api';
import { followDesktopSettings } from './desktop-settings';

const UNSET: AnswerSettings = { questions: 'unset', permissions: 'unset' };

/**
 * The desktop settings for answering prompts from the app: never asked, on, or off (both off
 * until the person agrees).
 * Kept in the desktop profile (office:answer-settings), never in the shared preferences; turning
 * one on goes through a native confirmation in the main process.
 */
export function useAnswerSettings(demo: boolean, notify: (message: string) => void) {
  const [settings, setSettings] = useState<AnswerSettings>(UNSET);
  const reload = useCallback(() => {
    api
      .answerSettings?.()
      .then(setSettings)
      .catch(() => setSettings(UNSET));
  }, []);
  useEffect(reload, [reload]);
  // A change from another window (or a first answer from a card) shows here too.
  useEffect(() => followDesktopSettings(api, window, reload), [reload]);
  const toggle = async (key: keyof AnswerSettings) => {
    try {
      setSettings(await api.answerSettings!({ [key]: settings[key] !== 'on' }));
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return { settings, available: !!api.answerSettings && !demo, toggle, reload };
}
