import { useEffect, useState } from 'react';
import { CheckCircle2, Copy, ExternalLink, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { AppHealth as Health, PrivacyPane } from '../shared/app-health';
import './app-health.css';

export function AppHealth({
  active,
  notify,
}: {
  active: boolean;
  notify: (message: string) => void;
}) {
  const { t } = useI18n();
  const c = t.settings.appHealth;
  const [info, setInfo] = useState<Health | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!active || !api.appHealth) return;
    let alive = true;
    setFailed(false);
    void api.appHealth().then(
      (value) => {
        if (alive) setInfo(value);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [active, attempt]);
  if (!api.appHealth) return null;
  const trusted = info?.signature === 'developer-id';
  const copy = async () => {
    if (!info) return;
    try {
      const text = JSON.stringify(info, null, 2);
      await (api.copyText ? api.copyText(text) : navigator.clipboard.writeText(text));
      setCopied(true);
    } catch {
      notify(c.copyFailed);
    }
  };
  const open = async (pane: PrivacyPane) => {
    try {
      await api.openPrivacy?.(pane);
    } catch {
      notify(c.openFailed);
    }
  };
  return (
    <section className="settings-section app-health" aria-labelledby="app-health-title">
      <div className="section-title">
        <h2 id="app-health-title">{c.title}</h2>
        {info && <span className="app-health-version">v{info.version}</span>}
      </div>
      {!info && <p role="status">{failed ? c.failed : c.loading}</p>}
      {failed && (
        <button className="button subtle" onClick={() => setAttempt((x) => x + 1)}>
          {c.retry}
        </button>
      )}
      {info && (
        <>
          <div className={`app-health-signature ${trusted ? 'verified' : ''}`}>
            {trusted ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}
            <div>
              <strong>{c.signatures[info.signature]}</strong>
              <p>{trusted ? c.signedHint : c.previewHint}</p>
            </div>
          </div>
          <dl className="app-health-details">
            <div>
              <dt>{c.build}</dt>
              <dd>{info.commit?.slice(0, 7) ?? c.unknown}</dd>
            </div>
            <div>
              <dt>{c.platform}</dt>
              <dd>
                {info.platform} · {info.arch}
              </dd>
            </div>
            {info.teamId && (
              <div>
                <dt>{c.team}</dt>
                <dd>{info.teamId}</dd>
              </div>
            )}
          </dl>
          <button className="button subtle" onClick={copy}>
            {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
            {copied ? c.copied : c.copy}
          </button>
          <p className="app-health-footnote">{c.safeCopy}</p>
          {info.platform === 'darwin' && api.openPrivacy && (
            <details className="app-health-permissions">
              <summary>{c.permissions}</summary>
              <p>{c.permissionHint}</p>
              <ul>
                {(['files', 'network', 'accessibility'] as const).map((pane) => (
                  <li key={pane}>
                    <div>
                      <strong>{c.panes[pane].title}</strong>
                      <p>{c.panes[pane].hint}</p>
                    </div>
                    <button
                      className="button subtle"
                      onClick={() => open(pane)}
                      aria-label={`${c.panes[pane].title} ${c.open}`}
                    >
                      <ExternalLink size={14} />
                      {c.open}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="app-health-footnote">{c.restartHint}</p>
            </details>
          )}
        </>
      )}
    </section>
  );
}
