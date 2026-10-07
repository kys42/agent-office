import type { CSSProperties } from 'react';
import { zoneLabel } from '../shared/zones';
import { ArrowUpRight, Moon } from 'lucide-react';
import type { Session } from '../shared/types';
import { sessionName, projectKey } from '../shared/office';
import { ago } from '../lib/format';
import { Furniture } from './Furniture';
import { Sprite } from './Sprite';
import { useI18n } from '../lib/i18n';

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
  const { t } = useI18n();
  const groups = new Map<string, Session[]>();
  for (const s of sessions) groups.set(projectKey(s), [...(groups.get(projectKey(s)) ?? []), s]);
  return (
    <div
      className={`rest-lounge ${reducedMotion ? 'motion-paused' : ''}`}
      aria-label={t.lounge.label}
    >
      <div className="lounge-wall">
        <span className="lounge-window" />
        <span className="lounge-neon">
          <Moon size={14} /> {t.lounge.neon}
        </span>
        <span className="lounge-window" />
        <p>{t.lounge.intro}</p>
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
              {privacy ? t.lounge.project : zoneLabel(group[0])}
              <small>{t.lounge.offDuty(group.length)}</small>
            </div>
            <div className="lounge-pods">
              {group.map((s, i) => (
                <article className="room-session lounge-pod" key={s.resident?.key ?? s.id}>
                  <button
                    className="room-session-main rest-pod-open"
                    onClick={() => onSelect(s.id)}
                    aria-label={t.lounge.open(privacy ? undefined : sessionName(s))}
                  >
                    <div className="rest-scene">
                      <Furniture
                        kind={(index + i) % 2 ? 'sofa' : 'bed'}
                        appearance={{ palette: (index + i) % 2 ? 'sea' : 'lilac' }}
                      />
                      <span className="rest-pet">
                        <Sprite session={s} provider={s.provider} mood="sleep" size={64} />
                      </span>
                      <span className="rest-zzz" aria-hidden="true">
                        z<span>z</span>
                      </span>
                    </div>
                    <h3>{privacy ? t.lounge.hiddenTeammate : sessionName(s)}</h3>
                    <p>{privacy ? t.lounge.hiddenProject : zoneLabel(s)}</p>
                    <small>
                      {t.lounge.active(ago(s.updatedAt))}
                      {s.resident ? ` · ${t.lounge.runs(s.resident.sessionIds.length)}` : ''}
                    </small>
                  </button>
                  <button className="lounge-return" onClick={() => onReturn(s.id)}>
                    {t.lounge.bringBack} <ArrowUpRight size={12} />
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
