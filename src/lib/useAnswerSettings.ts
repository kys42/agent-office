import { useCallback, useEffect, useState } from 'react';
import type { AnswerSettings } from '../shared/types';
import { api } from './api';

const OFF: AnswerSettings = { questions: false, permissions: false };

/**
 * The desktop settings for answering prompts from the app (both off until the person agrees).
 * Kept in the desktop profile (office:answer-settings), never in the shared preferences; turning
 * one on goes through a native confirmation in the main process.
 */
export function useAnswerSettings(demo: boolean, notify: (message: string) => void) {
  const [settings, setSettings] = useState<AnswerSettings>(OFF);
  const reload = useCallback(() => {
    api
      .answerSettings?.()
      .then(setSettings)
      .catch(() => setSettings(OFF));
  }, []);
  useEffect(reload, [reload]);
  const toggle = async (key: keyof AnswerSettings) => {
    try {
      setSettings(await api.answerSettings!({ [key]: !settings[key] }));
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return { settings, available: !!api.answerSettings && !demo, toggle, reload };
}
