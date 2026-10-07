import { useEffect, useRef, useState } from 'react';
import { RefreshCw, X, Gauge } from 'lucide-react';
import { api } from '../lib/api';
import { PROVIDERS, type ProviderQuota } from '../shared/types';
import { ago } from '../lib/format';
import { intlLocale, m } from '../shared/i18n';
import { useI18n } from '../lib/i18n';
const demoQuotas = (): ProviderQuota[] => {
  const t = m().usage.demo;
  return ['claude', 'codex'].map((p, i) => ({
    provider: p as 'claude' | 'codex',
    state: 'ok',
    source: t.source,
    checkedAt: Date.now(),
    message: t.message,
    windows: [
      { key: '5h', label: t.fiveHours, usedPercent: 27 + i * 16, resetsAt: Date.now() + 7200_000 },
      {
        key: 'week',
        label: t.week,
        usedPercent: 61 - i * 15,
        resetsAt: Date.now() + 86400_000 * 3,
      },
    ],
  }));
};
export function UsagePanel({
  demo,
  privacy,
  onClose,
}: {
  demo: boolean;
  privacy: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const u = t.usage;
  const [data, setData] = useState<ProviderQuota[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    // On phones the dock follows the room in the page flow; bring it into view like the inspector.
    if (window.matchMedia('(max-width: 860px)').matches)
      panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  // Limits are checked only when the panel opens or on refresh — never just because the language
  // changed. Demo numbers are local, so they are rebuilt at render and follow the language.
  useEffect(() => {
    let alive = true;
    if (privacy) return;
    setBusy(true);
    setError(false);
    (demo ? Promise.resolve(demoQuotas()) : api.quotas())
      .then((value) => {
        if (alive) setData(value);
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [demo, privacy, refresh]);
  const quotas = demo && data.length ? demoQuotas() : data;
  return (
    <aside className="inspector usage-dock" aria-label={u.title} ref={panelRef}>
      <header>
        <div>
          <small>OFFICE ENERGY</small>
          <h2>
            <Gauge size={21} /> {u.title}
          </h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label={u.close}>
          <X size={19} />
        </button>
      </header>
      {privacy ? (
        <p>{u.privacy}</p>
      ) : (
        <>
          <p className="usage-intro">
            {u.intro}
            <br />
            {u.introDetail}
          </p>
          <button className="button" disabled={busy} onClick={() => setRefresh((n) => n + 1)}>
            <RefreshCw size={14} className={busy ? 'spin' : ''} />
            {busy ? u.checking : u.recheck}
          </button>
          {busy && !quotas.length && <p role="status">{u.loading}</p>}
          {error && <p role="alert">{u.error}</p>}
          {!busy && !error && !quotas.length && <p>{u.empty}</p>}
          {quotas.map((q) => (
            <section className="quota-card" key={q.provider}>
              <div className="quota-title">
                <b>{PROVIDERS[q.provider].name}</b>
                <span>
                  {q.state === 'ok' ? u.account : q.state === 'error' ? u.failed : u.unavailable}
                </span>
              </div>
              {q.windows.map((w) => {
                const expired = w.resetsAt !== null && w.resetsAt <= Date.now();
                return (
                  <div className="quota-window" key={w.key}>
                    <div>
                      <span>{w.label}</span>
                      <strong>
                        {expired ? u.expired : u.left(Math.round((100 - w.usedPercent) * 10) / 10)}
                      </strong>
                    </div>
                    <progress
                      aria-label={u.remainingAria(PROVIDERS[q.provider].name, w.label)}
                      value={expired ? 0 : 100 - w.usedPercent}
                      max={100}
                    />
                    <small>
                      {w.resetsAt
                        ? u.resets(
                            new Date(w.resetsAt).toLocaleString(intlLocale(), {
                              month: 'numeric',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            }),
                          )
                        : u.noReset}
                    </small>
                  </div>
                );
              })}
              <p>{q.message}</p>
              <small>
                {q.source} · {u.checked(ago(q.checkedAt))}
              </small>
            </section>
          ))}
          <p className="fine-print">{u.fine}</p>
        </>
      )}
    </aside>
  );
}
