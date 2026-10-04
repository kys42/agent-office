import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Mail, Pin, X, GitBranch, ZoomIn, ZoomOut, Maximize2, Armchair } from 'lucide-react';
import { MOODS, type Session, type OfficeNotice } from '../shared/types';
import { sessionName } from '../shared/office';
import { layoutOffice, layoutSignature } from '../shared/office-layout';
import { branchInfo } from '../shared/branch';
import { Furniture } from './Furniture';
import { noticeExposure } from '../shared/notices';
import { Sprite } from './Sprite';
import { sessionActivity, activityLabel, toolLabel } from '../shared/activity';
import { bubbleNotice, noticeLabel, unreadNoticeCount, isInboxNotice } from '../shared/notices';
import { presentSession, focusLevel, POSTURE_LABELS } from '../shared/presentation';
import type { ReceiptHandler } from './News';
import { ago } from '../lib/format';
const colors = ['#709473', '#b18456', '#9682ae', '#658e9d', '#b27485', '#979051'];
function projectColor(key: string) {
  let n = 0;
  for (const c of key) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return colors[n % colors.length];
}
const windowAspect = () =>
  Math.max(
    0.7,
    (window.innerWidth - (window.innerWidth > 1000 ? 430 : 100)) /
      Math.max(380, window.innerHeight - 290),
  );
