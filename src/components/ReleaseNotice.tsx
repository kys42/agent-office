import { useEffect, useState } from 'react';
import { ArrowUpRight, Download } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';

const dismissed = 'office:dismissed-release';

/** `enabled`: Settings › General › Updates. Off asks nothing and hides a notice already shown. */
export function ReleaseNotice({ enabled }: { enabled: boolean }) {
  const { t } = useI18n();
  const [release, setRelease] = useState<{ version: string; url: string } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void api
      .startupRelease?.()
      .then((next) => {
        if (!active || !next) return;
        try {
          if (localStorage.getItem(dismissed) === next.version) return;
        } catch {
          /* Storage may be unavailable. */
        }
        setRelease(next);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [enabled]);
  if (!enabled || !release) return null;
  return (
    <div className="release-banner" role="status">
      <Download size={15} aria-hidden="true" />
      <span>{t.app.releaseNotice.available(release.version)}</span>
      <button onClick={() => void api.openLink?.(release.url)}>
        {t.app.releaseNotice.view} <ArrowUpRight size={13} />
      </button>
      <button
        onClick={() => {
          try {
            localStorage.setItem(dismissed, release.version);
          } catch {
            /* Still dismiss for this visit. */
          }
          setRelease(null);
        }}
      >
        {t.app.releaseNotice.dismiss}
      </button>
    </div>
  );
}
