import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { TRIAGE_LABELS } from '../shared/triage';
import { MOODS, type PetTallyGroup } from '../shared/types';
import { residentLabel, tallyCounts, tallyMembers, type OfficeModel } from '../shared/office-model';
import { DOCK_RECLAIM } from '../lib/useDockPill';
import { dockPopovers, isPopoverTrigger } from '../lib/dockPopovers';
import { useI18n } from '../lib/i18n';
import { Sprite } from './Sprite';

/** A pointer only passing over a number does not open its list: it opens after this stay. */
const LIST_DELAY = 250;
/** Leaving a number for its list (or back) must not close it on the way. */
const LIST_GRACE = 200;
/** The floating list's least distance to the window's sides. */
const MARGIN = 6;

/**
 * The numbers pill (#324), the same on the pet and on the row's, floor's and tiny's pill: a
 * coloured dot and a number per counted group. Hovering a number (after a short stay; a click or
 * Enter at once) lists who it counts; a name opens that colleague's card (`onOpen`). Esc closes
 * the list first (the dock folds only on an Esc with nothing open), focus or the pointer leaving
 * closes it too. It only draws: the counting is `tallyCounts`/`tallyMembers`, shared by all.
 *
 * `pet`: the list opens inside the pet's pill bar, right above the pill. `dock`: the pill sits on
 * the window's bottom edge (a tiny strip is short), so the list floats above it in the page,
 * after the window has grown upward (`room`, released as the list closes).
 */
