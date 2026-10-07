import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useOffice } from '../lib/useOffice';
import { useTerminalSend } from '../lib/useTerminalSend';
import type { DockMode } from '../shared/types';
import { DeskPet } from './DeskPet';
import { DeskRow } from './DeskRow';
import { useI18n } from '../lib/i18n';

const initialMode = (): DockMode =>
  location.hash === '#mini=row' ? 'row' : location.hash === '#mini=floor' ? 'floor' : 'pet';
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
  const { model, snapshot, error, receipt, veil, pin, refresh, refreshing } = useOffice(
    demo,
    notify,
  );
  // Replies from unfolded bubbles; the opt-in may change in the big office, so re-read it
  // whenever the dock comes back into use.
  const send = useTerminalSend(demo, notify);
  const { reload } = send;
  useEffect(() => {
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);
  const [mode, setMode] = useState<DockMode>(initialMode);
  const [expanded, setExpanded] = useState<Expanded>(lastExpanded);
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
  const solid = useRef<boolean | null>(null);
  useEffect(
    () =>
      api.onDock?.((next) => {
        // Every (re)show resets native mouse handling to see-through; forget our last claim.
        solid.current = null;
        remember(next);
        setMode(next);
        reload();
      }),
    [reload],
  );
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
      if (over === solid.current) return;
      solid.current = over;
      void api.dock?.(over ? 'solid' : 'through');
    };
    const move = (e: MouseEvent) =>
      claim(e.target instanceof Element && !!e.target.closest('[data-solid]'));
    // A fast exit can skip the transparent margin; never leave the window holding clicks.
    const leave = () => claim(false);
    window.addEventListener('mousemove', move);
    document.documentElement.addEventListener('mouseleave', leave);
    return () => {
      window.removeEventListener('mousemove', move);
      document.documentElement.removeEventListener('mouseleave', leave);
    };
  }, []);
  return (
    <div key={mode} className={`desk-dock mode-${mode} ${reducedMotion ? 'reduce-motion' : ''}`}>
      {mode === 'pet' ? (
        <DeskPet
          model={model}
          privacy={privacy}
          onReceipt={receipt}
          status={snapshot ? null : error ? t.dock.status.check : t.dock.status.connecting}
          onExpand={() => go(expanded)}
          onFloor={() => go('floor')}
          onReply={send.sendReply}
          onRefresh={() => void refresh()}
        />
      ) : (
        <DeskRow
          variant={mode === 'floor' ? 'floor' : 'office'}
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
          onRefresh={() => void refresh()}
          refreshing={refreshing}
          onCollapse={() => go('pet')}
          onSwitch={() => go(mode === 'floor' ? 'row' : 'floor')}
          onReply={send.sendReply}
        />
      )}
      {toast && (
        <div className="dock-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
