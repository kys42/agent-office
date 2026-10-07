import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Pin, GitBranch, Plus, Minus, Maximize2, Armchair, Moon, Sun } from 'lucide-react';
import { MOODS, type Session, type OfficeNotice } from '../shared/types';
import { sessionName, projectKey } from '../shared/office';
import { layoutOffice, layoutSignature, projectColor } from '../shared/office-layout';
import { branchInfo } from '../shared/branch';
import { Furniture } from './Furniture';
import { Sprite } from './Sprite';
import { SpeechBubble } from './SpeechBubble';
import { HelperDesk } from './HelperDesk';
import { VeilButton } from './VeilButton';
import { PinButton } from './PinButton';
import { arrivalEnds, deskSpeech, hopping } from '../shared/speech';
import { useWakeAt } from '../lib/useWakeAt';
import { isInboxNotice } from '../shared/notices';
import { presentSession, focusLevel, deskPapers, POSTURE_LABELS } from '../shared/presentation';
import { ArrivalBurst, FocusEffects, PaperPile, WorkingBeacon } from './DeskEffects';
import type { ReceiptHandler } from './News';
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
  onVeil,
  canVeil = () => true,
  onPin,
  onZoneDrop,
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
  /** Hide a colleague until their next conversation. */
  onVeil?: (s: Session) => void;
  /** Someone waiting for the person cannot be hidden. */
  canVeil?: (s: Session) => boolean;
  /** Keep a colleague in the office however long it stays quiet (or let go). */
  onPin?: (s: Session) => void;
  /** Dropping a desk on a zone (or `null` for empty floor) asks where it should go. */
  onZoneDrop?: (sessionId: string, zoneKey: string | null) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 960, height: 600 });
  const [aspect, setAspect] = useState(1.6);
  const [zoom, setZoom] = useState<number | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [hidden, setHidden] = useState(document.hidden);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null | undefined>(undefined);
  const draggable = !!onZoneDrop && !privacy;
  const dragFrom = dragging ? sessions.find((s) => s.id === dragging) : undefined;
  const endDrag = () => {
    setDragging(null);
    setDropKey(undefined);
  };
  const drop = (zoneKey: string | null) => {
    const from = dragFrom;
    endDrag();
    if (from && onZoneDrop && zoneKey !== projectKey(from)) onZoneDrop(from.id, zoneKey);
  };
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
  useWakeAt(arrivalEnds(notices), () => setClock(Date.now()));
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
      className={`office-card dynamic-office phase-${phase} ${reducedMotion || hidden ? 'motion-paused' : ''} ${dragging ? 'is-dragging' : ''}`}
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
            className={`office-map ${dragging && dropKey === null ? 'drop-new' : ''}`}
            onDragOver={(e) => {
              if (!dragging) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDropKey(null);
            }}
            onDrop={(e) => {
              if (!dragging) return;
              e.preventDefault();
              drop(null);
            }}
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
                className={`project-area ${dragging && dropKey === area.key ? (dragFrom && projectKey(dragFrom) === area.key ? 'drop-home' : 'drop-target') : ''}`}
                key={area.key}
                data-project-key={privacy ? undefined : area.key}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = 'move';
                  setDropKey(area.key);
                }}
                onDrop={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  e.stopPropagation();
                  drop(area.key);
                }}
                style={
                  {
                    transform: `translate(${area.x}px, ${area.y}px)`,
                    width: area.width,
                    height: area.height,
                    '--project-color': projectColor(area.key),
                  } as CSSProperties
                }
              >
                <div
                  className={`project-floor-mark ${area.custom ? 'custom-area' : ''}`}
                  title={
                    privacy
                      ? undefined
                      : area.custom
                        ? `${area.name} · 직접 나눈 구역 (${area.custom.join(', ')})`
                        : area.name
                  }
                >
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
                  const pose = presentSession(s, clock);
                  // A just-arrived request plays on the desk and speaks first.
                  const speech = deskSpeech(s, notices, bubbleHours, clock);
                  const { bubble, unread, arrival, hop } = speech;
                  const focus = focusLevel(s, clock);
                  const branch = branchInfo(s);
                  return (
                    <div
                      className={`desk-station status-${s.status} ${active ? 'selected-station' : ''} ${pose.working ? 'station-working' : 'station-resting'} ${spotlight === s.id ? 'is-spotlight' : spotlight ? 'is-dimmed' : ''} focus-level-${focus}`}
                      data-working={pose.working}
                      key={s.id}
                      data-station-id={s.id}
                      style={{ transform: `translate(${station.x}px, ${station.y}px)` }}
                    >
                      <i className="desk-glow" aria-hidden="true" />
                      <Furniture kind="chair" />
                      <div className={`pet-shadow ${active ? 'selected' : ''}`} />
                      <button
                        className={`office-pet ${active ? 'chosen' : ''} pose-${!active && !hop ? pose.posture : 'still'} ${hopping(speech) ? 'work-arrival' : ''}`}
                        data-session-id={s.id}
                        data-seat={s.officeSeat}
                        aria-label={`${privacy ? s.provider : sessionName(s)}, ${MOODS[s.status].label}`}
                        title={
                          draggable
                            ? `${POSTURE_LABELS[pose.posture]} · 끌어서 다른 구역으로`
                            : POSTURE_LABELS[pose.posture]
                        }
                        draggable={draggable}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', s.id);
                          e.dataTransfer.effectAllowed = 'move';
                          setDragging(s.id);
                          setHover(null);
                        }}
                        onDragEnd={endDrag}
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
                        <FocusEffects level={focus} />
                        <Sprite provider={s.provider} mood={pose.mood} size={80} />
                        {pose.posture === 'dozing' && <span className="doze-mark">z z</span>}
                      </button>
                      {onVeil && canVeil(s) && (
                        <VeilButton
                          name={privacy ? s.provider : sessionName(s)}
                          onVeil={() => onVeil(s)}
                        />
                      )}
                      {onPin && (
                        <PinButton
                          name={privacy ? s.provider : sessionName(s)}
                          pinned={s.pinned}
                          onPin={() => onPin(s)}
                        />
                      )}
                      <Furniture kind="equipment" />
                      <PaperPile count={deskPapers(s, clock)} level={focus} />
                      {arrival && <ArrivalBurst key={arrival.id} receivedAt={arrival.receivedAt} />}
                      {pose.working && <WorkingBeacon level={focus} />}
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
                      {speech.shows(hover === s.id || active) && (
                        <SpeechBubble
                          session={s}
                          speech={speech}
                          privacy={privacy}
                          onOpen={() => {
                            if (bubble) {
                              if (!privacy)
                                onReceipt([{ id: bubble.id, version: bubble.version }], 'view');
                              onNews(bubble.sessionId);
                            } else onSelect(s.id);
                          }}
                          onDismiss={() =>
                            bubble &&
                            onReceipt([{ id: bubble.id, version: bubble.version }], 'dismiss')
                          }
                        />
                      )}
                    </div>
                  );
                })}
                {area.stations.flatMap((station) =>
                  station.children.map((child) => {
                    const s = byId.get(child.id)!;
                    const childPose = presentSession(s, clock);
                    return (
                      <HelperDesk
                        key={s.id}
                        session={s}
                        parentId={station.id}
                        at={child}
                        mood={childPose.mood}
                        working={childPose.working}
                        news={notices.some(
                          (n) => n.sessionId === s.id && !n.seenAt && isInboxNotice(n),
                        )}
                        privacy={privacy}
                        className={`${selected === s.id ? 'chosen' : ''} ${spotlight === s.id ? 'is-spotlight' : spotlight ? 'is-dimmed' : ''}`}
                        onClick={() => onSelect(s.id)}
                      />
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
                <button onClick={onShowWaiting}>라운지 동료 보기</button>
              </div>
            )}
          </div>
        </div>
      </div>
      {dragging && (
        <div className="stage-hud drag-hint" role="status">
          {dropKey === null
            ? '여기에 놓으면 새 구역을 만들어요'
            : dropKey && dragFrom && dropKey !== projectKey(dragFrom)
              ? `${layout.projects.find((p) => p.key === dropKey)?.name ?? '이'} 구역으로 옮겨요`
              : '다른 구역 바닥이나 빈 바닥에 놓아 주세요'}
        </div>
      )}
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
