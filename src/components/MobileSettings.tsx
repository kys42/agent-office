import { m } from '../shared/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { MobileCommand, MobileSettings as State } from '../shared/mobile';
import './mobile-settings.css';
/** Same as the toasts in the dock, cards and settings window. */
const NOTICE_MS = 3600;
export function MobileSettings({ privacy }: { privacy: boolean }) {
  const { locale } = useI18n();
  const ko = locale === 'ko';
  const [state, setState] = useState<State | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [show, setShow] = useState(false);
  const mounted = useRef(true),
    requestVersion = useRef(0),
    noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Like the app's other toasts: a confirmation that clears itself instead of lingering.
  const flash = useCallback((text: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = text ? setTimeout(() => setNotice(''), NOTICE_MS) : null;
    setNotice(text);
  }, []);
  const [address, setAddress] = useState('127.0.0.1'),
    [port, setPort] = useState(4321);
  const accept = (s: State) => {
    setState(s);
    setAddress(s.address);
    setPort(s.port);
  };
  const reload = useCallback(async () => {
    if (!api.mobile) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setError('');
    try {
      const next = await api.mobile({ action: 'state' });
      if (mounted.current && version === requestVersion.current) accept(next);
    } catch {
      if (mounted.current && version === requestVersion.current)
        setError(m().mobile.settingsLoadFailed);
    } finally {
      if (mounted.current && version === requestVersion.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
      requestVersion.current++;
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [reload]);
  useEffect(() => {
    if (privacy) setShow(false);
  }, [privacy]);
  if (!api.mobile) return null;
  if (!state)
    return (
      <section className="settings-section mobile-settings">
        <h2>
          <Smartphone size={18} /> {m().mobile.settingsTitle}
        </h2>
        {loading ? (
          <p role="status">{m().mobile.loading}</p>
        ) : (
          <>
            <p role="alert">{error}</p>
            <button onClick={() => void reload()}>{m().mobile.refreshServer}</button>
          </>
        )}
      </section>
    );
  const command = async (value: MobileCommand) => {
    const version = ++requestVersion.current;
    setBusy(true);
    setError('');
    flash('');
    try {
      const next = await api.mobile!(value);
      if (mounted.current && version === requestVersion.current) accept(next);
    } catch (e) {
      if (mounted.current && version === requestVersion.current) setError((e as Error).message);
    } finally {
      if (mounted.current && version === requestVersion.current) setBusy(false);
    }
  };
  const copy = async (value: string) => {
    flash('');
    setError('');
    try {
      await api.copyText!(value);
      if (mounted.current) flash(m().mobile.copied);
    } catch {
      if (mounted.current) setError(ko ? m().mobile.copyFailed : 'Could not copy.');
    }
  };
  return (
    <section className="settings-section mobile-settings">
      <h2>
        <Smartphone size={18} /> {ko ? m().mobile.settingsTitle : 'Mobile web'}
      </h2>
      <p>
        {ko
          ? m().mobile.settingsHint
          : 'View agents, read conversations and send messages while this app is running.'}
      </p>
      <div className="mobile-server-status">
        <p role="status">
          {state.running
            ? m().mobile.serverRunning
            : state.enabled
              ? m().mobile.serverStopped
              : m().mobile.serverDisabled}
        </p>
        <button disabled={busy || loading} onClick={() => void reload()}>
          {m().mobile.refreshServer}
        </button>
      </div>
      <div className="setting-row">
        <div>
          <b>{ko ? m().mobile.enable : 'Enable web access'}</b>
          <p>
            {ko ? m().mobile.settingsTailnet : 'Connect from your tailnet with the access code.'}
          </p>
        </div>
        <button
          role="switch"
          aria-label={ko ? m().mobile.enable : 'Enable web access'}
          aria-checked={state.enabled}
          className={`toggle ${state.enabled ? 'on' : ''}`}
          disabled={busy || loading}
          onClick={() =>
            void command({ action: 'configure', enabled: !state.enabled, address, port })
          }
        >
          <span />
        </button>
      </div>
      <div className="mobile-network">
        <label>
          {ko ? m().mobile.address : 'Address'}
          <select
            aria-label={ko ? m().mobile.addressLabel : 'Mobile address'}
            value={address}
            disabled={busy || loading || state.running}
            onChange={(e) => setAddress(e.target.value)}
          >
            {[...new Set([...state.addresses, state.address])].map((a) => (
              <option key={a} value={a}>
                {a === '127.0.0.1'
                  ? ko
                    ? m().mobile.loopback
                    : 'This computer (127.0.0.1)'
                  : `Tailscale · ${a}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          {ko ? m().mobile.port : 'Port'}
          <input
            aria-label={ko ? m().mobile.portLabel : 'Mobile port'}
            type="number"
            min={1024}
            max={65535}
            value={port}
            disabled={busy || loading || state.running}
            onChange={(e) => setPort(Number(e.target.value))}
          />
        </label>
      </div>
      {state.addresses.length === 1 && (
        <p>
          {ko
            ? m().mobile.installTailnet
            : 'Connect Tailscale and reopen Settings to choose its address.'}
        </p>
      )}
      {state.url && !privacy && (
        <div className="mobile-link">
          <code>{state.url}</code>
          <button onClick={() => void copy(state.url!)}>
            {ko ? m().mobile.copyUrl : 'Copy URL'}
          </button>
        </div>
      )}
      {state.running && (
        <p>
          {ko
            ? m().mobile.exposureHint
            : 'Only the selected interface is exposed. The code grants a 12-hour session.'}
        </p>
      )}
      {state.accessCode && !privacy && (
        <div className="mobile-code">
          <label>{ko ? m().mobile.accessCode : 'Access code'}</label>
          <code>{show ? state.accessCode : '••••••••••••••••'}</code>
          <div>
            <button onClick={() => setShow(!show)}>
              {show ? (ko ? m().mobile.hide : 'Hide') : ko ? m().mobile.show : 'Show'}
            </button>
            <button onClick={() => void copy(state.accessCode!)}>
              {ko ? m().mobile.copyCode : 'Copy code'}
            </button>
            <button
              disabled={busy || loading}
              onClick={() => {
                setShow(false);
                void command({ action: 'rotate' });
              }}
            >
              {ko ? m().mobile.rotate : 'Rotate code · disconnect'}
            </button>
          </div>
        </div>
      )}
      {state.enabled && !state.running && (
        <button
          disabled={busy || loading}
          onClick={() => void command({ action: 'configure', enabled: true, address, port })}
        >
          {ko ? m().mobile.retry : 'Retry'}
        </button>
      )}
      {(error || state.error) && <p role="alert">{error || state.error}</p>}
      {notice && <p role="status">{notice}</p>}
      <details className="mobile-help">
        <summary>{m().mobile.connectionHelp}</summary>
        <ol>
          <li>{m().mobile.helpNetwork}</li>
          <li>{address === '127.0.0.1' ? m().mobile.helpLoopback : m().mobile.helpAddress}</li>
          <li>{m().mobile.helpAwake}</li>
          <li>{m().mobile.helpCode}</li>
        </ol>
        <p>{m().mobile.helpBoundary}</p>
      </details>
    </section>
  );
}
