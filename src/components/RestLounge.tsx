import type { CSSProperties } from 'react';
import { ArrowUpRight, Moon } from 'lucide-react';
import type { Session } from '../shared/types';
import { sessionName, projectKey } from '../shared/office';
import { ago } from '../lib/format';
import { Furniture } from './Furniture';
import { Sprite } from './Sprite';

export function RestLounge({
  sessions,
  privacy,
  reducedMotion,
  onSelect,
  onReturn,
}: {
  sessions: Session[];
  privacy: boolean;
  reducedMotion: boolean;
  onSelect: (id: string) => void;
  onReturn: (id: string) => void;
}) {
  const groups = new Map<string, Session[]>();
  for (const s of sessions) groups.set(projectKey(s), [...(groups.get(projectKey(s)) ?? []), s]);
  return (
    <div
      className={`rest-lounge ${reducedMotion ? 'motion-paused' : ''}`}
      aria-label="동료들의 휴식 공간"
    >
      <div className="lounge-wall">
        <span className="lounge-window" />
        <span className="lounge-neon">
          <Moon size={14} /> 잠시, 느긋하게
        </span>
        <span className="lounge-window" />
        <p>새 활동이 생기면 사무실로 돌아와요. 직접 자리를 마련해 줄 수도 있어요.</p>
      </div>
      <div className="lounge-floor">
        {[...groups].map(([key, group], index) => (
          <section
            className="lounge-group"
            key={key}
            style={{ '--rug': `hsl(${(index * 67 + 260) % 360} 42% 62%)` } as CSSProperties}
          >
            <div className="lounge-project">
              <i />
              {privacy ? '프로젝트' : group[0].project}
              <small>{group.length}명 쉬는 중</small>
            </div>
            <div className="lounge-pods">
              {group.map((s, i) => (
                <article className="room-session lounge-pod" key={s.resident?.key ?? s.id}>
                  <button
                    className="room-session-main rest-pod-open"
                    onClick={() => onSelect(s.id)}
                    aria-label={`${privacy ? '동료' : sessionName(s)} 업무 보기`}
                  >
                    <div className="rest-scene">
                      <Furniture
                        kind={(index + i) % 2 ? 'sofa' : 'bed'}
                        appearance={{ palette: (index + i) % 2 ? 'sea' : 'lilac' }}
                      />
                      <span className="rest-pet">
                        <Sprite provider={s.provider} mood="sleep" size={64} />
                      </span>
                      <span className="rest-zzz" aria-hidden="true">
                        z<span>z</span>
                      </span>
                    </div>
                    <h3>{privacy ? '숨긴 동료' : sessionName(s)}</h3>
                    <p>{privacy ? '프로젝트 숨김' : s.project}</p>
                    <small>
                      {ago(s.updatedAt)} 활동
                      {s.resident ? ` · 실행 기록 ${s.resident.sessionIds.length}개` : ''}
                    </small>
                  </button>
                  <button className="lounge-return" onClick={() => onReturn(s.id)}>
                    사무실로 데려오기 <ArrowUpRight size={12} />
                  </button>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