export function TallyPill({
  model,
  groups,
  privacy,
  onOpen,
  onPicked,
  onListed,
  variant = 'pet',
  compact = false,
  room,
  edge,
}: {
  model: OfficeModel;
  /** The groups to count (the person's choice), in any order. */
  groups: readonly PetTallyGroup[];
  privacy: boolean;
  /** A name in the list was picked: open that colleague's card, near `from`. */
  onOpen: (sessionId: string, from: Element) => void;
  /** After `onOpen`: the pet turns to that colleague. */
  onPicked?: (sessionId: string) => void;
  /** A list opened or closed (the pet hides its peeking bubble behind it). */
  onListed?: (open: boolean) => void;
  variant?: 'pet' | 'dock';
  /** The tiny pill: smaller dots and numbers. */
  compact?: boolean;
  /** The desktop dock: grow the window upward while the list is open. */
  room?: (on: boolean) => Promise<void>;
  /** The element whose top edge the floating list stands on (the dock's pill). */
  edge?: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const d = t.dock.pet;
  const tally = tallyCounts(model, groups);
  const words = tally.map((g) => `${TRIAGE_LABELS[g.group]} ${g.count}`).join(' · ');
  const [listed, setListed] = useState<PetTallyGroup | null>(null);
  const listedRef = useRef(listed);
  listedRef.current = listed;
  // Where the floating list stands (measured once the window's room is there).
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const members = listed ? tallyMembers(model, listed) : [];
  const listId = useId();
  const latest = useRef({ onListed, room });
  latest.current = { onListed, room };
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wrap = useRef<HTMLDivElement>(null);
  const listEl = useRef<HTMLDivElement>(null);
  const floating = variant === 'dock';

  // The window's room: asked once per opening, released as the list closes or goes away.
  const holding = useRef(false);
  const opening = useRef(0);
  const [ready, setReady] = useState(true);
  const release = useCallback(() => {
    opening.current++;
    if (!holding.current) return;
    holding.current = false;
    void latest.current.room?.(false);
  }, []);
  const put = (group: PetTallyGroup | null) => {
    clearTimeout(timer.current);
    if (group === listed) return;
    if (group && !listed) {
      const grow = latest.current.room;
      // A number at 0 (nobody in any counted group) has no list to make room for.
      if (grow && !holding.current && tallyMembers(model, group).length > 0) {
        holding.current = true;
        const token = ++opening.current;
        setReady(false);
        const before = window.innerHeight;
        void grow(true)
          .catch(() => {})
          .then(() => {
            if (opening.current !== token) return;
            // The answer can beat the window's resize here: measure once the room is there.
            if (window.innerHeight !== before) return setReady(true);
            const done = () => {
              window.removeEventListener('resize', done);
              clearTimeout(fallback);
              if (opening.current === token) setReady(true);
            };
            window.addEventListener('resize', done);
            const fallback = setTimeout(done, 250);
          });
      }
    }
    // Its turn among the dock's popovers (the 보기 menu, the ＋): after its room's claim, so the
    // one it closes gives the room back without a shrink in between.
    if (group && !listed) dockPopovers.opened(listId, () => putRef.current(null));
    if (!group) {
      dockPopovers.closed(listId);
      // The room goes before anything the closing click does next (the IPC keeps this order).
      release();
      setReady(true);
      setPlace(null);
      // The list's spot may sit under a still pointer: let the window judge clicks again.
      if (floating) requestAnimationFrame(() => window.dispatchEvent(new Event(DOCK_RECLAIM)));
    }
    setListed(group);
    latest.current.onListed?.(group !== null);
  };
  const putRef = useRef(put);
  putRef.current = put;
  const soon = (group: PetTallyGroup) => {
    clearTimeout(timer.current);
    // A hover never opens a list over another open popover (a click still does).
    if (dockPopovers.busy(listId)) return;
    timer.current = setTimeout(() => putRef.current(group), LIST_DELAY);
  };
  const later = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => putRef.current(null), LIST_GRACE);
  };
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      dockPopovers.closed(listId);
      release();
      if (listedRef.current) latest.current.onListed?.(false);
    },
    [release],
  );

  // The floating list: above the pill, centred on the numbers, inside the window's sides.
  // Measured from the window's bottom, so the window growing upward keeps it in place.
  const measure = useCallback(() => {
    const base = (edge?.current ?? wrap.current)?.getBoundingClientRect();
    const nums = wrap.current?.getBoundingClientRect();
    const el = listEl.current;
    if (!base || !nums || !el) return;
    const width = el.offsetWidth;
    const vw = window.innerWidth;
    const left = Math.round(
      Math.min(
        Math.max(MARGIN, nums.left + nums.width / 2 - width / 2),
        Math.max(MARGIN, vw - width - MARGIN),
      ),
    );
    // Touching the pill, so the pointer never crosses see-through space on its way up.
    const bottom = Math.round(window.innerHeight - base.top - 2);
    setPlace({ left, bottom, maxHeight: Math.max(0, base.top - MARGIN + 2) });
  }, [edge]);
  const shown = !!listed && members.length > 0;
  // Everyone it listed moved on (or it was opened at 0): close it, so the room it holds, the
  // number's expanded state and a list popping back later without a pointer all go with it.
  useEffect(() => {
    if (listed && members.length === 0) putRef.current(null);
  }, [listed, members.length]);
  useLayoutEffect(() => {
    if (floating && shown && ready) measure();
  }, [floating, shown, ready, listed, members.length, measure]);
  useEffect(() => {
    if (!floating || !shown) return;
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [floating, shown, measure]);

  if (!tally.length) return null;
  const list = shown && (
    <div
      ref={listEl}
      className={`tally-list tally-${listed} ${floating ? 'is-floating' : 'dock-pet-list'} ${compact ? 'is-compact' : ''}`}
      id={listId}
      role="group"
      aria-label={`${TRIAGE_LABELS[listed]} ${members.length}`}
      data-solid={floating ? '' : undefined}
      style={floating ? (place ?? { visibility: 'hidden', left: 0, bottom: 0 }) : undefined}
      onMouseEnter={() => put(listed)}
      onMouseLeave={later}
      // Not the dock pill's drag or reset: the list only floats over it (a portal).
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <b>
        <i />
        {TRIAGE_LABELS[listed]} {members.length}
      </b>
      {members.map((v) => {
        const name = residentLabel(v.session, privacy);
        return (
          <button
            key={v.session.id}
            type="button"
            aria-label={d.openCardOf(name.name)}
            onClick={(e) => {
              onOpen(v.session.id, e.currentTarget);
              onPicked?.(v.session.id);
              put(null);
            }}
          >
            <Sprite
              session={v.session}
              provider={v.session.provider}
              mood={v.pose.mood}
              size={22}
            />
            <span className="tally-list-name pet-list-name">{name.name}</span>
            <small>{MOODS[v.session.status].label}</small>
          </button>
        );
      })}
    </div>
  );
  return (
    <div
      ref={wrap}
      className={`tally-anchor ${floating ? 'is-dock' : ''} ${compact ? 'is-compact' : ''}`}
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null;
        // Onto another popover's button: that one closes the list as it opens.
        if (isPopoverTrigger(to)) return;
        if (!e.currentTarget.contains(to) && !listEl.current?.contains(to)) put(null);
      }}
      onKeyDown={(e) => {
        if (!listed) return;
        const number = wrap.current?.querySelector<HTMLElement>(
          `.tally-pill > button.tally-${listed}`,
        );
        if (e.key === 'Tab' && number) {
          // The list is not next to its number in the page (above it, or floating): Tab goes
          // from the open number into the names and back; past the last name the list closes.
          const names = [...(listEl.current?.querySelectorAll<HTMLElement>('button') ?? [])];
          const at = document.activeElement;
          const to =
            !e.shiftKey && at === number
              ? names[0]
              : e.shiftKey && at === names[0]
                ? number
                : !e.shiftKey && at === names.at(-1)
                  ? number
                  : undefined;
          if (!to) return;
          e.preventDefault();
          if (at === names.at(-1) && !e.shiftKey) put(null);
          to.focus();
          return;
        }
        if (e.key !== 'Escape') return;
        // Close the list first; the dock folds only on an Esc with nothing open.
        e.preventDefault();
        e.stopPropagation();
        put(null);
        number?.focus();
      }}
    >
      {floating && list && createPortal(list, document.body)}
      <div
        className={`tally-pill ${floating ? '' : 'dock-pet-pill dock-pet-tally'}`}
        role="group"
        aria-label={words}
      >
        {tally.map((g) => (
          <button
            key={g.group}
            type="button"
            className={listed === g.group ? `tally-${g.group} is-listed` : `tally-${g.group}`}
            title={`${TRIAGE_LABELS[g.group]} ${g.count}`}
            aria-label={d.listOf(TRIAGE_LABELS[g.group], g.count)}
            aria-expanded={listed === g.group}
            aria-controls={listed === g.group && shown ? listId : undefined}
            data-popover-trigger
            onMouseEnter={() => (listed ? put(g.group) : soon(g.group))}
            onMouseLeave={later}
            // Opens (a hover may already have): Esc, leaving or another number closes it.
            onClick={() => put(g.group)}
          >
            <i />
            {g.count}
          </button>
        ))}
      </div>
      {/* After the numbers (it is drawn above them): Shift+Tab from a number leaves the pill
          instead of landing in the names, and the blur closes the list. */}
      {!floating && list}
    </div>
  );
}

/** The tally's words, for a label that reads the pill aloud (the pet's own button). */
export const tallyWords = (model: OfficeModel, groups: readonly PetTallyGroup[]) =>
  tallyCounts(model, groups)
    .map((g) => `${TRIAGE_LABELS[g.group]} ${g.count}`)
    .join(' · ');
