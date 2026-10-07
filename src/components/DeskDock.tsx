import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useOffice } from '../lib/useOffice';
import type { DockMode } from '../shared/types';
import { DeskPet } from './DeskPet';
import { DeskRow } from './DeskRow';

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
  const [demo] = useState(() => new URLSearchParams(location.search).has('demo'));
  const { model, snapshot, error, receipt, veil, patch } = useOffice(demo);
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
      }),
    [],
  );
  useEffect(() => {
    document.body.classList.add('dock-mode');
    return () => document.body.classList.remove('dock-mode');
  }, []);
  useEffect(() => {
    if (mode === 'pet') return;
    const key = (e: KeyboardEvent) => {
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
          status={snapshot ? null : error ? '연결 확인' : '연결 중'}
          onExpand={() => go(expanded)}
          onFloor={() => go('floor')}
        />
      ) : (
        <DeskRow
          variant={mode === 'floor' ? 'floor' : 'office'}
          model={model}
          status={
            snapshot ? null : error ? `연결을 확인해 주세요 · ${error}` : '사무실 문을 여는 중…'
          }
          privacy={privacy}
          reducedMotion={reducedMotion}
          onReceipt={receipt}
          onVeil={veil}
          onPin={(s) => void patch(s.id, { pinned: !s.pinned }).catch(() => {})}
          onCollapse={() => go('pet')}
          onSwitch={() => go(mode === 'floor' ? 'row' : 'floor')}
        />
      )}
    </div>
  );
}
