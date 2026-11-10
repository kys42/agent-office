import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Plus, Search, X } from 'lucide-react';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useLaunchSupport } from '../lib/useLaunchSupport';
import { useBringBack } from '../lib/useBringBack';
import { dockPopovers, isPopoverTrigger } from '../lib/dockPopovers';
import { DOCK_RECLAIM } from '../lib/useDockPill';
import { isPageHidden, onPageVisibility } from '../lib/visibility';
import type { LaunchEntry } from '../lib/useLaunch';
import { residentLabel, type OfficeModel } from '../shared/office-model';
import { projectColor } from '../shared/office-layout';
import {
  awayList,
  summonChoices,
  summonProjects,
  type AwayRoom,
  type SummonProject,
} from '../shared/dock-plus';
import { LaunchSheet } from './LaunchSheet';
import { Sprite } from './Sprite';

/** What the dock hands its pill and its pet for the ＋ popover. */
export interface DockPlusControls {
  model: OfficeModel;
  privacy: boolean;
  demo: boolean;
  notify: (message: string) => void;
  /** The office's own "bring back to the office" (the big office's lounge and archive use it). */
  onReturn?: (id: string) => unknown;
  /** Room for the popover: the window grows (upward; the pet's also leftward) while it is open. */
  room?: (on: boolean) => Promise<void>;
}

type Tab = 'summon' | 'bring';
// The person's last tab and room, for the next opening (this window's session only).
let lastTab: Tab = 'summon';
let lastRoom: AwayRoom | null = null;

/** The popover's least distance to the window's sides. */
const MARGIN = 6;

/**
 * The dock's ＋: a popover above it with two tabs. 새로 부르기 picks a project and opens its
 * launch sheet (the same sheet as a zone's "+"); 데려오기 lists the lounge and the archive, each
 * row opening that colleague's card and bringing it back to the office with the big office's
 * own call. It stands on `edge` (the pill, the pet's tools) so the pointer never crosses
 * see-through space, and takes turns with the 보기 menu and the numbers' lists.
 */
