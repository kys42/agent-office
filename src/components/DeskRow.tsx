import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, Coffee, Expand, GitBranch, X } from 'lucide-react';
import { api } from '../lib/api';
import type { ReceiptAction } from '../lib/useOffice';
import { MOODS, type NoticeReceipt } from '../shared/types';
import { branchInfo } from '../shared/branch';
import { layoutRow, layoutSignature, projectColor, ROW_TOP } from '../shared/office-layout';
import { ROW_SCENE_HEIGHT, rowScale } from '../shared/dock-geometry';
import { residentLabel, type OfficeModel } from '../shared/office-model';
import { stationSpeech } from '../shared/speech';
import { isInboxNotice } from '../shared/notices';
import { Furniture } from './Furniture';
import { Sprite } from './Sprite';
import { SpeechBubble } from './SpeechBubble';
import { HelperDesk } from './HelperDesk';

/** Width kept free for the end caps (title on the left, tools on the right). */
const CAPS_W = 420;
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
  const [width, setWidth] = useState(window.innerWidth);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
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
  const scale = rowScale(layout.width, width - CAPS_W);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const lounge = model.zones.waiting.filter((s) => !s.attachedTo).length;
  const open = (id: string) => api.window('main', id);
  return (
    <div className="desk-row">
      <div className="desk-row-cap desk-row-title" data-solid>
        <button
          className="desk-row-pet"
          aria-label="펫으로 접기"
          title="펫으로 접기"
          onClick={onCollapse}
        >
          <Sprite
            provider={model.lead?.session.provider ?? 'claude'}
            mood={model.lead?.pose.mood ?? 'idle'}
            size={36}
          />
        </button>
        <span>
          <b>
            <span className="live-dot" />
            우리 사무실
          </b>
          <small>
            {layout.zones.length}개 구역 · 동료 {model.seats.length}명
            {model.counts.attention ? ` · 기다려요 ${model.counts.attention}` : ''}
            {model.counts.results ? ` · 새 소식 ${model.counts.results}` : ''}
          </small>
        </span>
      </div>
      <div className="desk-row-track" ref={track}>
        <div
          className="desk-row-lane"
          style={{ width: layout.width * scale, height: ROW_SCENE_HEIGHT * scale }}
        >
          <div
            className={`desk-row-scene dynamic-office ${reducedMotion ? 'motion-paused' : ''}`}
            style={{ width: layout.width, height: ROW_SCENE_HEIGHT, transform: `scale(${scale})` }}
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
      <div className="desk-row-cap desk-row-tools" data-solid>
        {lounge > 0 && (
          <span className="desk-row-lounge" title="대기 라운지에서 쉬는 동료">
            <Coffee size={12} />
            라운지 {lounge}
          </span>
        )}
        <button
          className="icon-btn"
          aria-label="사무실 펼치기"
          title="큰 사무실 열기"
          onClick={() => api.window('main')}
        >
          <Expand size={15} />
        </button>
        <button
          className="icon-btn"
          aria-label="책상 줄 접기"
          title="펫으로 접기"
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
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
