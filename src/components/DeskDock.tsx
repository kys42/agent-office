import { PetAppearanceContext } from './PetAppearanceContext';
import { DeskAppearanceContext } from './DeskAppearanceContext';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useOffice } from '../lib/useOffice';
import { DOCK_RECLAIM } from '../lib/useDockPill';
import { useTerminalSend } from '../lib/useTerminalSend';
import type { DockMode } from '../shared/types';
import { DeskPet } from './DeskPet';
import { DeskRow } from './DeskRow';
import { DockTips } from './DockTips';
import type { DockViewControls, DockViewPick } from './DockViewMenu';
import type { DockPlusControls } from './DockPlus';
import type { DockPeekControls } from './DockPeek';
import { dockViewStep } from '../shared/dock-look';
import { useI18n } from '../lib/i18n';

// `#mini=row`, `#mini=floor&tiny`: the look the main process opened the window with.
const hash = () => new URLSearchParams(location.hash.slice(1));
const initialMode = (): DockMode => {
  const mini = hash().get('mini');
  return mini === 'row' || mini === 'floor' ? mini : 'pet';
};
const TINY_KEY = 'office:dock-tiny';
/** Tiny row/floor: the window's hash when it says so, else the browser preview's last choice. */
function initialTiny(): boolean {
  if (hash().has('tiny')) return true;
  if (api.dock) return false;
  try {
    return localStorage.getItem(TINY_KEY) === '1';
  } catch {
    return false;
  }
}
type Expanded = Exclude<DockMode, 'pet'>;
const EXPAND_KEY = 'office:dock-expand';
/** The person's last unfolded look (office row or floor desks); the pet reopens it. */
function lastExpanded(): Expanded {
  try {
    return localStorage.getItem(EXPAND_KEY) === 'floor' ? 'floor' : 'row';
  } catch {
    return 'row';
  }
}

/**
 * The floating dock window. It reads the same office core as the big office and only
 * decides the presentation: a small pet, or the office laid out as one row of desks.
 */
