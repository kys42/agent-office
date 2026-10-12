import { useEffect, useState, type MouseEvent } from 'react';
import { GitPullRequest, CircleDot, ArrowUpRight, LoaderCircle, ChevronDown } from 'lucide-react';
import type { Artifact } from '../shared/types';
import { parseArtifact } from '../shared/office';
import { api, isDesktop } from '../lib/api';
import { useI18n } from '../lib/i18n';
export function ArtifactCards({
  id,
  urls,
  demo,
  privacy,
  notify,
  variant = 'cards',
}: {
  id: string;
  urls: string[];
  demo: boolean;
  privacy: boolean;
  notify: (s: string) => void;
  /** `list`: the card's "recent work" — one line each, two shown, the rest behind "n more". */
  variant?: 'cards' | 'list';
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const key = urls.join('|');
  useEffect(() => {
    setExpanded(false);
    setItems(urls.map(parseArtifact).filter((x): x is Artifact => !!x));
    if (demo || privacy || !urls.length) return;
    let live = true;
    setLoading(true);
    api
      .artifacts(id)
      .then((x) => {
        if (live) setItems(x);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [id, key, demo, privacy]);
  if (privacy || !items.length) return null;
  const open = (e: MouseEvent, url: string) => {
    if (!isDesktop) return;
    e.preventDefault();
    void api.openArtifact(url).catch((err) => notify(err.message));
  };
  // Newest first: issues and PRs share one rising number per repository.
  const recent = [...items].sort((a, b) => b.number - a.number);
  if (variant === 'list')
    return (
      <section className="artifact-list" aria-label={t.artifacts.label}>
        {(expanded ? recent : recent.slice(0, 2)).map((a) => (
          <a
            className={`artifact-row artifact-${a.state || 'unknown'} kind-${a.kind}`}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            key={a.url}
            onClick={(e) => open(e, a.url)}
          >
            {a.kind === 'pull' ? <GitPullRequest size={14} /> : <CircleDot size={14} />}
            <span>
              <b>#{a.number}</b>{' '}
              {a.title ||
                (demo
                  ? a.kind === 'pull'
                    ? t.artifacts.demoPull
                    : t.artifacts.demoIssue
                  : a.repo)}
            </span>
            <small>{a.state ? t.artifacts.state[a.state] : t.artifacts.stateUnknown}</small>
          </a>
        ))}
        {items.length > 2 && (
          <button className="artifact-list-more" onClick={() => setExpanded(!expanded)}>
            {expanded ? t.artifacts.showLess : t.artifacts.more(items.length - 2)}
          </button>
        )}
      </section>
    );
  return (
    <section className="artifact-tray" aria-label={t.artifacts.label}>
      <div className="artifact-tray-title">
        <b>
          {t.artifacts.title} <span>{items.length}</span>
        </b>
        {loading ? (
          <span>
            <LoaderCircle className="spin" size={12} /> {t.artifacts.checking}
          </span>
        ) : (
          <span>
            {demo
              ? t.artifacts.sample
              : items.some((x) => x.verifiedAt)
                ? t.artifacts.verified
                : t.artifacts.found}
          </span>
        )}
      </div>
      <div className="artifact-cards">
        {(expanded ? items : items.slice(0, 2)).map((a) => (
          <a
            className={`artifact-card artifact-${a.state || 'unknown'}`}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            key={a.url}
            onClick={(e) => {
              if (isDesktop) {
                e.preventDefault();
                void api.openArtifact(a.url).catch((e) => notify(e.message));
              }
            }}
          >
            <span className="artifact-symbol">
              {a.kind === 'pull' ? <GitPullRequest size={20} /> : <CircleDot size={20} />}
            </span>
            <div>
              <span>
                {a.kind === 'pull' ? t.artifacts.pull : t.artifacts.issue} #{a.number}
                <i>·</i>
                {a.state ? t.artifacts.state[a.state] : t.artifacts.stateUnknown}
              </span>
              <strong>
                {a.title ||
                  (demo
                    ? a.kind === 'pull'
                      ? t.artifacts.demoPull
                      : t.artifacts.demoIssue
                    : a.repo)}
              </strong>
              <small>{a.repo}</small>
            </div>
            <ArrowUpRight size={15} />
          </a>
        ))}
      </div>
      {items.length > 2 && (
        <button className="artifact-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? t.artifacts.showLess : t.artifacts.more(items.length - 2)}
          <ChevronDown size={13} />
        </button>
      )}
    </section>
  );
}
