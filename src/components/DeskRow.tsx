import { ProjectSummon } from './ProjectSummon';
import { focusName, focusLine } from '../shared/terminal-target';
import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Building2,
  Expand,
  EyeOff,
  Flag,
  GripVertical,
  GitBranch,
  Maximize2,
  Minimize2,
  Pin,
  RotateCw,
  Settings,
  Undo2,
  Terminal,
  X,
} from 'lucide-react';
import { useRowPlacement } from '../lib/useRowPlacement';
import { useDockPill } from '../lib/useDockPill';
import { useDeskReorder } from '../lib/useDeskReorder';
import { api } from '../lib/api';
import { jumpOrCopy } from '../lib/resume';
import { openColleague } from '../lib/dockCard';
import { useSendTargets } from '../lib/useSendTargets';
import { DeskActionButton } from './DeskActionButton';
import { QuickReply } from './QuickReply';
import { targetLine } from './TerminalSend';
import type { ReceiptAction } from '../lib/useOffice';
import {
  MOODS,
  PROVIDERS,
  type NoticeReceipt,
  type ReplySender,
  type Session,
  type TerminalTarget,
} from '../shared/types';
import { branchInfo } from '../shared/branch';
import {
  DESK_FOOT,
  FLOOR_TOP,
  FLOOR_ZONE_GAP,
  HELPER_TOP,
  layoutRow,
  layoutSignature,
  projectColor,
  ROW_TOP,
  STATION_WIDTH,
} from '../shared/office-layout';
import {
  dockHeight,
  FLOOR_SCENE_HEIGHT,
  ROW_SCALE,
  ROW_SCENE_HEIGHT,
  TINY_NAME_ROOM,
  TINY_NAME_TOP,
  TINY_SCENE_HEIGHT,
  TINY_SCALE,
  TINY_TOP,
} from '../shared/dock-geometry';
import { residentLabel, zoneVeilIds, type OfficeModel } from '../shared/office-model';
import { deskSpeech, hopping, shownSpeech, speechDot } from '../shared/speech';
import { deskPapers, focusLevel } from '../shared/presentation';
import { isInboxNotice } from '../shared/notices';
import { Furniture } from './Furniture';
import { Sprite } from './Sprite';
import { SpeechBubble } from './SpeechBubble';
import { HelperDesk, HelperStack } from './HelperDesk';
import { QuotaBadge } from './QuotaBadge';
import { dimsDesk } from '../shared/quota';
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
 * cards under the desks; `floor` stands the desks right on the screen's bottom edge, with a name plate on each desk front and a flag between zones.
 * Tiny (쪼꼬미) draws either look at helper-desk size with only the desks and their status:
 * no bubbles, flags, rugs or plates — a contentless dot says a desk has something new, and a
 * thin bar along each zone's bottom edge moves it (the same saved spots as the full size).
 * Only drawn things are `[data-solid]`; the transparent rest lets clicks through.
 */
