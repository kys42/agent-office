import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { FederationCommand, FederationState, PeerInput } from '../shared/federation';

export function FederationSettings({ snapshot }: { snapshot?: FederationState }) {
  const { t } = useI18n();
  const f = t.federation;
  const [state, setState] = useState<FederationState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    if (snapshot) {
      setState(snapshot);
      return;
    }
    void api.federation?.({ action: 'state' }).then(
      (s) => active && setState(s),
      () => {},
    );
    return () => {
      active = false;
    };
  }, [snapshot]);
  if (!api.federation || !state) return null;
  const command = async (value: FederationCommand) => {
    setBusy(true);
    setError('');
    try {
      setState(await api.federation!(value));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section federation-settings">
      <h2>
        {f.title} <small>{f.beta}</small>
      </h2>
      <p>{f.hint}</p>
      <div className="setting-row">
        <b>{f.enable}</b>
        <button
          className={`toggle ${state.enabled ? 'on' : ''}`}
          role="switch"
          aria-label={f.enable}
          aria-checked={state.enabled}
          disabled={busy}
          onClick={() => void command({ action: 'enable', enabled: !state.enabled })}
        >
          <span />
        </button>
      </div>
      {(error || state.error) && <p role="alert">{error || state.error}</p>}
      {!state.enabled ? (
        <p>{f.disabled}</p>
      ) : (
        <>
          <label>
            {f.import}
            <input
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={async (e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                if (!file) return;
                try {
                  if (file.size > 30000) throw new Error(f.invalid);
                  const peer = JSON.parse(await file.text()) as PeerInput;
                  await command({ action: 'add', peer });
                } catch {
                  setError(f.invalid);
                }
              }}
            />
          </label>
          <p>{f.importHint}</p>
          {!state.peers.length && <p>{f.empty}</p>}
          {state.peers.map((peer) => (
            <form
              key={JSON.stringify([peer.officeId, peer.label, peer.tags, peer.projects])}
              className="connector-card"
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                try {
                  const entries = String(data.get('projects'))
                    .split('\n')
                    .filter((x) => x.trim())
                    .map((line) => {
                      const at = line.indexOf('=');
                      if (at < 1 || !line.slice(at + 1).trim()) throw new Error(f.invalid);
                      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
                    });
                  void command({
                    action: 'update',
                    officeId: peer.officeId,
                    label: String(data.get('label')),
                    tags: String(data.get('tags'))
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                    projects: Object.fromEntries(entries),
                  });
                } catch {
                  setError(f.invalid);
                }
              }}
            >
              <b>
                {f[peer.state]} · {f.count(peer.count)} ·{' '}
                {peer.canSend ? f.sendPermission : f.readPermission}
              </b>
              <p>
                <code>{peer.endpoint}</code>
              </p>
              {peer.error && <p role="status">{peer.error}</p>}
              <label>
                {f.label}
                <input name="label" defaultValue={peer.label} maxLength={80} required />
              </label>
              <label>
                {f.tags}
                <input name="tags" defaultValue={peer.tags.join(', ')} />
              </label>
              <label>
                {f.projects}
                <textarea
                  name="projects"
                  rows={2}
                  defaultValue={Object.entries(peer.projects)
                    .map(([a, b]) => `${a} = ${b}`)
                    .join('\n')}
                />
              </label>
              <div className="setting-row">
                <button disabled={busy} type="submit">
                  {f.save}
                </button>
                <button
                  disabled={busy}
                  type="button"
                  onClick={() => void command({ action: 'remove', officeId: peer.officeId })}
                >
                  {f.remove}
                </button>
              </div>
            </form>
          ))}
        </>
      )}
    </section>
  );
}
