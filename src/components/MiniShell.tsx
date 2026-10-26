import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SquareTerminal } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import {
  closeMiniShell,
  openMiniShell,
  useMiniShellHost,
  useMiniShellHosted,
  useMiniShellTarget,
} from '../lib/miniShell';
import { canOpenShell, shellFolders, shellLabel } from '../shared/mini-shell';
import type { Session } from '../shared/types';

// xterm.js is loaded only once someone opens a terminal.
const MiniShellPanel = lazy(() => import('./MiniShellPanel'));

/** The window's one mini terminal panel. Hidden content (privacy) closes it: tmux keeps it. */
export function MiniShellDock({
  privacy,
  demo = false,
  scope,
}: {
  privacy: boolean;
  /** The sample office: no real shell is shown, kept attached, or offered. */
  demo?: boolean;
  /** Whose window this is (a card's colleague): another one, or none, closes the panel. */
  scope?: string | null;
}) {
  const target = useMiniShellTarget();
  const off = privacy || demo;
  useMiniShellHost(!demo);
  useEffect(() => {
    if (off) closeMiniShell();
  }, [off]);
  useEffect(() => () => closeMiniShell(), [scope]);
  if (!api.shell || !target || off) return null;
  return (
    <Suspense fallback={null}>
      <MiniShellPanel key={target.name ?? target.id} target={target} />
    </Suspense>
  );
}

/** A colleague's card: a shell in their folder. Desktop and local sessions only. */
export function CardShellButton({
  session,
  privacy,
  demo,
}: {
  session: Session;
  privacy: boolean;
  demo: boolean;
}) {
  const { t } = useI18n();
  const hosted = useMiniShellHosted();
  if (!api.shell || !hosted || demo || !canOpenShell(session)) return null;
  return (
    <button
      className="card-action"
      disabled={privacy}
      title={privacy ? t.shell.openHidden : t.shell.openIn(session.cwd!)}
      onClick={() => openMiniShell({ id: session.id, cwd: session.cwd! })}
    >
      <SquareTerminal size={13} />
      {t.shell.open}
    </button>
  );
}

/** A project zone: a shell in its folder; a zone of several folders asks which one. */
export function ZoneShellButton({
  sessions,
  privacy,
  demo,
}: {
  sessions: Session[];
  privacy: boolean;
  demo: boolean;
}) {
  const { t } = useI18n();
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const pick = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  // Measured once drawn: kept inside the window, opening above the button when below is short.
  useLayoutEffect(() => {
    const el = pick.current;
    if (!menu || !el) return setPlace(null);
    const gap = 8;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(gap, Math.min(menu.left, innerWidth - width - gap));
    const below = innerHeight - menu.bottom - 4 - gap;
    const above = menu.top - 4 - gap;
    const up = height > below && above > below;
    const room = Math.max(80, up ? above : below);
    const shown = Math.min(height, room);
    setPlace({ left, top: up ? menu.top - 4 - shown : menu.bottom + 4, maxHeight: room });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (!(e.target instanceof Element && e.target.closest('.mini-shell-pick'))) setMenu(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setMenu(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [menu]);
  const hosted = useMiniShellHosted();
  const folders = shellFolders(sessions);
  if (!api.shell || !hosted || demo || privacy || !folders.length) return null;
  const only = folders.length === 1 ? folders[0] : null;
  return (
    <>
      <button
        ref={button}
        className="project-summon-button"
        data-solid
        aria-label={only ? t.shell.openIn(shellLabel(only.cwd)) : t.shell.open}
        title={only ? t.shell.openIn(only.cwd) : t.shell.open}
        aria-haspopup={only ? undefined : 'menu'}
        aria-expanded={only ? undefined : !!menu}
        onClick={(e) => {
          e.stopPropagation();
          if (only) openMiniShell(only);
          else setMenu(menu ? null : button.current!.getBoundingClientRect());
        }}
      >
        <SquareTerminal size={13} />
      </button>
      {menu &&
        createPortal(
          <div
            className="mini-shell-menu mini-shell-pick"
            role="menu"
            aria-label={t.shell.pickFolder}
            ref={pick}
            style={place ?? { left: menu.left, top: menu.bottom + 4, visibility: 'hidden' }}
          >
            {folders.map((f) => (
              <button
                key={f.cwd}
                type="button"
                role="menuitem"
                title={f.cwd}
                onClick={() => {
                  setMenu(null);
                  openMiniShell(f);
                }}
              >
                <span>{shellLabel(f.cwd)}</span>
                <small>{f.cwd}</small>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
