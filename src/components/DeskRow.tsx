import { useEffect, useEffectEvent, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Building2,
  Coffee,
  Expand,
  EyeOff,
  Flag,
  GitBranch,
  PanelRightOpen,
  Pin,
  RotateCw,
  Terminal,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { jumpOrCopy } from '../lib/resume';
import { openColleague } from '../lib/dockCard';
import { useSendTargets } from '../lib/useSendTargets';
import { DeskActionButton } from './DeskActionButton';
import { QuickReply } from './QuickReply';
import { targetLine } from './TerminalSend';
import type { ReceiptAction } from '../lib/useOffice';
import { MOODS, type NoticeReceipt, type Session, type TerminalTarget } from '../shared/types';
import { branchInfo } from '../shared/branch';
import {
  DESK_FOOT,
  FLOOR_TOP,
  FLOOR_ZONE_GAP,
  layoutRow,
  layoutSignature,
  projectColor,
  ROW_TOP,
  STATION_WIDTH,
} from '../shared/office-layout';
import {
  FLOOR_HEIGHT,
  FLOOR_SCENE_HEIGHT,
  ROW_HEIGHT,
  ROW_SCALE,
  ROW_SCENE_HEIGHT,
} from '../shared/dock-geometry';
import { residentLabel, type OfficeModel } from '../shared/office-model';
import { deskSpeech, hopping, shownSpeech } from '../shared/speech';
import { deskPapers, focusLevel } from '../shared/presentation';
import { isInboxNotice } from '../shared/notices';
import { Furniture } from './Furniture';
import { Sprite } from './Sprite';
import { SpeechBubble } from './SpeechBubble';
import { HelperDesk, HelperStack } from './HelperDesk';
import { VeilButton } from './VeilButton';
import { PinButton } from './PinButton';
import { ArrivalBurst, FocusEffects, PaperPile, WorkingBeacon } from './DeskEffects';
import { useI18n } from '../lib/i18n';

/** Breathing room before the first and after the last zone (the row is edge to edge). */
const LANE_PAD = 48;
/** A helper desk's table bottom, from the top of its 68px box (.helper-table: top 32 + 14). */
const HELPER_TABLE_FOOT = 46;

/**
 * The office as one line along the screen edge: the same project zones, shared benches,
 * helper desks and speech bubbles as the big office, drawn with its own furniture.
 * Two looks share everything but the ground: `office` lays each zone on a rug with name
 * cards under the desks; `floor` stands the desks right on the screen's bottom edge, with a
 * name plate on each desk front and a flag between zones.
 * Only drawn things are `[data-solid]`; the transparent rest lets clicks through.
 */
export function DeskRow({
  variant = 'office',
  model,
  status,
  privacy,
  reducedMotion,
  onReceipt,
  onVeil,
  onPin,
  onCollapse,
  onSwitch,
  onReply,
  notify,
  onRefresh,
  refreshing = false,
}: {
  variant?: 'office' | 'floor';
  model: OfficeModel;
  status: string | null;
  privacy: boolean;
  reducedMotion: boolean;
  onReceipt: (receipts: NoticeReceipt[], action: ReceiptAction) => void;
  onVeil: (ids: string[], on: boolean) => void;
  onPin: (s: Session) => void;
  onCollapse: () => void;
  /** Switch between the office row and the floor desks. */
  onSwitch: () => void;
  /** Desktop opt-in: an unfolded bubble whose session can take a follow-up offers a reply. */
  onReply?: (sessionId: string, text: string) => Promise<void>;
  /** Short results and failures, shown by the dock. */
  notify: (message: string) => void;
  /** Look at the session records again now (and restart a stopped collector). */
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  const { t, locale } = useI18n();
  const floor = variant === 'floor';
  // Station-space rows, matching the big office's station (bench at 134 under the chair).
  const top = floor ? FLOOR_TOP : ROW_TOP;
  const sceneHeight = floor ? FLOOR_SCENE_HEIGHT : ROW_SCENE_HEIGHT;
  const benchY = top + 134;
  // Office: helpers beside the bench on the rug. Floor: their table stands on the floor.
  const helperY = floor ? top + DESK_FOOT - HELPER_TABLE_FOOT : top + 128;
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  // A desk whose bubble was just closed doesn't peek it back until the cursor leaves.
  const [closed, setClosed] = useState<string | null>(null);
  // The dock is see-through: a peek starts only on something drawn (pet, plate, buttons),
  // not when the cursor merely crosses a desk's transparent box on its way elsewhere.
  const [pointed, setPointed] = useState<string | null>(null);
  // Clicking a bubble unfolds it in place; a reply opens under it when the session can take one.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [replying, setReplying] = useState<{
    station: string;
    id: string;
    target: TerminalTarget;
  } | null>(null);

  const [view, setView] = useState({ left: 0, width: 0, scroll: 0 });
  // A mouse wheel scrolls the row sideways when there are more desks than fit.
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      // An unfolded bubble scrolls its own text.
      // Unfolded bubbles and a helper list scroll themselves.
      if (
        e.target instanceof Element &&
        e.target.closest('.speech-bubble.is-expanded, .helper-stack-list')
      )
        return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const sessions = model.scene;
  const signature = layoutSignature(sessions);
  const layout = useMemo(
    () => layoutRow(sessions, floor ? { zoneGap: FLOOR_ZONE_GAP } : {}),
    [signature, floor, locale],
  );
  // Track what is in view, so each arrow knows who is hidden on its side.
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      // Boxes may reach below the scene (desk glow, 238px stations on the floor version);
      // focus must never lift the strip off the screen's edge.
      if (el.scrollTop) el.scrollTop = 0;
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
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const field =
      e.target instanceof Element && e.target.closest('input, textarea, select') !== null;
    if (e.key === 'Escape' && !e.isComposing && (replying || expanded)) {
      // Fold what is open before the dock itself folds (DeskDock skips handled keys).
      e.preventDefault();
      if (field && e.target instanceof HTMLElement) e.target.blur();
      if (replying) setReplying(null);
      else setExpanded(null);
      return;
    }
    if (field) return;
    if (e.key === 'ArrowLeft') page(-1);
    if (e.key === 'ArrowRight') page(1);
  });
  // Registered once, on mount, so it stays ahead of DeskDock's Esc listener on the window
  // (children's effects run before their parent's, and the dock remounts the row whenever it
  // registers its own). Re-adding it per render would put it last and let Esc fold the dock.
  useEffect(() => {
    const key = (e: KeyboardEvent) => onKey(e);
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  // Who can be reached from here: desks (go to terminal) and the sessions their bubbles speak for.
  const primary = sessions.filter((s) => !s.attachedTo);
  // Each desk's speech, once per change of what it is made of (not per hover or pointer move).
  const speeches = useMemo(
    () =>
      new Map(
        sessions
          .filter((s) => !s.attachedTo)
          .map((s) => [s.id, deskSpeech(s, model.notices, model.bubbleHours, model.now)]),
      ),
    [sessions, model.notices, model.bubbleHours, model.now],
  );
  const speaking = primary.map((s) => speeches.get(s.id)!.bubble?.sessionId ?? s.id);
  const { targets, markSent } = useSendTargets(
    privacy ? [] : [...primary.map((s) => s.id), ...speaking],
    {
      enabled: !privacy,
      stamp: Math.max(0, ...primary.map((s) => s.updatedAt)),
      pollBusy: false,
    },
  );
  const jump = async (id: string) => {
    try {
      await jumpOrCopy(id, notify);
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const lounge = model.zones.waiting.filter((s) => !s.attachedTo).length;
  // A colleague's card opens right at its desk (or bubble); its "전체 모드" goes to the office.
  const open = (id: string, anchor?: Element | null, news = false) =>
    openColleague(id, { anchor, news });
  const desk = STATION_WIDTH * ROW_SCALE;
  const stations = layout.zones.flatMap((z) =>
    z.stations.map((st) => ({ id: st.id, x: LANE_PAD + (z.x + st.x) * ROW_SCALE })),
  );
  const hiddenLeft = stations.filter((st) => st.x + desk / 2 < view.left);
  const hiddenRight = stations.filter((st) => st.x + desk / 2 > view.left + view.width);
  const calling = (list: typeof stations) =>
    list.some((st) => model.view(st.id)?.group === 'attention');
  return (
    <div
      className={`desk-row ${floor ? 'desk-floor' : ''}`}
      style={{ height: floor ? FLOOR_HEIGHT : ROW_HEIGHT }}
    >
      <div
        className={`desk-row-track ${hiddenLeft.length ? 'fade-left' : ''} ${hiddenRight.length ? 'fade-right' : ''}`}
        ref={track}
      >
        <div
          className="desk-row-lane"
          style={{
            width: layout.width * ROW_SCALE + LANE_PAD * 2,
            height: sceneHeight * ROW_SCALE,
          }}
        >
          <div
            className={`desk-row-scene dynamic-office ${reducedMotion ? 'motion-paused' : ''}`}
            style={{
              left: LANE_PAD,
              width: layout.width,
              height: sceneHeight,
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
                {floor ? (
                  // A flag between zones: the pole stands on the floor, the cloth names the zone.
                  // Only the pole, cloth and base take the mouse; the box around them lets clicks
                  // through like the rest of the strip. The flag stands on the desks' floor line.
                  <div
                    className={`zone-flag ${zone.custom ? 'custom-area' : ''}`}
                    style={{
                      left: -FLOOR_ZONE_GAP / 2,
                      bottom: FLOOR_SCENE_HEIGHT - (FLOOR_TOP + DESK_FOOT),
                    }}
                    title={
                      privacy
                        ? undefined
                        : `${zone.name} · ${t.desk.headcount(zone.stations.length, zone.helpers.length > 0)}${zone.custom ? ` · ${t.desk.customZone(zone.custom.join(', '))}` : ''}`
                    }
                  >
                    <i className="zone-flag-pole" data-solid />
                    <span className="zone-flag-cloth" data-solid>
                      <b>{String(index + 1).padStart(2, '0')}</b>
                      <span>{privacy ? t.desk.project : zone.name}</span>
                    </span>
                    <i className="zone-flag-base" data-solid />
                  </div>
                ) : (
                  <>
                    {/* The rug starts at chair height so heads and bubbles float over the desktop. */}
                    <div
                      className="project-area row-zone-floor"
                      data-solid
                      style={{ top: top + 96 }}
                    />
                    <div
                      className={`project-floor-mark row-zone-mark ${zone.custom ? 'custom-area' : ''}`}
                      data-solid
                      title={
                        privacy
                          ? undefined
                          : zone.custom
                            ? `${zone.name} · ${t.desk.customZone(zone.custom.join(', '))}`
                            : zone.name
                      }
                    >
                      <span>{String(index + 1).padStart(2, '0')}</span>
                      <b>{privacy ? t.desk.project : zone.name}</b>
                      <small>
                        {t.desk.headcount(zone.stations.length, zone.helpers.length > 0)}
                      </small>
                    </div>
                  </>
                )}
                {floor &&
                  zone.benches.map((bench, i) => (
                    <i
                      className="floor-shadow"
                      key={`shadow:${bench.key}:${i}`}
                      style={{
                        left: bench.x - 6,
                        width: bench.width + 12,
                        top: top + DESK_FOOT - 6,
                      }}
                    />
                  ))}
                {zone.benches.map((bench, i) => (
                  <Furniture
                    kind="desk"
                    key={`${bench.key}:${i}`}
                    shared={bench.members.length > 1}
                    assetKey={privacy ? undefined : bench.key}
                    style={{ left: bench.x, top: benchY, width: bench.width }}
                  />
                ))}
                {zone.stations.map((station) => {
                  const s = byId.get(station.id)!;
                  const v = model.view(s.id)!;
                  const pose = v.pose;
                  const label = residentLabel(s, privacy);
                  const branch = branchInfo(s);
                  // A just-arrived request plays on the desk and speaks first.
                  const speech = speeches.get(s.id)!;
                  const { arrival, hop } = speech;
                  // Pointing at a desk shows its bubble — or the last thing it said, if closed.
                  const shown = shownSpeech(
                    s,
                    model.notices,
                    model.bubbleHours,
                    model.now,
                    speech,
                    hover === s.id || expanded === s.id || replying?.station === s.id,
                    // An unfolded or replying bubble (a peek too) stays without the cursor.
                    (pointed === s.id || expanded === s.id || replying?.station === s.id) &&
                      closed !== s.id,
                  );
                  const bubble = shown?.speech.bubble;
                  const focus = focusLevel(s, model.now);
                  const replyId = bubble?.sessionId ?? s.id;
                  const replyTarget = targets[replyId];
                  const canReply = !!onReply && !privacy && !!replyTarget?.canSend;
                  const deskTarget = targets[s.id];
                  return (
                    <div
                      className={`desk-station row-station status-${s.status} group-${v.group} ${pose.working ? 'station-working' : 'station-resting'} focus-level-${focus}`}
                      key={s.id}
                      data-station-id={s.id}
                      style={{ transform: `translate(${station.x}px, ${top}px)` }}
                      onMouseEnter={() => setHover(s.id)}
                      onMouseOver={(e) => {
                        if (e.target instanceof Element && e.target.closest('[data-solid]'))
                          setPointed(s.id);
                      }}
                      onMouseLeave={() => {
                        setHover((h) => (h === s.id ? null : h));
                        setPointed((p) => (p === s.id ? null : p));
                        setClosed((c) => (c === s.id ? null : c));
                      }}
                    >
                      <i className="desk-glow" aria-hidden="true" />
                      <Furniture kind="chair" />
                      <div className="pet-shadow" />
                      <button
                        className={`office-pet pose-${hop ? 'still' : pose.posture} ${hopping(speech) ? 'work-arrival' : ''}`}
                        data-solid
                        data-session-id={s.id}
                        data-seat={s.officeSeat}
                        aria-label={t.desk.openWork(label.name)}
                        title={label.detail}
                        onClick={() => open(s.id)}
                      >
                        <FocusEffects level={focus} />
                        <Sprite session={s} provider={s.provider} mood={pose.mood} size={80} />
                        {pose.posture === 'dozing' && <span className="doze-mark">z z</span>}
                      </button>
                      {!v.needsPerson && (
                        <VeilButton
                          name={label.name}
                          onVeil={() => onVeil(s.resident?.sessionIds ?? [s.id], true)}
                        />
                      )}
                      <PinButton name={label.name} pinned={s.pinned} onPin={() => onPin(s)} />
                      <DeskActionButton
                        className="card-button"
                        label={t.desk.row.openCard(label.name)}
                        title={t.desk.row.cardTitle}
                        hint={t.desk.row.cardHint}
                        icon={<PanelRightOpen size={13} strokeWidth={2.4} />}
                        onClick={(el) => void open(s.id, el)}
                      />
                      {deskTarget?.canFocus && api.jump && (
                        <DeskActionButton
                          className="jump-button"
                          label={t.terminal.jumpToTerminal(label.name)}
                          title={t.terminal.jumpTo(deskTarget.kind === 'orca' ? 'Orca' : 'tmux')}
                          hint={t.terminal.jumpHint(targetLine(deskTarget, privacy))}
                          icon={<Terminal size={13} strokeWidth={2.4} />}
                          onClick={() => void jump(s.id)}
                        />
                      )}
                      <Furniture kind="equipment" />
                      <PaperPile count={deskPapers(s, model.now)} level={focus} />
                      {arrival && <ArrivalBurst key={arrival.id} receivedAt={arrival.receivedAt} />}
                      {pose.working && <WorkingBeacon level={focus} />}
                      {floor ? (
                        // A name plate on the desk front instead of a card on the rug.
                        <button
                          className="floor-plate"
                          data-solid
                          title={
                            privacy
                              ? undefined
                              : `${label.name} · ${
                                  pose.working && s.resident && s.resident.activeCount > 1
                                    ? t.desk.runningTasks(s.resident.activeCount)
                                    : MOODS[s.status].label
                                }`
                          }
                          onClick={() => open(s.id)}
                        >
                          <i style={{ background: MOODS[s.status].color }} />
                          <span>{label.name}</span>
                          {s.pinned && <Pin size={8} />}
                          {speech.unread > 0 && <em>{speech.unread}</em>}
                        </button>
                      ) : (
                        <>
                          <button
                            className={`desk-branch branch-${branch.kind}`}
                            data-solid
                            title={privacy ? undefined : `${branch.label} · ${branch.detail}`}
                            onClick={() => open(s.id)}
                          >
                            <GitBranch size={9} />
                            <span>{privacy ? t.desk.hidden : branch.label}</span>
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
                              {s.pinned && <Pin size={9} />}
                            </strong>
                            <small>
                              <span>
                                {pose.working
                                  ? s.resident && s.resident.activeCount > 1
                                    ? t.desk.runningTasks(s.resident.activeCount)
                                    : t.desk.working
                                  : MOODS[s.status].label}
                              </span>
                              {speech.unread > 0 && <em>{t.desk.unread(speech.unread)}</em>}
                            </small>
                          </button>
                        </>
                      )}
                      {shown && (
                        <div className="row-speech" data-solid>
                          <SpeechBubble
                            session={s}
                            speech={shown.speech}
                            peek={shown.peek}
                            privacy={privacy}
                            expanded={expanded === s.id}
                            onExpandedChange={(on) => setExpanded(on ? s.id : null)}
                            onOpen={() => {
                              // Opening a bubble reads it in place; the card is one hover away.
                              if (bubble && !privacy && expanded !== s.id)
                                onReceipt([{ id: bubble.id, version: bubble.version }], 'view');
                              setExpanded(expanded === s.id ? null : s.id);
                            }}
                            reply={
                              canReply
                                ? {
                                    title: t.terminal.replyTitle(targetLine(replyTarget!, false)),
                                    open: replying?.station === s.id,
                                    onClick: () =>
                                      setReplying(
                                        replying?.station === s.id
                                          ? null
                                          : { station: s.id, id: replyId, target: replyTarget! },
                                      ),
                                  }
                                : undefined
                            }
                            onDismiss={() => {
                              setClosed(s.id);
                              if (bubble)
                                onReceipt([{ id: bubble.id, version: bubble.version }], 'dismiss');
                            }}
                          />
                        </div>
                      )}
                      {onReply && !privacy && replying?.station === s.id && (
                        <QuickReply
                          key={replying.id}
                          target={
                            targets[replying.id] ?? {
                              ...replying.target,
                              status: 'gone',
                              canSend: false,
                            }
                          }
                          name={label.name}
                          onClose={() => setReplying(null)}
                          onSend={async (text) => {
                            await onReply(replying.id, text);
                            markSent(replying.id);
                          }}
                        />
                      )}
                    </div>
                  );
                })}
                {floor &&
                  zone.helpers.map((helper) => (
                    <i
                      className="floor-shadow"
                      key={`shadow:${helper.id}`}
                      style={{ left: helper.x + 2, width: 64, top: top + DESK_FOOT - 6 }}
                    />
                  ))}
                {zone.helpers.map((helper) => {
                  const hasNews = (h: Session) =>
                    model.notices.some(
                      (n) => n.sessionId === h.id && !n.seenAt && isInboxNotice(n),
                    );
                  if (helper.stack)
                    return (
                      <HelperStack
                        key={`stack:${helper.parent}`}
                        members={helper.stack.map((id) => byId.get(id)!)}
                        parentId={helper.parent}
                        at={{ x: helper.x, y: helperY }}
                        pose={(h) => model.view(h.id)!.pose}
                        news={hasNews}
                        privacy={privacy}
                        onOpen={open}
                      />
                    );
                  const s = byId.get(helper.id)!;
                  const pose = model.view(s.id)!.pose;
                  return (
                    <HelperDesk
                      key={s.id}
                      session={s}
                      parentId={helper.parent}
                      at={{ x: helper.x, y: helperY }}
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
            {status ?? t.desk.row.empty}
          </div>
        )}
      </div>
      {hiddenLeft.length > 0 && (
        <button
          className={`desk-row-arrow arrow-left ${calling(hiddenLeft) ? 'has-call' : ''}`}
          data-solid
          aria-label={t.desk.row.left(hiddenLeft.length)}
          title={t.desk.row.leftTitle}
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
          aria-label={t.desk.row.right(hiddenRight.length)}
          title={t.desk.row.rightTitle}
          onClick={() => page(1)}
        >
          <ChevronRight size={22} strokeWidth={2.4} />
          <b>{hiddenRight.length}</b>
        </button>
      )}
      <div className="desk-row-tools" data-solid>
        <span
          className="desk-row-summary"
          title={t.desk.row.summaryTitle(layout.zones.length, model.seats.length)}
        >
          <span className="live-dot" />
          {t.desk.row.seats(model.seats.length)}
          {model.counts.attention > 0 && <em>{t.desk.row.waiting(model.counts.attention)}</em>}
        </span>
        {model.veiled.length > 0 && (
          <button
            className="desk-row-veiled"
            title={t.desk.row.veiledTitle(model.veiled.length)}
            onClick={() => onVeil(model.hiddenSessionIds, false)}
          >
            <EyeOff size={11} />
            {t.desk.row.veiled(model.veiled.length)}
          </button>
        )}
        {lounge > 0 && (
          <span className="desk-row-lounge" title={t.desk.row.lounge}>
            <Coffee size={11} />
            {lounge}
          </span>
        )}
        <button
          className={`icon-btn ${refreshing ? 'is-busy' : ''}`}
          aria-label={t.desk.row.refresh}
          title={t.desk.row.refreshTitle}
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RotateCw size={14} />
        </button>
        <button
          className="icon-btn"
          aria-label={floor ? t.desk.row.toRow : t.desk.row.toFloor}
          title={floor ? t.desk.row.toRowTitle : t.desk.row.toFloorTitle}
          onClick={onSwitch}
        >
          {floor ? <Building2 size={14} /> : <Flag size={14} />}
        </button>
        <button
          className="icon-btn"
          aria-label={t.desk.row.expand}
          title={t.desk.row.expandTitle}
          onClick={() => api.window('main')}
        >
          <Expand size={14} />
        </button>
        <button
          className="icon-btn"
          aria-label={t.desk.row.collapse}
          title={t.desk.row.collapseTitle}
          onClick={onCollapse}
        >
          <ChevronDown size={16} />
        </button>
        <button
          className="icon-btn"
          aria-label={t.desk.row.hide}
          title={t.desk.row.hideTitle}
          onClick={() => api.window('hide')}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
