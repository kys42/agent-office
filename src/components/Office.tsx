import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Mail, Pin, X, GitBranch, Plus, Minus, Maximize2, Armchair, Moon, Sun } from 'lucide-react';
import { MOODS, type Session, type OfficeNotice } from '../shared/types';
import { sessionName } from '../shared/office';
import { layoutOffice, layoutSignature } from '../shared/office-layout';
import { branchInfo } from '../shared/branch';
import { Furniture } from './Furniture';
import { noticeExposure } from '../shared/notices';
import { Sprite } from './Sprite';
import { sessionActivity, activityLabel, toolLabel } from '../shared/activity';
import { bubbleNotice, noticeLabel, unreadNoticeCount, isInboxNotice } from '../shared/notices';
import { presentSession, POSTURE_LABELS } from '../shared/presentation';
import type { ReceiptHandler } from './News';
import { ago } from '../lib/format';
const colors = ['#7fae86', '#d39a62', '#a48fd0', '#6fa9bd', '#d08497', '#b8ad5d'];
function projectColor(key: string) {
  let n = 0;
  for (const c of key) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return colors[n % colors.length];
}
/** Decorative only: the room follows the local clock, never session state. */
function dayPhase(at: number) {
  const h = new Date(at).getHours();
  return h >= 6 && h < 8 ? 'dawn' : h >= 8 && h < 17 ? 'day' : h >= 17 && h < 19 ? 'dusk' : 'night';
}
const PHASE_COPY = { dawn: '이른 아침', day: '낮', dusk: '해질녘', night: '밤' } as const;
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
  footer,
  spotlight = null,
  onHover,
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
  footer?: ReactNode;
  spotlight?: string | null;
  onHover?: (id: string | null) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 960, height: 600 });
  const [aspect, setAspect] = useState(1.6);
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
    const ids = new Set(notices.map((n) => n.id));
    if (seen.current) {
      const fresh = notices.filter(
        (n) =>
          n.kind === 'request' &&
          !n.bootstrap &&
          !seen.current!.has(n.id) &&
          Date.now() - n.receivedAt < 30_000,
      );
      if (fresh.length && !document.hidden)
        setArrivals((old) => ({
          ...old,
          ...Object.fromEntries(fresh.map((n) => [n.sessionId, Date.now() + 4500])),
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
      Math.min(1.25, (viewport.width - 48) / layout.width, (viewport.height - 92) / layout.height),
    );
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const primary = sessions.filter((s) => !s.attachedTo);
  const working = sessions.filter((s) => presentSession(s, clock).working).length;
  const phase = dayPhase(clock);
  const now = new Date(clock);
  const fit = () => {
    setZoom(null);
    holder.current?.scrollTo({ top: 0, left: 0 });
  };
  const zoomBy = (delta: number) => setZoom(Math.min(2, Math.max(0.15, scale + delta)));
  useEffect(() => {
    const command = (e: Event) => {
      const what = (e as CustomEvent<string>).detail;
      if (what === 'fit') fit();
      if (what === 'zoom-in') zoomBy(0.2);
      if (what === 'zoom-out') zoomBy(-0.15);
    };
    window.addEventListener('office:command', command);
    return () => window.removeEventListener('office:command', command);
  });
  // When zoomed in, bring the chosen colleague's desk into view. Furniture never moves.
  useEffect(() => {
    if (zoom === null || !selected || !holder.current) return;
    const owner = sessions.find(
      (s) => s.id === selected || s.resident?.sessionIds.includes(selected),
    );
    const el = holder.current.querySelector<HTMLElement>(
      `[data-station-id="${CSS.escape(owner?.id ?? selected)}"], .helper-desk[data-session-id="${CSS.escape(selected)}"]`,
    );
    if (!el) return;
    const box = el.getBoundingClientRect(),
      view = holder.current.getBoundingClientRect();
    holder.current.scrollTo({
      left: holder.current.scrollLeft + box.left - view.left - (view.width - box.width) / 2,
      top: holder.current.scrollTop + box.top - view.top - (view.height - box.height) / 2,
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
  }, [selected, zoom === null]);
  const callers = primary.filter((s) => s.status === 'call' || s.status === 'error');
  return (
    <section
      className={`office-card dynamic-office phase-${phase} ${reducedMotion || hidden ? 'motion-paused' : ''}`}
      aria-label="픽셀 사무실"
    >
      <div className="map-holder scene-viewport" ref={holder} data-scale={scale.toFixed(3)}>
        <div
          className="scene-size"
          style={{
            width: Math.max(viewport.width, layout.width * scale + 48),
            height: Math.max(viewport.height, layout.height * scale + 92),
          }}
        >
          <div
            className="office-map"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `scale(${scale})`,
              left: Math.max(24, (viewport.width - layout.width * scale) / 2),
              top: Math.max(28, (viewport.height - layout.height * scale) / 2 - 8),
            }}
          >
            <div className="office-wall" aria-hidden="true">
              <div className="wall-trim" />
              <div className="wall-decor wall-left">
                <div className="wall-window">
                  <i className="sky-body" />
                </div>
                <div className="wall-board">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
              <div className="wall-sign">
                <span>AGENT OFFICE</span>
                <b className="wall-clock">
                  {String(now.getHours()).padStart(2, '0')}
                  <i>:</i>
                  {String(now.getMinutes()).padStart(2, '0')}
                </b>
              </div>
              <div className="wall-decor wall-right">
                <div className="wall-shelf">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
                <div className="wall-window">
                  <i className="sky-body" />
                </div>
              </div>
            </div>
            <div className="floor-light" aria-hidden="true" />
            <i className="wall-plant plant-left" aria-hidden="true" />
            <i className="wall-plant plant-right" aria-hidden="true" />
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
                  const text = bubble?.text ?? activity.text;
                  const label = bubble ? noticeLabel(bubble) : activityLabel(s);
                  const branch = branchInfo(s);
                  return (
                    <div
                      className={`desk-station status-${s.status} ${active ? 'selected-station' : ''} ${pose.working ? 'station-working' : 'station-resting'} ${spotlight === s.id ? 'is-spotlight' : spotlight ? 'is-dimmed' : ''}`}
                      data-working={pose.working}
                      key={s.id}
                      data-station-id={s.id}
                      style={{ transform: `translate(${station.x}px, ${station.y}px)` }}
                    >
                      <i className="desk-glow" aria-hidden="true" />
                      <Furniture kind="chair" />
                      <div className={`pet-shadow ${active ? 'selected' : ''}`} />
                      <button
                        className={`office-pet ${active ? 'chosen' : ''} pose-${!active && !arrival ? pose.posture : 'still'} ${arrival ? 'work-arrival' : ''}`}
                        data-session-id={s.id}
                        data-seat={s.officeSeat}
                        aria-label={`${privacy ? s.provider : sessionName(s)}, ${MOODS[s.status].label}`}
                        title={POSTURE_LABELS[pose.posture]}
                        onClick={() => onSelect(s.id)}
                        onMouseEnter={() => {
                          setHover(s.id);
                          onHover?.(s.id);
                        }}
                        onMouseLeave={() => {
                          setHover(null);
                          onHover?.(null);
                        }}
                      >
                        <Sprite provider={s.provider} mood={pose.mood} size={80} />
                        {arrival && (
                          <span className="arrival-envelope">
                            <Mail size={16} />
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
                          <i /> 작업 중
                        </span>
                      )}
                      <button
                        className={`desk-branch branch-${branch.kind}`}
                        title={privacy ? undefined : `${branch.label} · ${branch.detail}`}
                        onClick={() => onSelect(s.id)}
                      >
                        <GitBranch size={9} />
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
                          {s.pinned && <Pin size={9} />}
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
                      {(bubble ||
                        (!news.length &&
                          (hover === s.id ||
                            active ||
                            ['work', 'think', 'call', 'error'].includes(s.status)))) && (
                        <div
                          className={`speech-bubble bubble-${s.status} ${bubble ? `bubble-kind-${bubble.kind === 'reply' && bubble.phase !== 'final' ? 'message' : bubble.kind}` : 'bubble-live'} ${bubble && !bubble.seenAt ? 'unread' : ''} ${bubble?.viewedAt || bubble?.seenAt ? 'bubble-opened' : 'bubble-new'}`}
                        >
                          <button
                            className="speech-open"
                            onClick={() => {
                              if (bubble) {
                                if (!privacy)
                                  onReceipt([{ id: bubble.id, version: bubble.version }], 'view');
                                onNews(bubble.sessionId);
                              } else onSelect(s.id);
                            }}
                            title={privacy ? '내용 숨김' : text}
                          >
                            <span className="speech-copy">
                              <small>
                                <span className="bubble-label">
                                  {privacy ? '내용 숨김' : label}
                                </span>
                                <em>
                                  {bubble && (
                                    <span className="bubble-exposure">
                                      {noticeExposure(bubble)}
                                    </span>
                                  )}
                                  {ago(bubble?.at ?? activity.at)}
                                  {!privacy && activity.tool
                                    ? ` · ${toolLabel(activity.tool.name)}`
                                    : ''}
                                </em>
                              </small>
                              <b>{privacy ? MOODS[s.status].label : text}</b>
                            </span>
                          </button>
                          {bubble && (
                            <button
                              className="bubble-dismiss"
                              aria-label={`${privacy ? '동료' : sessionName(s)} 말풍선 접기`}
                              title="말풍선만 접기 · 미확인 소식은 남아요"
                              onClick={() =>
                                onReceipt([{ id: bubble.id, version: bubble.version }], 'dismiss')
                              }
                            >
                              <X size={11} strokeWidth={2.6} />
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
                    const childPose = presentSession(s, clock);
                    return (
                      <button
                        className={`helper-desk ${selected === s.id ? 'chosen' : ''} ${childPose.working ? 'helper-working' : ''} ${spotlight === s.id ? 'is-spotlight' : spotlight ? 'is-dimmed' : ''}`}
                        key={s.id}
                        data-session-id={s.id}
                        data-parent-id={station.id}
                        data-furniture="helper-desk"
                        style={{ transform: `translate(${child.x}px, ${child.y}px)` }}
                        aria-label={`${privacy ? s.provider : sessionName(s)}, 보조 동료${s.runtime?.phase === 'responded' && !childPose.working ? ', 결과 남김' : ''}`}
                        title={
                          privacy
                            ? undefined
                            : `${sessionName(s)} · ${s.relation?.role || '보조 동료'}`
                        }
                        onClick={() => onSelect(s.id)}
                      >
                        <Sprite provider={s.provider} mood={childPose.mood} size={44} />
                        <Furniture kind="helper" />
                        {s.runtime?.phase === 'responded' && !childPose.working && (
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
                <Armchair size={30} />
                <h3>다음 동료를 기다리고 있어요</h3>
                <p>새 활동이 생기면 책상이 놓여요.</p>
                <button onClick={onShowWaiting}>대기 중인 동료 보기</button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="stage-hud hud-bottom-left office-card-bottom">
        <span className="hud-pill">
          {phase === 'night' || phase === 'dusk' ? <Moon size={12} /> : <Sun size={12} />}
          {PHASE_COPY[phase]}
          <i />
          {layout.projects.length}개 프로젝트 · {primary.length}개 책상
          {sessions.length - primary.length > 0
            ? ` · 보조 ${sessions.length - primary.length}`
            : ''}
          {working > 0 && (
            <>
              <i />
              <em>{working}명 작업 중</em>
            </>
          )}
        </span>
        {callers.length > 0 && (
          <button
            className="hud-pill hud-call"
            title="기다리는 동료에게 가기"
            onClick={() => {
              const i = callers.findIndex(
                (s) => s.id === selected || s.resident?.sessionIds.includes(selected ?? ''),
              );
              onSelect(callers[(i + 1) % callers.length].id);
            }}
          >
            <i className="hud-call-dot" />
            불러요 {callers.length}
          </button>
        )}
        {footer}
      </div>
      <div className="stage-hud hud-bottom-right scene-controls">
        <button
          aria-label="사무실 축소"
          title="축소"
          disabled={scale < 0.2}
          onClick={() => zoomBy(-0.15)}
        >
          <Minus size={14} />
        </button>
        <button
          className={`zoom-readout ${zoom === null ? 'is-fit' : ''}`}
          aria-label="사무실 모두 보기"
          title="모든 동료를 한눈에"
          onClick={fit}
        >
          {zoom === null ? <Maximize2 size={12} /> : null}
          <span>{zoom === null ? '모두 보기' : `${Math.round(scale * 100)}%`}</span>
        </button>
        <button
          aria-label="사무실 확대"
          title="확대 · 화면을 스크롤해 둘러보기"
          disabled={scale >= 2}
          onClick={() => zoomBy(0.2)}
        >
          <Plus size={14} />
        </button>
      </div>
    </section>
  );
}