export function DeskRow({
  variant = 'office',
  tiny = false,
  onTiny,
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
  demo = false,
  onArrange,
  onReorder,
}: {
  variant?: 'office' | 'floor';
  /** Helper-desk size, status only. */
  tiny?: boolean;
  /** Switch between tiny and the normal size. */
  onTiny?: (on: boolean) => void;
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
  /** Desktop, with Send to terminal on: an unfolded bubble whose session can take a follow-up offers a reply. */
  onReply?: ReplySender;
  /** Short results and failures, shown by the dock. */
  notify: (message: string) => void;
  /** Look at the session records again now (and restart a stopped collector). */
  onRefresh: () => void;
  refreshing?: boolean;
  demo?: boolean;
  onArrange?: (active: boolean, point?: { x: number; y: number }) => void;
  /** Dragging a desk within its zone: the zone's station ids in the new order. */
  onReorder?: (ids: string[]) => void;
}) {
  const { t, locale } = useI18n();
  const floor = variant === 'floor';
  // Station-space rows, matching the big office's station (bench at 134 under the chair).
  // Tiny has no bubbles to make room for: the scene starts just above the heads.
  const top = tiny ? TINY_TOP : floor ? FLOOR_TOP : ROW_TOP;
  const sceneHeight = tiny ? TINY_SCENE_HEIGHT : floor ? FLOOR_SCENE_HEIGHT : ROW_SCENE_HEIGHT;
  const scale = tiny ? TINY_SCALE : ROW_SCALE;
  const benchY = top + 134;
  // Office: helpers beside their colleague's desk, table at desk height. Floor: on the floor.
  const helperY = floor ? top + DESK_FOOT - HELPER_TABLE_FOOT : top + HELPER_TOP;
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
        e.target.closest('.speech-bubble.is-expanded, .helper-stack-list, .speech-request-bubble')
      )
        return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const sessions = model.scene;
  // Hidden colleagues and helpers hidden on their own: all come back from one chip.
  const veiledCount = model.veiled.length + model.veiledHelpers.length;
  const signature = layoutSignature(sessions);
  const { display } = model;
  const baseLayout = useMemo(
    () =>
      layoutRow(sessions, {
        stackAt: display.helperStackAt,
        ...(floor ? { zoneGap: FLOOR_ZONE_GAP } : {}),
      }),
    [signature, floor, locale, display.helperStackAt],
  );
  const placement = useRowPlacement({
    base: baseLayout,
    available: view.width / scale - (LANE_PAD * 2) / scale,
    track,
    storageKey: `office:row-zones:v1:${demo ? 'demo' : 'live'}`,
    onArrange,
    onSaveFailed: () => notify(t.dock.arrange.saveFailed),
    scale,
  });
  const { layout } = placement;
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const pillHintId = useId();
  const pill = useDockPill({
    root: rootRef,
    pill: pillRef,
    onArrange,
    onSaveFailed: () => notify(t.dock.arrange.saveFailed),
    visibility: display.dockPill,
    resetAt: display.dockPillResetAt,
  });
  const reorder = useDeskReorder({
    layout,
    track,
    // Tiny desks are click targets only: no reordering at that size.
    enabled: !!onReorder && !privacy && !tiny,
    onArrange,
    onReorder: (ids) => onReorder?.(ids),
  });
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
  }, [layout.width, scale]);
  /** One screenful at a time, keeping one desk of context. Desks never shrink. */
  const page = (direction: -1 | 1) => {
    const el = track.current;
    if (!el) return;
    const step = Math.max(STATION_WIDTH * scale, el.clientWidth - STATION_WIDTH * scale);
    el.scrollBy({ left: direction * step, behavior: reducedMotion ? 'auto' : 'smooth' });
  };
  // Tiny draws no bubbles or replies: drop what was open, so a hidden reply or unfolded bubble
  // never eats the first Esc there (it folds the dock to the pet, as in the full size) and
  // never reappears unexpectedly on the way back.
  useEffect(() => {
    if (!tiny) return;
    setReplying(null);
    setExpanded(null);
  }, [tiny]);
  // The size toggle hides the button that was pressed: focus moves to its counterpart once the
  // new size is drawn (the desktop answers through the main process, a frame or more later).
  const toggled = useRef(false);
  const tinyButton = useRef<HTMLButtonElement>(null);
  const normalButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    (tiny ? normalButton : tinyButton).current?.focus();
  }, [tiny]);
  const toggleTiny = (on: boolean) => {
    toggled.current = true;
    onTiny?.(on);
  };
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const field =
      e.target instanceof Element && e.target.closest('input, textarea, select') !== null;
    if (e.key === 'Escape' && !e.isComposing && !tiny && (replying || expanded)) {
      // Fold what is open before the dock itself folds (DeskDock skips handled keys).
      e.preventDefault();
      // First Esc leaves the input; a second closes it. Keep the person's draft intact.
      if (field && e.target instanceof HTMLElement) {
        e.target.blur();
        return;
      }
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
  // A colleague's card opens right at its desk (or bubble); its "전체 모드" goes to the office.
  const open = (id: string, anchor?: Element | null, news = false) =>
    openColleague(id, { anchor, news });
  const desk = STATION_WIDTH * scale;
  const stations = layout.zones.flatMap((z) =>
    z.stations.map((st) => ({ id: st.id, x: LANE_PAD + (z.x + st.x) * scale })),
  );
  const hiddenLeft = stations.filter((st) => st.x + desk / 2 < view.left);
  const hiddenRight = stations.filter((st) => st.x + desk / 2 > view.left + view.width);
  // The tiny pill draws the same buttons with smaller icons.
  const icon = tiny ? 12 : 14;
  const calling = (list: typeof stations) =>
    list.some((st) => model.view(st.id)?.group === 'attention');
  return (
    <div
      ref={rootRef}
      className={`desk-row ${floor ? 'desk-floor' : ''} ${tiny ? 'is-tiny' : ''} ${tiny && placement.dragging ? 'is-zone-grabbing' : ''}`}
      style={{ height: dockHeight(floor, tiny) }}
    >
      <div
        className={`desk-row-track ${hiddenLeft.length ? 'fade-left' : ''} ${hiddenRight.length ? 'fade-right' : ''}`}
        ref={track}
      >
        <div
          className="desk-row-lane"
          style={{
            width: layout.width * scale + LANE_PAD * 2,
            height: sceneHeight * scale,
          }}
        >
          <div
            className={`desk-row-scene dynamic-office ${reducedMotion ? 'motion-paused' : ''}`}
            style={
              {
                left: LANE_PAD,
                width: layout.width,
                height: sceneHeight,
                transform: `scale(${scale})`,
                // Tiny name tags size their words in real pixels against this.
                ...(tiny ? { '--tiny-scale': TINY_SCALE } : {}),
              } as CSSProperties
            }
          >
            {layout.zones.map((zone, index) => {
              const zoneName = privacy ? t.desk.project : zone.name;
              const dragHandle = placement.handle(zone.key);
              // Tiny: grabbing any desk (or its name) and sliding it moves the whole zone; a
              // still click opens the card as before.
              const zoneGrab = tiny ? placement.grab(zone.key) : {};
              const opener = (id: string) => (e: MouseEvent) => {
                if (!placement.consumeClick(e)) open(id);
              };
              const veilIds = zoneVeilIds(
                model,
                zone.stations.map((s) => s.id),
              );
              const zoneVeil = veilIds.length > 0 && (
                <VeilButton zone name={zoneName} onVeil={() => onVeil(veilIds, true)} />
              );
              return (
                <div
                  className={`row-zone ${placement.dragging === zone.key ? 'is-arranging' : ''}`}
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
                  {tiny ? (
                    // Tiny has no flags or signs: the desks themselves carry the zone (a drag on
                    // any of them moves it all). For the keys, an unseen stop per zone that rings
                    // the whole zone when focused, with the signs' arrows, Home and End.
                    <button
                      type="button"
                      className="tiny-zone-key"
                      onKeyDown={dragHandle.onKeyDown}
                      aria-label={t.dock.arrange.move(zoneName)}
                      aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End"
                      title={privacy ? t.dock.arrange.hint : `${zone.name}\n${t.dock.arrange.hint}`}
                    />
                  ) : floor ? (
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
                      <i className="zone-flag-pole" data-solid {...dragHandle} aria-hidden="true" />
                      {/* The eye hangs right under the cloth, so the pointer slides onto it. */}
                      <div className="zone-flag-banner" data-solid>
                        <button
                          type="button"
                          className="zone-flag-cloth"
                          data-solid
                          {...dragHandle}
                          aria-label={t.dock.arrange.move(zoneName)}
                          title={t.dock.arrange.hint}
                        >
                          <b>{String(index + 1).padStart(2, '0')}</b>
                          <span>{zoneName}</span>
                        </button>
                        <div className="zone-flag-actions">
                          <ProjectSummon
                            sessions={sessions.filter((s) =>
                              zone.stations.some((station) => station.id === s.id),
                            )}
                            privacy={privacy}
                            notify={notify}
                            demo={demo}
                          />
                          {zoneVeil}
                        </div>
                      </div>
                      <i className="zone-flag-base" data-solid {...dragHandle} aria-hidden="true" />
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
                        <button
                          type="button"
                          className="row-zone-handle"
                          data-solid
                          {...dragHandle}
                          aria-label={t.dock.arrange.move(zoneName)}
                          title={t.dock.arrange.hint}
                        >
                          <span>{String(index + 1).padStart(2, '0')}</span>
                          <b>{zoneName}</b>
                          <small>
                            {t.desk.headcount(zone.stations.length, zone.helpers.length > 0)}
                          </small>
                        </button>
                        <ProjectSummon
                          sessions={sessions.filter((s) =>
                            zone.stations.some((station) => station.id === s.id),
                          )}
                          privacy={privacy}
                          notify={notify}
                          demo={demo}
                        />
                        {zoneVeil}
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
                      shared={bench.shared}
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
                    // An unfolded or replying bubble (a peek too) stays without the cursor.
                    const pointing =
                      (pointed === s.id || expanded === s.id || replying?.station === s.id) &&
                      closed !== s.id;
                    // Tiny shows no bubble, so it never works out which one would show.
                    const shown = tiny
                      ? undefined
                      : shownSpeech(
                          s,
                          model.notices,
                          model.bubbleHours,
                          model.now,
                          speech,
                          hover === s.id || expanded === s.id || replying?.station === s.id,
                          pointing,
                          // Like tiny's dot, a read reply leaves; the peek can keep it up again.
                          { hideRead: true },
                        );
                    const bubble = shown?.speech.bubble;
                    const focus = focusLevel(s, model.now);
                    const replyId = bubble?.sessionId ?? s.id;
                    const replyTarget = targets[replyId];
                    const canReply = !!onReply && !privacy && !!replyTarget?.canSend;
                    const deskTarget = targets[s.id];
                    const dark = !!v.quota && dimsDesk(s, pose.working);
                    // Tiny: no words, just a dot in the bubble's colour (it pops once per notice).
                    const dot = tiny
                      ? speechDot(s, speech, { finals: display.tinyFinalDot })
                      : undefined;
                    return (
                      <div
                        className={`desk-station row-station status-${s.status} group-${v.group} ${reorder.marker(s.id)} ${pose.working ? 'station-working' : 'station-resting'} focus-level-${focus} ${dark ? 'lights-out' : ''}`}
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
                          // Tiny's dot is drawn only: its meaning goes into the name (call, reply, error).
                          aria-label={
                            tiny
                              ? t.desk.row.tinyDesk(t.desk.openWork(label.name), dot?.tone)
                              : t.desk.openWork(label.name)
                          }
                          // Tiny has no name plates: the name on hover instead (never in privacy).
                          title={
                            tiny
                              ? privacy
                                ? undefined
                                : label.name
                              : onReorder && !privacy && !s.remote
                                ? `${label.detail}\n${t.desk.row.reorderHint}`
                                : label.detail
                          }
                          {...(s.remote ? {} : reorder.handle(s.id, zone.key))}
                          {...zoneGrab}
                          onClick={(e) => {
                            if (!reorder.consumeClick(e) && !placement.consumeClick(e)) open(s.id);
                          }}
                        >
                          {/* The same effects as the full size, shrunk with the scene. */}
                          <FocusEffects level={focus} />
                          <Sprite session={s} provider={s.provider} mood={pose.mood} size={80} />
                          {pose.posture === 'dozing' && <span className="doze-mark">z z</span>}
                        </button>
                        {dot && (
                          <i
                            key={`${dot.tone}:${dot.id}`}
                            className={`tiny-dot tone-${dot.tone}`}
                            aria-hidden="true"
                          />
                        )}
                        {tiny && display.tinyNames && (
                          // A small name over the desk's front, drawn in real pixels (not ×0.41).
                          // Not a second tab stop: the desk button already says the name;
                          // a click here opens the card like the desk does.
                          <span
                            className="tiny-name"
                            data-solid
                            aria-hidden="true"
                            title={privacy ? undefined : label.name}
                            style={{ top: TINY_NAME_TOP, height: TINY_NAME_ROOM }}
                            {...zoneGrab}
                            onClick={opener(s.id)}
                          >
                            <span>
                              {privacy ? (PROVIDERS[s.provider]?.short ?? label.name) : label.name}
                            </span>
                          </span>
                        )}
                        {!tiny && !v.needsPerson && (
                          <VeilButton
                            name={label.name}
                            onVeil={() => onVeil(s.resident?.sessionIds ?? [s.id], true)}
                          />
                        )}
                        {!tiny && (
                          <PinButton name={label.name} pinned={s.pinned} onPin={() => onPin(s)} />
                        )}
                        {!tiny && deskTarget?.canFocus && api.jump && (
                          <DeskActionButton
                            className="jump-button"
                            label={t.terminal.jumpToTerminal(label.name)}
                            title={t.terminal.jumpTo(focusName(deskTarget))}
                            hint={t.terminal.jumpHint(focusLine(deskTarget, privacy))}
                            icon={<Terminal size={13} strokeWidth={2.4} />}
                            onClick={() => void jump(s.id)}
                          />
                        )}
                        <Furniture kind="equipment" />
                        {/* Tiny keeps every desk effect (scaled with the scene, z-ordered under
                            its dot and name); only the quota's words are too small to read. */}
                        {!tiny && v.quota && <QuotaBadge quota={v.quota} />}
                        <PaperPile count={deskPapers(s, model.now)} level={focus} />
                        {arrival && (
                          <ArrivalBurst key={arrival.id} receivedAt={arrival.receivedAt} />
                        )}
                        {pose.working && <WorkingBeacon level={focus} />}
                        {tiny ? null : floor ? (
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
                        {!tiny && shown && (
                          <div className="row-speech" data-solid>
                            <SpeechBubble
                              session={s}
                              speech={shown.speech}
                              peek={shown.peek}
                              quote={pointing}
                              privacy={privacy}
                              expanded={expanded === s.id}
                              onExpandedChange={(on) => setExpanded(on ? s.id : null)}
                              onViewed={() => {
                                if (bubble && !privacy)
                                  onReceipt([{ id: bubble.id, version: bubble.version }], 'view');
                              }}
                              onPopup={(el) => void open(bubble?.sessionId ?? s.id, el)}
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
                              onKeep={
                                shown.keep && bubble
                                  ? () =>
                                      onReceipt(
                                        [{ id: bubble.id, version: bubble.version }],
                                        'unread',
                                      )
                                  : undefined
                              }
                              onDismiss={() => {
                                setClosed(s.id);
                                if (bubble)
                                  onReceipt(
                                    [{ id: bubble.id, version: bubble.version }],
                                    'dismiss',
                                  );
                              }}
                            />
                          </div>
                        )}
                        {!tiny && onReply && !privacy && replying?.station === s.id && (
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
                            onJump={api.jump ? () => void jump(replying.id) : undefined}
                            onSend={async (text, replaceDraft, allowPartialDraft) => {
                              const result = await onReply(
                                replying.id,
                                text,
                                replaceDraft,
                                allowPartialDraft,
                              );
                              if (result.status === 'sent') markSent(replying.id);
                              return result;
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
                          canVeil={(h) => !tiny && !model.view(h.id)?.needsPerson}
                          direct={tiny}
                          grip={zoneGrab}
                          swallowClick={placement.consumeClick}
                          onVeil={(h) => onVeil([h.id], true)}
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
                        grip={zoneGrab}
                        onClick={opener(s.id)}
                        onVeil={
                          tiny || model.view(s.id)?.needsPerson
                            ? undefined
                            : () => onVeil([s.id], true)
                        }
                      />
                    );
                  })}
                </div>
              );
            })}
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
      {/* The dock's controls: a pill floating over the bottom of the desks (the desks still
          stand on the screen's edge), subdued until hovered (or solid, or hidden until the
          pointer nears it — the person's choice) and slid anywhere along it so it can be
          parked in an empty spot. Tiny keeps the main ones as small icons: how many,
          back to normal, the office, fold to the pet, settings and hide. */}
      <div
        ref={pillRef}
        className={`dock-pill pill-${display.dockPill} ${pill.dragging ? 'is-dragging' : ''} ${pill.autoHide && pill.revealed ? 'is-revealed' : ''}`}
        // Hidden (`hover` visibility) it lets clicks through: only a revealed pill is solid.
        data-solid={pill.revealed ? '' : undefined}
        role="group"
        aria-label={t.desk.row.pill}
        style={{ left: pill.left }}
        {...pill.handlers}
      >
        <button
          type="button"
          className="dock-pill-grip"
          data-pill-grip
          aria-label={t.desk.row.pillMove}
          aria-describedby={pillHintId}
          aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End"
          title={t.desk.row.pillHint}
          onKeyDown={pill.onGripKeyDown}
        >
          <GripVertical size={tiny ? 10 : 12} />
        </button>
        <span id={pillHintId} className="sr-only">
          {t.desk.row.pillHint}
        </span>
        {!tiny && placement.customized && (
          <button
            className="icon-btn"
            aria-label={t.dock.arrange.reset}
            title={t.dock.arrange.reset}
            onClick={placement.reset}
          >
            <Undo2 size={14} />
          </button>
        )}
        <span
          className="desk-row-summary"
          title={t.desk.row.summaryTitle(layout.zones.length, model.seats.length)}
        >
          <span className="live-dot" />
          {tiny ? model.seats.length : t.desk.row.seats(model.seats.length)}
          {model.counts.attention > 0 &&
            (tiny ? (
              // A bare number on screen; assistive tech hears who it counts.
              <em title={t.desk.row.tinyWaiting(model.counts.attention)}>
                <span aria-hidden="true">{model.counts.attention}</span>
                <span className="sr-only">{t.desk.row.tinyWaiting(model.counts.attention)}</span>
              </em>
            ) : (
              <em>{t.desk.row.waiting(model.counts.attention)}</em>
            ))}
        </span>
        {!tiny && (
          <>
            {veiledCount > 0 && (
              <button
                className="desk-row-veiled"
                title={t.desk.row.veiledTitle(veiledCount)}
                onClick={() => onVeil(model.hiddenSessionIds, false)}
              >
                <EyeOff size={11} />
                {t.desk.row.veiled(veiledCount)}
              </button>
            )}
            <i className="dock-pill-sep" aria-hidden="true" />
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
            {onTiny && (
              <button
                ref={tinyButton}
                className="icon-btn"
                aria-label={t.desk.row.tiny}
                title={t.desk.row.tinyTitle}
                onClick={() => toggleTiny(true)}
              >
                <Minimize2 size={14} />
              </button>
            )}
          </>
        )}
        {tiny && onTiny && (
          <button
            ref={normalButton}
            className="icon-btn"
            aria-label={t.desk.row.normal}
            title={t.desk.row.normalTitle}
            onClick={() => toggleTiny(false)}
          >
            <Maximize2 size={12} />
          </button>
        )}
        <button
          className="icon-btn"
          aria-label={t.desk.row.expand}
          title={t.desk.row.expandTitle}
          onClick={() => api.window('main')}
        >
          <Expand size={icon} />
        </button>
        <button
          className="icon-btn"
          aria-label={t.desk.row.collapse}
          title={t.desk.row.collapseTitle}
          onClick={onCollapse}
        >
          <ChevronDown size={tiny ? 14 : 16} />
        </button>
        {/* Only the desktop has a settings window; a browser preview has nowhere to open it. */}
        {api.settings && (
          <button
            className="icon-btn"
            aria-label={t.desk.row.settings}
            title={t.desk.row.settingsTitle}
            onClick={() => void api.settings?.open()}
          >
            <Settings size={icon} />
          </button>
        )}
        <button
          className="icon-btn"
          aria-label={t.desk.row.hide}
          title={t.desk.row.hideTitle}
          onClick={() => api.window('hide')}
        >
          <X size={icon} />
        </button>
      </div>
    </div>
  );
}
