import { useCallback, useEffect, useRef, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { ManagerRequest, ManagerSettings, ManagerState } from '../shared/manager';
import '../styles/manager.css';

/** Role settings only. Conversation, drafts, windows and receipts use the ordinary Inspector. */
export function Manager({ demo, notify }: { demo: boolean; notify: (text: string) => void }) {
  const { t, locale } = useI18n();
  const m = t.manager;
  const [state, setState] = useState<ManagerState>();
  const [settings, setSettings] = useState<ManagerSettings>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const enabled = !!api.manager && !demo;
  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const next = await api.manager!({ action: 'status' });
      if (!mounted.current) return;
      setState(next);
      setSettings((previous) => previous ?? next.settings);
      setError('');
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  }, [enabled]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 2000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  const run = async (request: ManagerRequest) => {
    setPending(true);
    setError('');
    try {
      const next = await api.manager!(request);
      if (mounted.current) setState(next);
      return true;
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
      return false;
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const format = (at: number) =>
    new Date(at).toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  return (
    <section className="manager-page" aria-label={m.configure}>
      {!enabled ? (
        <div className="manager-note">{demo ? m.demoOnly : m.desktopOnly}</div>
      ) : (
        <>
          {error && (
            <div role="alert" className="manager-error">
              {error}
              <button className="button subtle" onClick={() => void refresh()}>
                {m.refresh}
              </button>
            </div>
          )}
          {state && settings && (
            <details className="manager-settings" open>
              <summary>
                <Settings2 size={16} /> {m.configure}
              </summary>
              <p>{m.setup}</p>
              {(!state.availability.tmux || !state.availability[settings.provider]) && (
                <p className="manager-error">{m.missing}</p>
              )}
              <div className="manager-settings-grid">
                <label>
                  {m.provider}
                  <select
                    value={settings.provider}
                    disabled={state.running || pending}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        provider: e.target.value as ManagerSettings['provider'],
                      })
                    }
                  >
                    <option value="codex">
                      Codex{!state.availability.codex ? ` · ${m.noProvider}` : ''}
                    </option>
                    <option value="claude">
                      Claude Code{!state.availability.claude ? ` · ${m.noProvider}` : ''}
                    </option>
                  </select>
                </label>
                <label>
                  {m.schedule}
                  <select
                    value={settings.schedule.kind}
                    disabled={pending}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        schedule:
                          e.target.value === 'daily'
                            ? { kind: 'daily', time: '09:00' }
                            : e.target.value === 'hourly'
                              ? { kind: 'hourly', hours: 1 }
                              : { kind: 'off' },
                      })
                    }
                  >
                    <option value="off">{m.off}</option>
                    <option value="hourly">{m.hourly}</option>
                    <option value="daily">{m.daily}</option>
                  </select>
                </label>
                {settings.schedule.kind === 'hourly' && (
                  <label>
                    {m.hours}
                    <input
                      type="number"
                      min={1}
                      max={24}
                      value={settings.schedule.hours}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          schedule: { kind: 'hourly', hours: Number(e.target.value) },
                        })
                      }
                    />
                  </label>
                )}
                {settings.schedule.kind === 'daily' && (
                  <label>
                    {m.time}
                    <input
                      type="time"
                      value={settings.schedule.time}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          schedule: { kind: 'daily', time: e.target.value },
                        })
                      }
                    />
                  </label>
                )}
              </div>
              <label className="manager-check">
                <input
                  type="checkbox"
                  checked={settings.notifications}
                  onChange={(e) => setSettings({ ...settings, notifications: e.target.checked })}
                />
                {m.notifications}
              </label>
              <p className="manager-hint">{m.scheduleNote}</p>
              <div className="manager-controls">
                <button
                  className="button"
                  disabled={pending}
                  onClick={async () => {
                    if (await run({ action: 'configure', settings })) notify(m.saved);
                  }}
                >
                  {m.save}
                </button>
                <button
                  className="button primary"
                  disabled={pending}
                  onClick={async () => {
                    if (state.running) await run({ action: 'stop' });
                    else if (await run({ action: 'configure', settings }))
                      await run({ action: 'start' });
                  }}
                >
                  {state.running ? m.stop : m.start}
                </button>
              </div>
            </details>
          )}
          {state?.nextRunAt && state.running && (
            <p className="manager-hint">
              {m.next}: {format(state.nextRunAt)}
            </p>
          )}
        </>
      )}
    </section>
  );
}