export function DockPlus({
  controls,
  size = 14,
  edge,
  onOpenCard,
  onOpenChange,
}: {
  /** Absent in the settings preview: then it is a picture. */
  controls?: DockPlusControls;
  size?: number;
  /** The element whose top edge the popover stands on. */
  edge?: RefObject<HTMLElement | null>;
  /** A row was picked: open that colleague's card, near `from`. */
  onOpenCard?: (sessionId: string, from: Element) => void;
  /** The popover opened or closed (the pet hides its bubble behind it). */
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const p = t.dock.plus;
  const id = useId();
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const [tab, setTab] = useState<Tab>(lastTab);
  const [room, setRoom] = useState<AwayRoom>('waiting');
  const [query, setQuery] = useState('');
  const [sheet, setSheet] = useState<Extract<LaunchEntry, { from: 'project' }> | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const roomButton = useRef<HTMLButtonElement>(null);
  const latest = useRef({ controls, onOpenChange });
  latest.current = { controls, onOpenChange };
  const support = useLaunchSupport();

  // The window's room: asked once per opening, given back as the popover closes or goes away.
  const opening = useRef(0);
  const holding = useRef(false);
  const release = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    void latest.current.controls?.room?.(false);
  }, []);
  const close = useCallback(
    (refocus: boolean, keepRoom = false) => {
      opening.current++;
      dockPopovers.closed(id);
      // The room goes before whatever comes next (the IPC keeps this order) — unless a dialog
      // takes over: it claims its own room first, then this one goes (no shrink in between).
      if (keepRoom) setTimeout(release, 0);
      else release();
      setOpen(false);
      setReady(false);
      setPlace(null);
      latest.current.onOpenChange?.(false);
      if (refocus) button.current?.focus();
      // The popover's spot may sit under a still pointer: let the window judge clicks again.
      requestAnimationFrame(() => window.dispatchEvent(new Event(DOCK_RECLAIM)));
    },
    [id, release],
  );
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(
    () => () => {
      dockPopovers.closed(id);
      release();
    },
    [id, release],
  );
  const show = async () => {
    const c = latest.current.controls;
    if (!c) return;
    const token = ++opening.current;
    setOpen(true);
    setQuery('');
    setRoom(lastRoom ?? (awayList(c.model.zones.waiting).length ? 'waiting' : 'archive'));
    // The claim is taken at once; the popover it closes then gives its room back for nothing.
    let grown: Promise<void> | undefined;
    if (c.room && !holding.current) {
      holding.current = true;
      grown = c.room(true);
    }
    dockPopovers.opened(id, () => closeRef.current(false));
    latest.current.onOpenChange?.(true);
    await grown?.catch(() => {});
    if (opening.current === token) setReady(true);
  };

  // Above the button, standing on `edge`, centred on the button, inside the window's sides.
  // Measured from the window's bottom: the window growing upward keeps it in place.
  const measure = useCallback(() => {
    const b = button.current?.getBoundingClientRect();
    const base = edge?.current?.getBoundingClientRect() ?? b;
    const el = pop.current;
    if (!b || !base || !el) return;
    const width = el.offsetWidth;
    const vw = window.innerWidth;
    const left = Math.round(
      Math.min(
        Math.max(MARGIN, b.left + b.width / 2 - width / 2),
        Math.max(MARGIN, vw - width - MARGIN),
      ),
    );
    // Touching the edge, so the pointer never crosses see-through space on its way up.
    setPlace({
      left,
      bottom: Math.round(window.innerHeight - base.top - 2),
      maxHeight: Math.max(0, base.top - MARGIN + 2),
    });
  }, [edge]);
  useLayoutEffect(() => {
    if (open && ready) measure();
  }, [open, ready, measure]);
  // Placed: the current tab takes the focus, as a tab list does.
  const placed = !!place;
  useEffect(() => {
    if (placed)
      pop.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [placed]);
  useEffect(() => {
    if (!open) return;
    // A press elsewhere in the window, the window losing focus or going away closes it.
    const down = (e: PointerEvent) => {
      const at = e.target as Node | null;
      if (at && (pop.current?.contains(at) || button.current?.contains(at))) return;
      if (isPopoverTrigger(at)) return;
      close(false);
    };
    const away = () => close(false);
    const hidden = () => {
      if (isPageHidden()) close(false);
    };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('blur', away);
    window.addEventListener('resize', measure);
    const stopVisibility = onPageVisibility(hidden);
    return () => {
      stopVisibility();
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('blur', away);
      window.removeEventListener('resize', measure);
    };
  }, [open, close, measure]);

  const c = controls;
  const model = c?.model;
  const privacy = c?.privacy ?? false;
  const projects = useMemo(() => (model ? summonProjects(model.zones) : []), [model?.zones]);
  const rooms: Record<AwayRoom, number> = {
    waiting: model ? awayList(model.zones.waiting).length : 0,
    archive: model ? awayList(model.zones.archive).length : 0,
  };
  const rows = model && open ? awayList(model.zones[room], query, privacy) : [];
  const canLaunch = !!support?.supported && !!api.launch && !!api.launchOptions && !!c && !c.demo;
  const { busy, act } = useBringBack(c?.onReturn, list, privacy ? roomButton : search);
  // Turning on privacy must not leave a typed name in the search field.
  useEffect(() => {
    if (privacy) setQuery('');
  }, [privacy]);

  const pickTab = (next: Tab, focus = false) => {
    lastTab = next;
    setTab(next);
    if (focus)
      requestAnimationFrame(() =>
        pop.current?.querySelector<HTMLElement>(`[role="tab"][data-tab="${next}"]`)?.focus(),
      );
  };
  const pickRoom = (next: AwayRoom) => {
    lastRoom = next;
    setRoom(next);
  };
  const summon = (project: SummonProject) => {
    if (!model) return;
    const choices = summonChoices(model.zones, project);
    // The ＋ takes the focus first, so the sheet gives it back there when it closes.
    close(true, true);
    setSheet({
      from: 'project',
      projects: project.folders,
      choices: choices.list,
      hidden: choices.hidden,
    });
  };
  const openCard = (sessionId: string) => {
    const from = button.current;
    if (from) onOpenCard?.(sessionId, from);
    close(false);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // Back to the ＋; the dock folds only on an Esc with nothing open.
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    const field = e.target instanceof HTMLInputElement;
    if (e.key === 'Tab') {
      // Past either end the popover closes, back on the ＋ (it floats far from it in the page).
      const all = [
        ...(pop.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, [tabindex="0"]',
        ) ?? []),
      ].filter((el) => el.tabIndex >= 0);
      const at = document.activeElement;
      if ((!e.shiftKey && at === all.at(-1)) || (e.shiftKey && at === all[0])) {
        e.preventDefault();
        close(true);
      }
      return;
    }
    if (field) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      // The tabs move with the arrows; never the row's pages or the pet's colleague behind.
      e.preventDefault();
      if ((e.target as Element).getAttribute('role') === 'tab')
        pickTab(
          e.key === 'Home' || (e.key !== 'End' && tab === 'bring') ? 'summon' : 'bring',
          true,
        );
    }
  };

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'summon', label: p.tabs.summon },
    { key: 'bring', label: p.tabs.bring, count: rooms.waiting + rooms.archive },
  ];
  const note = (text: string) => <p className="dock-plus-note">{text}</p>;
  const summonPanel = privacy ? (
    note(p.summonPrivate)
  ) : !canLaunch ? (
    note(p.summonUnavailable)
  ) : !projects.length ? (
    note(p.summonNone)
  ) : (
    <>
      <p className="dock-plus-hint">{p.summonHint}</p>
      <ul className="dock-plus-projects">
        {projects.map((project) => (
          <li key={project.key}>
            <button
              type="button"
              aria-label={p.summonIn(project.name)}
              style={{ '--project-color': projectColor(project.key) } as CSSProperties}
              onClick={() => summon(project)}
            >
              <i aria-hidden="true" />
              <span className="dock-plus-words">
                <b>{project.name}</b>
                <small>
                  {p.people(project.count)}
                  {!project.office.length && ` · ${p.away}`}
                </small>
              </span>
              <Plus size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
  const bringPanel = (
    <>
      <div className="dock-plus-rooms" role="group" aria-label={p.rooms}>
        {(['waiting', 'archive'] as const).map((r) => (
          <button
            key={r}
            ref={room === r ? roomButton : undefined}
            type="button"
            aria-pressed={room === r}
            onClick={() => pickRoom(r)}
          >
            {p.room[r]}
            <b>{rooms[r]}</b>
          </button>
        ))}
      </div>
      {!privacy && (
        <label className="dock-plus-search">
          <Search size={13} aria-hidden="true" />
          <input
            ref={search}
            aria-label={p.search}
            placeholder={p.search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button type="button" aria-label={t.roster.clearSearch} onClick={() => setQuery('')}>
              <X size={12} />
            </button>
          )}
        </label>
      )}
      {rows.length ? (
        <ul ref={list} className="dock-plus-list" aria-label={t.office.list.roomLabel[room]}>
          {rows.map((s) => {
            const who = residentLabel(s, privacy);
            const mood = model?.view(s.id)?.pose.mood ?? 'idle';
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className="dock-plus-who"
                  aria-label={t.dock.pet.openCardOf(who.name)}
                  onClick={() => openCard(s.id)}
                >
                  <Sprite session={s} provider={s.provider} mood={mood} size={22} />
                  <span className="dock-plus-words">
                    <b>{who.name}</b>
                    <small>
                      {who.project} · {ago(s.updatedAt)}
                      {room === 'archive' &&
                        ` · ${s.archived ? t.office.archive.byYou : t.office.archive.aged}`}
                    </small>
                  </span>
                </button>
                {c?.onReturn && (
                  <button
                    type="button"
                    className="dock-plus-bring"
                    data-bring-id={s.id}
                    aria-label={p.bringOf(who.name)}
                    aria-disabled={busy.has(s.id) || undefined}
                    data-tip={p.bringTip}
                    onClick={() => act(s.id)}
                  >
                    <ArrowUpRight size={13} aria-hidden="true" />
                    <span>{p.bring}</span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <>
          <ul ref={list} hidden />
          {note(query && !privacy ? p.noMatch : p.emptyRoom[room])}
        </>
      )}
    </>
  );

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`icon-btn dock-plus-button ${open ? 'is-open' : ''}`}
        aria-label={p.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-tip={p.tip}
        data-popover-trigger
        onClick={() => (open ? close(false) : void show())}
      >
        <Plus size={size} />
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            id={id}
            className="dock-plus"
            role="dialog"
            aria-label={p.dialog}
            data-solid
            // Drawn hidden until placed (after the window's room arrives), then where it fits.
            style={place ?? { visibility: 'hidden', left: 0, bottom: 0 }}
            onKeyDown={onKey}
          >
            <div className="dock-plus-tabs" role="tablist" aria-label={p.dialog}>
              {tabs.map((x) => (
                <button
                  key={x.key}
                  type="button"
                  role="tab"
                  id={`${id}-tab-${x.key}`}
                  data-tab={x.key}
                  aria-selected={tab === x.key}
                  aria-controls={`${id}-panel`}
                  tabIndex={tab === x.key ? 0 : -1}
                  onClick={() => pickTab(x.key)}
                >
                  {x.label}
                  {!!x.count && <b>{x.count}</b>}
                </button>
              ))}
            </div>
            <div
              className="dock-plus-panel"
              role="tabpanel"
              id={`${id}-panel`}
              aria-labelledby={`${id}-tab-${tab}`}
            >
              {tab === 'summon' ? summonPanel : bringPanel}
            </div>
          </div>,
          document.body,
        )}
      {sheet && c && (
        <LaunchSheet
          entry={sheet}
          privacy={privacy}
          notify={c.notify}
          onClose={() => setSheet(null)}
          onReturn={c.onReturn}
        />
      )}
    </>
  );
}
