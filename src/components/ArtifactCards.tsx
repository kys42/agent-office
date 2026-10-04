import { useEffect, useState } from 'react';
import { GitPullRequest, CircleDot, ArrowUpRight, LoaderCircle, ChevronDown } from 'lucide-react';
import type { Artifact } from '../shared/types';
import { parseArtifact } from '../shared/office';
import { api, isDesktop } from '../lib/api';
const labels = { open: '열림', closed: '닫힘', merged: '병합됨', draft: '초안' };
export function ArtifactCards({
  id,
  urls,
  demo,
  privacy,
  notify,
}: {
  id: string;
  urls: string[];
  demo: boolean;
  privacy: boolean;
  notify: (s: string) => void;
}) {
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
  return (
    <section className="artifact-tray" aria-label="연결된 PR과 이슈">
      <div className="artifact-tray-title">
        <b>
          연결된 작업 <span>{items.length}</span>
        </b>
        {loading ? (
          <span>
            <LoaderCircle className="spin" size={12} /> GitHub 확인 중
          </span>
        ) : (
          <span>
            {demo
              ? '예시 링크'
              : items.some((x) => x.verifiedAt)
                ? 'GitHub 상태 확인됨'
                : '대화에서 발견한 링크'}
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
                {a.kind === 'pull' ? 'PR' : '이슈'} #{a.number}
                <i>·</i>
                {a.state ? labels[a.state] : '상태 미확인'}
              </span>
              <strong>
                {a.title ||
                  (demo
                    ? a.kind === 'pull'
                      ? '안정적인 좌석 배치와 대화 카드'
                      : '새 기록이 와도 자리는 그대로'
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
          {expanded ? '접기' : `${items.length - 2}개 더 보기`}
          <ChevronDown size={13} />
        </button>
      )}
    </section>
  );
}
