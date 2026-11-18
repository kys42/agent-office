import { m } from '../shared/i18n';
import { useEffect, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { MobileCommand, MobileSettings as State } from '../shared/mobile';
import './mobile-settings.css';
export function MobileSettings({ privacy }: { privacy: boolean }) {
  const { locale } = useI18n();
  const ko = locale === 'ko';
  const [state, setState] = useState<State | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [show, setShow] = useState(false);
  const [address, setAddress] = useState('127.0.0.1'),
    [port, setPort] = useState(4321);
  const accept = (s: State) => {
    setState(s);
    setAddress(s.address);
    setPort(s.port);
  };
  useEffect(() => {
    let active = true;
    void api.mobile?.({ action: 'state' }).then(
      (s) => {
        if (active) accept(s);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);
  if (!api.mobile || !state) return null;
  const command = async (value: MobileCommand) => {
    setBusy(true);
    setError('');
    try {
      accept(await api.mobile!(value));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async (value: string) => {
    try {
      await api.copyText!(value);
    } catch {
      setError(ko ? m().mobile.copyFailed : 'Could not copy.');
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
          disabled={busy}
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
            disabled={busy || state.running}
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
            disabled={busy || state.running}
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
              disabled={busy}
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
          disabled={busy}
          onClick={() => void command({ action: 'configure', enabled: true, address, port })}
        >
          {ko ? m().mobile.retry : 'Retry'}
        </button>
      )}
      {(error || state.error) && <p role="alert">{error || state.error}</p>}
    </section>
  );
}
