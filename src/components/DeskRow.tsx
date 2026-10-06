import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Coffee, Expand, GitBranch, X } from 'lucide-react';
import { api } from '../lib/api';
import type { ReceiptAction } from '../lib/useOffice';
import { MOODS, type NoticeReceipt } from '../shared/types';
import { branchInfo } from '../shared/branch';
import {
  layoutRow,
  layoutSignature,
  projectColor,
  ROW_TOP,
  STATION_WIDTH,
} from '../shared/office-layout';
import { ROW_HEIGHT, ROW_SCALE, ROW_SCENE_HEIGHT } from '../shared/dock-geometry';
import { residentLabel, type OfficeModel } from '../shared/office-model';
import { stationSpeech } from '../shared/speech';
import { isInboxNotice } from '../shared/notices';
import { Furniture } from './Furniture';
import { Sprite } from './Sprite';
import { SpeechBubble } from './SpeechBubble';
import { HelperDesk } from './HelperDesk';

/** Breathing room before the first and after the last zone (the row is edge to edge). */
const LANE_PAD = 16;
/** Station-space rows, matching the big office's station (bench at 134 under the chair). */
const BENCH_Y = ROW_TOP + 134;
const HELPER_Y = ROW_TOP + 128;

/**
 * The office as one line along the screen edge: the same project zones, shared benches,
 * helper desks and speech bubbles as the big office, drawn with its own furniture.
 * Only drawn things are `[data-solid]`; the transparent rest lets clicks through.
 */
