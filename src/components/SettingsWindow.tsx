import { useCallback, useEffect, useRef, useState } from 'react';
import { api, isDesktop } from '../lib/api';
import { useOffice } from '../lib/useOffice';
import { useTerminalSend } from '../lib/useTerminalSend';
import { useAnswerSettings } from '../lib/useAnswerSettings';
import { useI18n } from '../lib/i18n';
import { isWindows } from '../lib/platform';
import { settingsHashSection, type SettingsSection } from '../shared/settings';
import { PetAppearanceContext } from './PetAppearanceContext';
import { Settings } from './Settings';

/**
 * The settings window (`#settings`): the same office core and the same Settings as the big
 * office's page, drawn with top tabs. It does not close on blur — the native close button,
 * or the window manager, closes it.
 */
export function SettingsWindow() {
  const { t } = useI18n();
  const [toast, setToast] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(''), 3600);
  }, []);
  const { snapshot, setPrefs, refresh } = useOffice(false, notify);
  const send = useTerminalSend(false, notify);
  const answers = useAnswerSettings(false, notify);
  const [focus, setFocus] = useState<{ section: SettingsSection; at: number } | undefined>(() => {
    const section = settingsHashSection(location.hash);
    return section ? { section, at: Date.now() } : undefined;
  });
  const clearFocus = useCallback(() => setFocus(undefined), []);
  const { reload: reloadSend } = send;
  const { reload: reloadAnswers } = answers;
  // Opened again (tray, palette, a deep link): go to that section and re-read the desktop
  // settings (other windows' changes also arrive through onDesktopSettings).
  useEffect(
    () =>
      api.settings?.onOpen((section) => {
        if (section) setFocus({ section, at: Date.now() });
        reloadSend();
        reloadAnswers();
      }),
    [reloadSend, reloadAnswers],
  );
  useEffect(() => {
    const follow = () => {
      const section = settingsHashSection(location.hash);
      if (section) setFocus({ section, at: Date.now() });
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  useEffect(() => {
    document.title = t.settings.window.title;
  }, [t]);
  useEffect(() => {
    const body = document.body.classList;
    body.add('settings-mode');
    body.toggle('is-desktop', isDesktop);
    body.toggle('is-mac', isDesktop && /Mac/i.test(navigator.userAgent));
    body.toggle('is-windows', isDesktop && isWindows);
    return () => body.remove('settings-mode');
  }, []);
  const prefs = snapshot?.preferences;
  return (
    <PetAppearanceContext.Provider value={prefs?.petAppearance}>
      {/* Reduced motion follows the shared preference live, as in the big office. */}
      <div className={`settings-window${prefs?.reducedMotion ? ' reduce-motion' : ''}`}>
        <header className="settings-window-bar">
          <b>{t.settings.window.title}</b>
        </header>
        {snapshot ? (
          <Settings
            layout="popup"
            snapshot={snapshot}
            onPrefs={setPrefs}
            onRefresh={refresh}
            notify={notify}
            terminalSend={send.available ? send.enabled : undefined}
            onTerminalSend={send.toggle}
            answers={answers.available ? answers.settings : undefined}
            onAnswers={(key) => void answers.toggle(key)}
            focusSection={focus}
            onSectionFocused={clearFocus}
          />
        ) : (
          <p className="settings-window-opening">{t.settings.window.opening}</p>
        )}
        {toast && (
          <div className="toast" role="status">
            <span className="live-dot" />
            {toast}
          </div>
        )}
      </div>
    </PetAppearanceContext.Provider>
  );
}