export function DeskDock() {
  const { t } = useI18n();
  const [demo] = useState(() => new URLSearchParams(location.search).has('demo'));
  // Results and failures (pin, hide, send, refresh) show here instead of failing silently.
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3600);
  }, []);
  const { model, snapshot, error, receipt, veil, pin, reorderSeats, returnToOffice } = useOffice(
    demo,
    notify,
  );
  // Replies from unfolded bubbles; the setting may change in the big office, so re-read it
  // whenever the dock comes back into use.
  const send = useTerminalSend(demo, notify);
  const { reload } = send;
  useEffect(() => {
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);
  const [mode, setMode] = useState<DockMode>(initialMode);
  const [expanded, setExpanded] = useState<Expanded>(lastExpanded);
  const [tiny, setTiny] = useState(initialTiny);
  // Which edge of its window the pet stands at (the main process grows the window the other way).
  const [petSide, setPetSide] = useState<'left' | 'right'>('right');
  useEffect(() => api.onDockSide?.(setPetSide), []);
  const keepTiny = (on: boolean) => {
    setTiny(on);
    // The desktop main process remembers tiny (dock.json); only a browser preview keeps it here.
    if (api.dock) return;
    try {
      localStorage.setItem(TINY_KEY, on ? '1' : '0');
    } catch {
      /* per-viewer convenience only */
    }
  };
  // Remember only looks the person (or the main process) actually switched to — not the
  // initial hash of a reloaded window, which may be stale.
  const remember = (next: DockMode) => {
    if (next === 'pet') return;
    setExpanded(next);
    try {
      localStorage.setItem(EXPAND_KEY, next);
    } catch {
      /* per-viewer convenience only */
    }
  };
  const privacy = snapshot?.preferences.privacy ?? false;
  const reducedMotion = snapshot?.preferences.reducedMotion ?? false;
  // Desktop: the main process owns the window mode (bounds first, then it tells us).
  // A browser preview has no window to resize, so it switches locally.
  const go = (next: DockMode) => {
    if (api.dock) void api.dock(next);
    else {
      remember(next);
      setMode(next);
    }
  };
  // Tiny is the main process's too (it resizes the window); a preview just redraws.
  const shrink = (on: boolean) => {
    if (api.dock) void api.dock(on ? 'tiny-on' : 'tiny-off');
    else keepTiny(on);
  };
  const solid = useRef<boolean | null>(null);
  const arranging = useRef(false);
  const arrange = useCallback((active: boolean, point?: { x: number; y: number }) => {
    arranging.current = active;
    if (!api.dock) return;
    const hit = point && document.elementFromPoint(point.x, point.y);
    const over = active || !!hit?.closest('[data-solid]');
    if (solid.current === over) return;
    solid.current = over;
    void api.dock(over ? 'solid' : 'through');
  }, []);
  useEffect(
    () =>
      api.onDock?.((next, small) => {
        // Every (re)show resets native mouse handling to see-through; forget our last claim.
        solid.current = null;
        remember(next);
        setMode(next);
        if (small !== undefined) keepTiny(small);
        reload();
      }),
    [reload],
  );
  // Room above the desks or the pet: the window grows upward while a dialog or the 보기 menu
  // is open, and shrinks back once neither is. Each holder claims it by name.
  const roomHolders = useRef(new Set<string>());
  const room = useCallback(async (holder: string, on: boolean) => {
    const held = roomHolders.current;
    const before = held.size > 0;
    if (on) held.add(holder);
    else held.delete(holder);
    if (api.dock && before !== held.size > 0) await api.dock(on ? 'room-on' : 'room-off');
  }, []);
  // A dialog (summon, a folder shell's confirm…) needs more than the strip's height, a tiny
  // one's above all: the window grows upward while one is open, the desks staying put. The
  // pet's window grows up and to the left (its ＋ opens the launch sheet too).
  useEffect(() => {
    if (!api.dock) return;
    let open = false;
    const check = () => {
      const now = !!document.querySelector('.modal-backdrop');
      if (now === open) return;
      open = now;
      void room('dialog', now);
    };
    check();
    const watch = new MutationObserver(check);
    watch.observe(document.body, { childList: true, subtree: true });
    return () => {
      watch.disconnect();
      if (open) void room('dialog', false);
    };
  }, [mode, room]);
  // The 보기 menu: a look keeps the tiny setting, the tiny toggle from the pet unfolds the
  // last unfolded look small. Size first, so the new look opens at its own height.
  const pickView = (choice: DockViewPick) => {
    if (choice === 'main') return void api.window('main');
    if (choice === 'settings') return void api.settings?.open();
    const next = dockViewStep({ mode, tiny }, choice, expanded);
    if (next.tiny !== undefined) shrink(next.tiny);
    if (next.mode) go(next.mode);
  };
  const view: DockViewControls = {
    look: { mode, tiny },
    onPick: pickView,
    settings: !!api.settings,
    room: (on) => room('menu', on),
  };
  // 잠깐 숨기기: the desks and the pet step aside, the pill stays. For this look only: changing
  // the look (an Esc folding to the pet too) shows everything again, as does a restart.
  const [peeking, setPeeking] = useState(false);
  useEffect(() => setPeeking(false), [mode, tiny]);
  const peek: DockPeekControls = {
    on: peeking,
    toggle: () => setPeeking((on) => !on),
    off: () => setPeeking(false),
  };
  // The ＋ popover: a new session in a project (the launch sheet), or a colleague brought back
  // from the lounge or the archive with the big office's own call.
  const plus: DockPlusControls = {
    model,
    privacy,
    demo,
    notify,
    onReturn: returnToOffice,
    room: (on) => room('plus', on),
  };
  useEffect(() => {
    document.body.classList.add('dock-mode');
    return () => document.body.classList.remove('dock-mode');
  }, []);
  useEffect(() => {
    if (mode === 'pet') return;
    const key = (e: KeyboardEvent) => {
      // The row folds an open bubble or reply first and marks the key handled.
      if (e.key === 'Escape' && !e.defaultPrevented) go('pet');
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [mode]);
  // Click-through: only drawn things ([data-solid]) take the mouse; the transparent rest of
  // the window lets clicks reach the desktop and the apps behind it.
  useEffect(() => {
    if (!api.dock) return;
    const claim = (over: boolean) => {
      over ||= arranging.current;
      if (over === solid.current) return;
      solid.current = over;
      void api.dock?.(over ? 'solid' : 'through');
    };
    let last: { x: number; y: number } | null = null;
    const move = (e: MouseEvent) => {
      last = { x: e.clientX, y: e.clientY };
      claim(e.target instanceof Element && !!e.target.closest('[data-solid]'));
    };
    // A fast exit can skip the transparent margin; never leave the window holding clicks.
    const leave = () => {
      last = null;
      claim(false);
    };
    // Something solid appeared under a still pointer (the hidden pill came up): judge it again.
    const reclaim = () => {
      if (last) claim(!!document.elementFromPoint(last.x, last.y)?.closest('[data-solid]'));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener(DOCK_RECLAIM, reclaim);
    document.documentElement.addEventListener('mouseleave', leave);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener(DOCK_RECLAIM, reclaim);
      document.documentElement.removeEventListener('mouseleave', leave);
    };
  }, []);
  const content = (
    <div key={mode} className={`desk-dock mode-${mode} ${reducedMotion ? 'reduce-motion' : ''}`}>
      {mode === 'pet' ? (
        <DeskPet
          model={model}
          privacy={privacy}
          onReceipt={receipt}
          status={snapshot ? null : error ? t.dock.status.check : t.dock.status.connecting}
          onExpand={() => go(expanded)}
          onReply={send.sendReply}
          view={view}
          plus={plus}
          peek={peek}
          side={petSide}
          notify={notify}
        />
      ) : (
        <DeskRow
          demo={demo}
          onArrange={arrange}
          onReorder={(ids) => void reorderSeats(ids)}
          onReturn={returnToOffice}
          room={(on) => room('tally', on)}
          variant={mode === 'floor' ? 'floor' : 'office'}
          tiny={tiny}
          view={view}
          plus={plus}
          peek={peek}
          model={model}
          status={snapshot ? null : error ? t.dock.status.error(error) : t.dock.status.opening}
          privacy={privacy}
          reducedMotion={reducedMotion}
          onReceipt={receipt}
          onVeil={(ids, on) => {
            void veil(ids, on);
            notify(on ? t.app.toast.hidden : t.app.toast.shown);
          }}
          onPin={(s) =>
            void pin(s)
              .then((on) => notify(on ? t.dock.pinned : t.app.toast.unpinned))
              .catch((e) => notify((e as Error).message))
          }
          notify={notify}
          onReply={send.sendReply}
        />
      )}
      <DockTips />
      {toast && (
        <div className="dock-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );

  return (
    <PetAppearanceContext.Provider value={snapshot?.preferences.petAppearance}>
      <DeskAppearanceContext.Provider value={snapshot?.preferences.deskAppearance}>
        {content}
      </DeskAppearanceContext.Provider>
    </PetAppearanceContext.Provider>
  );
}