export function DeskRow({
  model,
  status,
  privacy,
  reducedMotion,
  onReceipt,
  onCollapse,
}: {
  model: OfficeModel;
  status: string | null;
  privacy: boolean;
  reducedMotion: boolean;
  onReceipt: (receipts: NoticeReceipt[], action: ReceiptAction) => void;
  onCollapse: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ left: 0, width: 0, scroll: 0 });
  // A mouse wheel scrolls the row sideways when there are more desks than fit.
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const sessions = model.bySeat;
  const signature = layoutSignature(sessions);
  const layout = useMemo(() => layoutRow(sessions), [signature]);
  // Track what is in view, so each arrow knows who is hidden on its side.
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setView({ left: el.scrollLeft, width: el.clientWidth, scroll: el.scrollWidth }),
      );
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  }, [layout.width]);
  /** One screenful at a time, keeping one desk of context. Desks never shrink. */
  const page = (direction: -1 | 1) => {
    const el = track.current;
    if (!el) return;
    const step = Math.max(STATION_WIDTH * ROW_SCALE, el.clientWidth - STATION_WIDTH * ROW_SCALE);
    el.scrollBy({ left: direction * step, behavior: reducedMotion ? 'auto' : 'smooth' });
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') page(-1);
      if (e.key === 'ArrowRight') page(1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const lounge = model.zones.waiting.filter((s) => !s.attachedTo).length;
  const open = (id: string) => api.window('main', id);
  const desk = STATION_WIDTH * ROW_SCALE;
  const stations = layout.zones.flatMap((z) =>
    z.stations.map((st) => ({ id: st.id, x: LANE_PAD + (z.x + st.x) * ROW_SCALE })),
  );
  const hiddenLeft = stations.filter((st) => st.x + desk / 2 < view.left);
  const hiddenRight = stations.filter((st) => st.x + desk / 2 > view.left + view.width);
  const calling = (list: typeof stations) =>
    list.some((st) => model.view(st.id)?.group === 'attention');
  return (
    <div className="desk-row" style={{ height: ROW_HEIGHT }}>
      <div
        className={`desk-row-track ${hiddenLeft.length ? 'fade-left' : ''} ${hiddenRight.length ? 'fade-right' : ''}`}
        ref={track}
      >
        <div
          className="desk-row-lane"
          style={{
            width: layout.width * ROW_SCALE + LANE_PAD * 2,
            height: ROW_SCENE_HEIGHT * ROW_SCALE,
          }}
        >
          <div
            className={`desk-row-scene dynamic-office ${reducedMotion ? 'motion-paused' : ''}`}
            style={{
              left: LANE_PAD,
              width: layout.width,
              height: ROW_SCENE_HEIGHT,
              transform: `scale(${ROW_SCALE})`,
            }}
          >
            {layout.zones.map((zone, index) => (
              <div
                className="row-zone"
                key={zone.key}
                data-project-key={privacy ? undefined : zone.key}
                style={
                  {
                    left: zone.x,
                    width: zone.width,
                    '--project-color': projectColor(zone.key),
                  } as CSSProperties
                }
              >
                <div className="project-area row-zone-floor" data-solid />
                <div
                  className="project-floor-mark row-zone-mark"
                  title={privacy ? undefined : zone.name}
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <b>{privacy ? '프로젝트' : zone.name}</b>
                  <small>
                    {zone.stations.length}명{zone.helpers.length ? ' + 보조' : ''}
                  </small>
                </div>
                {zone.benches.map((bench, i) => (
                  <Furniture
                    kind="desk"
                    key={`${bench.key}:${i}`}
                    shared={bench.members.length > 1}
                    assetKey={privacy ? undefined : bench.key}
                    style={{ left: bench.x, top: BENCH_Y, width: bench.width }}
                  />
                ))}
                {zone.stations.map((station) => {
                  const s = byId.get(station.id)!;
                  const v = model.view(s.id)!;
                  const pose = v.pose;
                  const label = residentLabel(s, privacy);
                  const branch = branchInfo(s);
                  const speech = stationSpeech(s, model.notices, model.bubbleHours, model.now);
                  const { bubble } = speech;
                  return (
                    <div
                      className={`desk-station row-station status-${s.status} group-${v.group} ${pose.working ? 'station-working' : 'station-resting'}`}
                      key={s.id}
                      data-station-id={s.id}
                      style={{ transform: `translate(${station.x}px, ${ROW_TOP}px)` }}
                      onMouseEnter={() => setHover(s.id)}
                      onMouseLeave={() => setHover((h) => (h === s.id ? null : h))}
                    >
                      <i className="desk-glow" aria-hidden="true" />
                      <Furniture kind="chair" />
                      <div className="pet-shadow" />
                      <button
                        className={`office-pet pose-${pose.posture}`}
                        data-solid
                        data-session-id={s.id}
                        data-seat={s.officeSeat}
                        aria-label={`${label.name} 업무 보기`}
                        title={label.detail}
                        onClick={() => open(s.id)}
                      >
                        <Sprite provider={s.provider} mood={pose.mood} size={80} />
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
                        data-solid
                        title={privacy ? undefined : `${branch.label} · ${branch.detail}`}
                        onClick={() => open(s.id)}
                      >
                        <GitBranch size={9} />
                        <span>{privacy ? '내용 숨김' : branch.label}</span>
                      </button>
                      <button
                        className="desk-name"
                        data-solid
                        title={privacy ? undefined : label.name}
                        onClick={() => open(s.id)}
                      >
                        <strong>
                          <i style={{ background: MOODS[s.status].color }} />
                          <span>{label.name}</span>
                        </strong>
                        <small>
                          <span>
                            {pose.working
                              ? s.resident && s.resident.activeCount > 1
                                ? `${s.resident.activeCount}개 작업 중`
                                : '일하는 중'
                              : MOODS[s.status].label}
                          </span>
                          {speech.unread > 0 && <em>소식 {speech.unread}</em>}
                        </small>
                      </button>
                      {speech.shows(hover === s.id) && (
                        <div className="row-speech" data-solid>
                          <SpeechBubble
                            session={s}
                            speech={speech}
                            privacy={privacy}
                            onOpen={() => {
                              if (bubble && !privacy)
                                onReceipt([{ id: bubble.id, version: bubble.version }], 'view');
                              open(bubble?.sessionId ?? s.id);
                            }}
                            onDismiss={() =>
                              bubble &&
                              onReceipt([{ id: bubble.id, version: bubble.version }], 'dismiss')
                            }
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
                {zone.helpers.map((helper) => {
                  const s = byId.get(helper.id)!;
                  const pose = model.view(s.id)!.pose;
                  return (
                    <HelperDesk
                      key={s.id}
                      session={s}
                      parentId={helper.parent}
                      at={{ x: helper.x, y: HELPER_Y }}
                      mood={pose.mood}
                      working={pose.working}
                      news={model.notices.some(
                        (n) => n.sessionId === s.id && !n.seenAt && isInboxNotice(n),
                      )}
                      privacy={privacy}
                      onClick={() => open(s.id)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        {!model.seats.length && (
          <div className="row-empty" data-solid>
            {status ?? '동료들의 기록을 기다리고 있어요.'}
          </div>
        )}
      </div>
      {hiddenLeft.length > 0 && (
        <button
          className={`desk-row-arrow arrow-left ${calling(hiddenLeft) ? 'has-call' : ''}`}
          data-solid
          aria-label={`왼쪽 동료 ${hiddenLeft.length}명 보기`}
          title="이전 책상 · ←"
          onClick={() => page(-1)}
        >
          <ChevronLeft size={22} strokeWidth={2.4} />
          <b>{hiddenLeft.length}</b>
        </button>
      )}
      {hiddenRight.length > 0 && (
        <button
          className={`desk-row-arrow arrow-right ${calling(hiddenRight) ? 'has-call' : ''}`}
          data-solid
          aria-label={`오른쪽 동료 ${hiddenRight.length}명 보기`}
          title="다음 책상 · →"
          onClick={() => page(1)}
        >
          <ChevronRight size={22} strokeWidth={2.4} />
          <b>{hiddenRight.length}</b>
        </button>
      )}
      <div className="desk-row-tools" data-solid>
        <span
          className="desk-row-summary"
          title={`${layout.zones.length}개 구역 · 동료 ${model.seats.length}명`}
        >
          <span className="live-dot" />
          {model.seats.length}명
          {model.counts.attention > 0 && <em>기다려요 {model.counts.attention}</em>}
        </span>
        {lounge > 0 && (
          <span className="desk-row-lounge" title="대기 라운지에서 쉬는 동료">
            <Coffee size={11} />
            {lounge}
          </span>
        )}
        <button
          className="icon-btn"
          aria-label="사무실 펼치기"
          title="큰 사무실 열기"
          onClick={() => api.window('main')}
        >
          <Expand size={14} />
        </button>
        <button
          className="icon-btn"
          aria-label="책상 줄 접기"
          title="펫으로 접기 · Esc"
          onClick={onCollapse}
        >
          <ChevronDown size={16} />
        </button>
        <button
          className="icon-btn"
          aria-label="데스크 펫 숨기기"
          title="숨기기 · 트레이에서 다시 열 수 있어요"
          onClick={() => api.window('hide')}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