export function Office({
  sessions,
  notices,
  bubbleHours,
  selected,
  onSelect,
  onNews,
  onReceipt,
  reducedMotion,
  privacy,
  onShowWaiting,
}: {
  sessions: Session[];
  notices: OfficeNotice[];
  bubbleHours: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onNews: (id: string) => void;
  onReceipt: ReceiptHandler;
  reducedMotion: boolean;
  privacy: boolean;
  onShowWaiting: () => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 960, height: 600 });
  const [aspect, setAspect] = useState(windowAspect);
  const [zoom, setZoom] = useState<number | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [hidden, setHidden] = useState(document.hidden);
  const [arrivals, setArrivals] = useState<Record<string, number>>({});
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const el = holder.current!;
    let windowSize = '';
    const ro = new ResizeObserver(() => {
      const width = el.clientWidth,
        height = el.clientHeight;
      setViewport({ width, height });
      const size = `${window.innerWidth}:${window.innerHeight}`;
      // Measure the actual room. Opening a dock only changes scale, never the floor plan.
      if (height > 0 && size !== windowSize) {
        setAspect(width / height);
        windowSize = size;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const visibility = () => {
      setHidden(document.hidden);
      setClock(Date.now());
    };
    const timer = setInterval(() => {
      if (!document.hidden) setClock(Date.now());
    }, 5000);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  useEffect(() => {
    const ids = new Set(notices.map((n) => `${n.id}:${n.version}`));
    if (seen.current) {
      const fresh = notices.filter(
        (n) =>
          n.kind === 'request' &&
          !n.bootstrap &&
          !seen.current!.has(`${n.id}:${n.version}`) &&
          Date.now() - n.receivedAt < 30_000,
      );
      if (fresh.length && !document.hidden)
        setArrivals((old) => ({
          ...old,
          ...Object.fromEntries(fresh.map((n) => [n.sessionId, Date.now() + 12_000])),
        }));
    }
    seen.current = ids;
  }, [notices]);
  const signature = layoutSignature(sessions);
  const layout = useMemo(() => layoutOffice(sessions, aspect), [signature, aspect]);
  const scale =
    zoom ??
    Math.max(
      0.01,
      Math.min(1.2, (viewport.width - 12) / layout.width, (viewport.height - 12) / layout.height),
    );
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const primary = sessions.filter((s) => !s.attachedTo);
  const fit = () => {
    setZoom(null);
    holder.current?.scrollTo({ top: 0, left: 0 });
  };
  return (
    <section
      className={`office-card dynamic-office ${reducedMotion || hidden ? 'motion-paused' : ''}`}
      aria-label="픽셀 사무실"
    >
      <div className="office-card-top">
        <div>
          <span className="live-dot" />
          <strong>우리 사무실</strong>
          <span className="floor-label">하나의 공간 · {layout.projects.length}개 팀</span>
        </div>
        <div className="scene-controls">
          <button
            aria-label="사무실 축소"
            title="축소"
            disabled={scale < 0.2}
            onClick={() => setZoom(Math.max(0.15, scale - 0.15))}
          >
            <ZoomOut size={15} />
          </button>
          <button
            className={zoom === null ? 'is-fit' : ''}
            aria-label="사무실 모두 보기"
            title="모든 동료를 한눈에"
            onClick={fit}
          >
            <Maximize2 size={13} />
            <span>모두 보기</span>
          </button>
          <button
            aria-label="사무실 확대"
            title="확대 · 화면을 스크롤해 둘러보기"
            disabled={scale >= 2}
            onClick={() => setZoom(Math.min(2, scale + 0.2))}
          >
            <ZoomIn size={15} />
          </button>
        </div>
      </div>
      <div className="map-holder scene-viewport" ref={holder} data-scale={scale.toFixed(3)}>
        <div
          className="scene-size"
          style={{
            width: Math.max(viewport.width, layout.width * scale + 12),
            height: Math.max(viewport.height, layout.height * scale + 12),
          }}
        >
          <div
            className="office-map"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `scale(${scale})`,
              left: Math.max(6, (viewport.width - layout.width * scale) / 2),
              top: Math.max(6, (viewport.height - layout.height * scale) / 2),
            }}
          >
            <div className="office-wall" aria-hidden="true">
              <div className="wall-window" />
              <span>AGENT OFFICE</span>
              <div className="wall-window" />
            </div>
            <div className="floor-light" aria-hidden="true" />
            {layout.projects.map((area, index) => (
              <div
                className="project-area"
                key={area.key}
                data-project-key={privacy ? undefined : area.key}
                style={
                  {
                    transform: `translate(${area.x}px, ${area.y}px)`,
                    width: area.width,
                    height: area.height,
                    '--project-color': projectColor(area.key),
                  } as CSSProperties
                }
              >
                <div className="project-floor-mark" title={privacy ? undefined : area.name}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <b>{privacy ? '프로젝트' : area.name}</b>
                  <small>
                    {area.stations.length}명
                    {area.stations.some((s) => s.children.length) ? ' + 보조' : ''}
                  </small>
                </div>
                {area.benches.map((bench, i) => (
                  <Furniture
                    kind="desk"
                    key={`${bench.key}:${i}`}
                    shared={bench.members.length > 1}
                    assetKey={privacy ? undefined : bench.key}
                    style={{ left: bench.x, top: bench.y, width: bench.width }}
                  />
                ))}
                {area.stations.map((station) => {
                  const s = byId.get(station.id)!;
                  const members = s.resident?.sessionIds ?? [s.id];
                  const active = members.includes(selected ?? '');
                  const news = notices.filter((n) => members.includes(n.sessionId));
                  const bubble = bubbleNotice(news, bubbleHours, clock);
                  const unread = unreadNoticeCount(news);
                  const activity = sessionActivity(s);
                  const pose = presentSession(s, clock);
                  const arrival = members.some((id) => (arrivals[id] ?? 0) > clock);
                  const latestRequest = arrival
                    ? news
                        .filter((n) => n.kind === 'request')
                        .sort((a, b) => b.at - a.at)
                        .at(0)
                    : undefined;
                  const request = latestRequest?.dismissedAt ? undefined : latestRequest;
                  const displayedBubble = request ?? bubble;
                  const focus = focusLevel(s, clock);
                  const text = displayedBubble?.text ?? activity.text;
                  const label = displayedBubble ? noticeLabel(displayedBubble) : activityLabel(s);
                  const branch = branchInfo(s);
                  return (
                    <div
                      className={`desk-station ${active ? 'selected-station' : ''} ${pose.working ? 'station-working' : 'station-resting'} focus-level-${focus}`}
                      data-working={pose.working}
                      key={s.id}
                      data-station-id={s.id}
                      style={{ transform: `translate(${station.x}px, ${station.y}px)` }}
                    >
                      <Furniture kind="chair" />
                      <div className={`pet-shadow ${active ? 'selected' : ''}`} />
                      <button
                        className={`office-pet ${active ? 'chosen' : ''} pose-${!active && !arrival ? pose.posture : 'still'} ${arrival ? 'work-arrival' : ''}`}
                        data-session-id={s.id}
                        data-seat={s.officeSeat}
                        aria-label={`${privacy ? s.provider : sessionName(s)}, ${MOODS[s.status].label}`}
                        title={POSTURE_LABELS[pose.posture]}
                        onClick={() => onSelect(s.id)}
                        onMouseEnter={() => setHover(s.id)}
                        onMouseLeave={() => setHover(null)}
                      >
                        {focus > 0 && (
                          <span className="focus-aura" aria-hidden="true">
                            <i />
                            <i />
                            <i />
                          </span>
                        )}
                        <Sprite provider={s.provider} mood={pose.mood} size={80} />
                        {arrival && (
                          <span className="arrival-envelope">
                            <span className="paper-stack" aria-hidden="true">
                              <i />
                              <i />
                              <i />
                            </span>
                            <Mail size={19} />
                            <b>일이 도착했어요!</b>
                          </span>
                        )}
                        {pose.posture === 'dozing' && <span className="doze-mark">z z</span>}
                      </button>
                      <Furniture kind="equipment" />
                      {pose.working && (
                        <span className="working-beacon">
                          <i />
                          <i />
                          <i />{' '}
                          {focus === 2
                            ? '몰입 중 · 15분+'
                            : focus === 1
                              ? '집중 중 · 5분+'
                              : '작업 중'}
                        </span>
                      )}
                      <button
                        className={`desk-branch branch-${branch.kind}`}
                        title={privacy ? undefined : `${branch.label} · ${branch.detail}`}
                        onClick={() => onSelect(s.id)}
                      >
                        <GitBranch size={10} />
                        <span>{privacy ? '내용 숨김' : branch.label}</span>
                      </button>
                      <button
                        className={`desk-name ${active ? 'selected' : ''}`}
                        onClick={() => onSelect(s.id)}
                        title={privacy ? undefined : sessionName(s)}
                      >
                        <strong>
                          <i style={{ background: MOODS[s.status].color }} />
                          <span>{privacy ? s.provider : sessionName(s)}</span>
                          {s.pinned && <Pin size={10} />}
                        </strong>
                        <small>
                          <span>
                            {pose.working
                              ? s.resident && s.resident.activeCount > 1
                                ? `${s.resident.activeCount}개 작업 중`
                                : '일하는 중'
                              : MOODS[s.status].label}
                          </span>
                          {unread > 0 && <em>소식 {unread}</em>}
                        </small>
                      </button>
                      {(displayedBubble ||
                        (!news.length &&
                          (hover === s.id ||
                            active ||
                            ['work', 'think', 'call', 'error'].includes(s.status)))) && (
                        <div
                          className={`speech-bubble bubble-${s.status} ${displayedBubble && !displayedBubble.seenAt ? 'unread' : ''} ${displayedBubble?.viewedAt || displayedBubble?.seenAt ? 'bubble-opened' : 'bubble-new'}`}
                        >
                          <button
                            className="speech-open"
                            onClick={() => {
                              if (displayedBubble) {
                                if (!privacy)
                                  onReceipt(
                                    [{ id: displayedBubble.id, version: displayedBubble.version }],
                                    'view',
                                  );
                                onNews(displayedBubble.sessionId);
                              } else onSelect(s.id);
                            }}
                            title={privacy ? '내용 숨김' : text}
                          >
                            <span className="speech-copy">
                              <small>
                                {privacy ? '내용 숨김' : label}
                                {displayedBubble && (
                                  <span className="bubble-exposure">
                                    {noticeExposure(displayedBubble)}
                                  </span>
                                )}
                              </small>
                              <b>{privacy ? MOODS[s.status].label : text}</b>
                              <em>
                                {ago(displayedBubble?.at ?? activity.at)}

                                {!privacy && activity.tool
                                  ? ` · ${toolLabel(activity.tool.name)}`
                                  : ''}
                              </em>
                            </span>
                          </button>
                          {displayedBubble && (
                            <button
                              className="bubble-dismiss"
                              aria-label={`${privacy ? '동료' : sessionName(s)} 말풍선 접기`}
                              title="말풍선만 접기 · 미확인 소식은 남아요"
                              onClick={() =>
                                onReceipt(
                                  [{ id: displayedBubble.id, version: displayedBubble.version }],
                                  'dismiss',
                                )
                              }
                            >
                              <X size={13} />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {area.stations.flatMap((station) =>
                  station.children.map((child) => {
                    const s = byId.get(child.id)!;
                    return (
                      <button
                        className={`helper-desk ${selected === s.id ? 'chosen' : ''}`}
                        key={s.id}
                        data-session-id={s.id}
                        data-parent-id={station.id}
                        data-furniture="helper-desk"
                        style={{ transform: `translate(${child.x}px, ${child.y}px)` }}
                        aria-label={`${privacy ? s.provider : sessionName(s)}, 보조 동료${s.runtime?.phase === 'responded' && !presentSession(s, clock).working ? ', 결과 남김' : ''}`}
                        title={
                          privacy
                            ? undefined
                            : `${sessionName(s)} · ${s.relation?.role || '보조 동료'}`
                        }
                        onClick={() => onSelect(s.id)}
                      >
                        <Sprite
                          provider={s.provider}
                          mood={presentSession(s, clock).mood}
                          size={44}
                        />
                        <Furniture kind="helper" />
                        {s.runtime?.phase === 'responded' && !presentSession(s, clock).working && (
                          <span
                            className="helper-result"
                            title="응답을 남겼어요 · 메인의 다음 요청까지 머물러요"
                          >
                            ✓
                          </span>
                        )}
                        <b>{privacy ? '보조 동료' : s.relation?.role || sessionName(s)}</b>
                        {notices.some(
                          (n) => n.sessionId === s.id && !n.seenAt && isInboxNotice(n),
                        ) && <i className="helper-news" />}
                      </button>
                    );
                  }),
                )}
              </div>
            ))}
            {!primary.length && (
              <div className="scene-empty">
                <Armchair size={32} />
                <h3>다음 동료를 기다리고 있어요</h3>
                <p>새 활동이 생기면 책상이 놓여요.</p>
                <button onClick={onShowWaiting}>대기 중인 동료 보기</button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="office-card-bottom">
        <span>
          <i className="yellow-tile" />
          {primary.length}개 책상 · 보조 {sessions.length - primary.length}명 · 모두 이 공간에
          있어요
        </span>
        <span>{Math.round(scale * 100)}% · 같은 프로젝트는 한 구역</span>
      </div>
    </section>
  );
}
